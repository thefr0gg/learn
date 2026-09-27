/**
 * Mermaid authoring loop for the mermaid-maker subagent — three MCP tools
 * that share one process-scoped source file:
 *
 *   write_mermaid   — write the full Mermaid source to the managed file
 *   edit_mermaid    — exact-match old_text→new_text on that file
 *   render_mermaid  — render whatever is in the file → PNG, returned inline;
 *                     with `save_as`, also publish it into <cwd>/viz
 *
 * Ported from the Pi extensions/visual-tools/tools/mermaid_tools.ts. Rendering
 * shells out to the installed @mermaid-js/mermaid-cli (`mmdc`) with a
 * puppeteer config pointing at an installed Chrome, so no Chromium download is
 * needed. Module-level session state persists across this server process's
 * tool calls for the lifetime of the Claude Code session.
 */

import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	applyEdit,
	dirname,
	existsSync,
	findChrome,
	join,
	mkdirSync,
	publish,
	readFileSync,
	run,
	type Session,
	snippetAround,
	writeBody,
	writeFileSync,
} from "./common.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(SRC_DIR);
const MMDC_BIN = join(PACKAGE_DIR, "node_modules", ".bin", process.platform === "win32" ? "mmdc.cmd" : "mmdc");
const GROUP = "mermaid";
const BODY_FILE = "diagram.mmd";
const RENDER_TIMEOUT_MS = 120_000;

let session: Session | null = null;

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function registerMermaidTools(server: McpServer): void {
	server.registerTool(
		"write_mermaid",
		{
			title: "Write Mermaid",
			description:
				"Write the FULL Mermaid source to the managed file (your first draft or a " +
				"complete rewrite). You do NOT name the file — edit_mermaid and " +
				"render_mermaid act on the same one.\n\n" +
				"`source` is a complete Mermaid diagram, e.g. a `graph TD` / `graph LR` " +
				"flow, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, " +
				"`mindmap`, or `timeline`. Writing does NOT render — call render_mermaid " +
				"when ready. For a small fix, prefer edit_mermaid over rewriting.",
			inputSchema: {
				source: z.string().describe("The complete Mermaid diagram source (starts with the diagram type, e.g. `graph TD`)."),
			},
		},
		async ({ source }) => {
			const trimmed = source.trim();
			if (!trimmed) throw new Error("`write_mermaid` requires a non-empty `source`.");
			session = writeBody(GROUP, BODY_FILE, trimmed);
			const lines = trimmed.split("\n").length;
			return {
				content: [
					{
						type: "text",
						text: `Wrote ${lines}-line Mermaid source.\nCall render_mermaid to render it, or edit_mermaid to tweak it.`,
					},
				],
			};
		},
	);

	server.registerTool(
		"edit_mermaid",
		{
			title: "Edit Mermaid",
			description:
				"Make a single exact-match replacement in the managed Mermaid source — " +
				"the same contract as Claude Code's built-in Edit tool, locked to the one " +
				"managed file. `old_text` must appear EXACTLY ONCE (include surrounding " +
				"context for uniqueness); on 0 or >1 matches the call fails and nothing " +
				"changes. Call write_mermaid first. Editing does NOT render.",
			inputSchema: {
				old_text: z.string().describe("Exact substring of the current source to replace (must match once)."),
				new_text: z.string().describe("Replacement text for `old_text`."),
			},
		},
		async ({ old_text, new_text }) => {
			if (!session || !existsSync(session.bodyPath)) {
				throw new Error("edit_mermaid: no source yet — call write_mermaid first.");
			}
			const current = readFileSync(session.bodyPath, "utf8");
			const { updated, index } = applyEdit(current, old_text, new_text);
			writeFileSync(session.bodyPath, updated, "utf8");
			return {
				content: [
					{
						type: "text",
						text:
							"Applied edit. Updated region:\n```\n" +
							snippetAround(updated, index) +
							"\n```\nCall render_mermaid to see it.",
					},
				],
			};
		},
	);

	server.registerTool(
		"render_mermaid",
		{
			title: "Render Mermaid",
			description:
				"Render the CURRENT managed Mermaid source to a PNG and return it inline so " +
				"you can SEE the diagram and iterate. You do NOT pass the source here — it " +
				"comes from the managed file; call write_mermaid first.\n\n" +
				"Iterate freely with no `save_as` (preview only). When the diagram is " +
				"correct and clean, call once more with `save_as` set to a short kebab-case " +
				"topic slug: that publishes the PNG into <cwd>/viz with a unique filename " +
				"and returns the filename to embed. On a render error this returns the " +
				"error text instead of an image — fix with edit_mermaid and re-render.",
			inputSchema: {
				save_as: z
					.string()
					.optional()
					.describe(
						"Short kebab-case topic slug (e.g. 'internet-packets'). When set, the " +
							"rendered PNG is published to <cwd>/viz as viz-<slug>-<timestamp>.png " +
							"and the filename is returned. Omit for a preview-only render.",
					),
			},
		},
		async ({ save_as }) => {
			if (!session || !existsSync(session.bodyPath)) {
				throw new Error("render_mermaid: no source yet — call write_mermaid first.");
			}
			const { workDir, bodyPath } = session;
			mkdirSync(workDir, { recursive: true });

			const chrome = findChrome();
			const cfgPath = join(workDir, "puppeteer.json");
			writeFileSync(
				cfgPath,
				JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }),
				"utf8",
			);

			const outPath = join(workDir, `render-${Date.now()}.png`);
			const res = await run(
				MMDC_BIN,
				["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"],
				{ cwd: workDir, timeoutMs: RENDER_TIMEOUT_MS, env: { PUPPETEER_SKIP_DOWNLOAD: "1" } },
			);

			if (res.code !== 0 || !existsSync(outPath)) {
				const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n");
				const note = res.timedOut ? "mmdc timed out.\n\n" : "";
				return {
					content: [
						{
							type: "text",
							text: `${note}Mermaid render FAILED — no image produced. Fix the source with edit_mermaid and call render_mermaid again.\n\nError:\n${detail}`,
						},
					],
					isError: true,
				};
			}

			const data = readFileSync(outPath).toString("base64");
			const content: ContentBlock[] = [];

			if (save_as) {
				const { filename, path } = publish(outPath, save_as);
				content.push({
					type: "text",
					text: `Published to viz/.\nfilename: ${filename}\npath: ${path}\n\nLOOK at the diagram below to confirm it is correct before returning it.`,
				});
				content.push({ type: "image", data, mimeType: "image/png" });
				return { content };
			}

			content.push({
				type: "text",
				text: "Preview render (not yet saved). LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with `save_as` to publish.",
			});
			content.push({ type: "image", data, mimeType: "image/png" });
			return { content };
		},
	);
}
