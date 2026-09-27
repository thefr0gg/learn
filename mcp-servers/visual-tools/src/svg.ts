/**
 * SVG authoring loop for the svg-maker subagent — three MCP tools that share
 * one process-scoped source file:
 *
 *   write_svg   — write the full SVG source to the managed file
 *   edit_svg    — exact-match old_text→new_text on that file
 *   render_svg  — render whatever is in the file → PNG, returned inline; with
 *                 `save_as`, also publish it into <cwd>/viz
 *
 * Ported from the Pi extensions/visual-tools/tools/svg_tools.ts. Rendering
 * shells out to ImageMagick's `magick` first (more reliably present on
 * Windows), falling back to rsvg-convert (librsvg — better system-font
 * handling, common on macOS/Linux) if `magick` is absent. Both are system
 * binaries; no node render deps.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	applyEdit,
	existsSync,
	join,
	mkdirSync,
	publish,
	readFileSync,
	run,
	type Session,
	type RunResult,
	snippetAround,
	writeBody,
	writeFileSync,
} from "./common.js";

const GROUP = "svg";
const BODY_FILE = "diagram.svg";
const RENDER_TIMEOUT_MS = 60_000;

let session: Session | null = null;

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Render an SVG file to PNG via magick, falling back to rsvg-convert. */
async function renderSvg(
	svgPath: string,
	outPath: string,
	workDir: string,
): Promise<{ ok: true; res: RunResult } | { ok: false; res: RunResult }> {
	// -density 192 (~2x of 96dpi) for a crisp raster.
	const magick = await run("magick", ["-density", "192", "-background", "white", svgPath, outPath], {
		cwd: workDir,
		timeoutMs: RENDER_TIMEOUT_MS,
	});
	if (magick.code === 0 && existsSync(outPath)) return { ok: true, res: magick };
	// Fallback: rsvg-convert renders at the SVG's intrinsic size; -z 2 doubles it for crispness.
	const rsvg = await run("rsvg-convert", ["-z", "2", svgPath, "-o", outPath], {
		cwd: workDir,
		timeoutMs: RENDER_TIMEOUT_MS,
	});
	if (rsvg.code === 0 && existsSync(outPath)) return { ok: true, res: rsvg };
	return { ok: false, res: magick.code !== null ? magick : rsvg };
}

export function registerSvgTools(server: McpServer): void {
	server.registerTool(
		"write_svg",
		{
			title: "Write SVG",
			description:
				"Write the FULL SVG source to the managed file (your first draft or a " +
				"complete rewrite). You do NOT name the file — edit_svg and render_svg " +
				"act on the same one.\n\n" +
				"`source` is a complete `<svg ...>…</svg>` document with an explicit " +
				"width/height (or viewBox), readable font sizes, and a light or " +
				"transparent background. Writing does NOT render — call render_svg when " +
				"ready. For a small fix, prefer edit_svg over rewriting.",
			inputSchema: {
				source: z.string().describe("The complete SVG document, from `<svg` to `</svg>`."),
			},
		},
		async ({ source }) => {
			const trimmed = source.trim();
			if (!trimmed) throw new Error("`write_svg` requires a non-empty `source`.");
			if (!trimmed.includes("<svg")) throw new Error("`write_svg`: source must be a complete <svg>…</svg> document.");
			session = writeBody(GROUP, BODY_FILE, trimmed);
			const lines = trimmed.split("\n").length;
			return {
				content: [
					{ type: "text", text: `Wrote ${lines}-line SVG source.\nCall render_svg to render it, or edit_svg to tweak it.` },
				],
			};
		},
	);

	server.registerTool(
		"edit_svg",
		{
			title: "Edit SVG",
			description:
				"Make a single exact-match replacement in the managed SVG source — the " +
				"same contract as Claude Code's built-in Edit tool, locked to the one " +
				"managed file. `old_text` must appear EXACTLY ONCE (include surrounding " +
				"context for uniqueness); on 0 or >1 matches the call fails and nothing " +
				"changes. Call write_svg first. Editing does NOT render.",
			inputSchema: {
				old_text: z.string().describe("Exact substring of the current source to replace (must match once)."),
				new_text: z.string().describe("Replacement text for `old_text`."),
			},
		},
		async ({ old_text, new_text }) => {
			if (!session || !existsSync(session.bodyPath)) {
				throw new Error("edit_svg: no source yet — call write_svg first.");
			}
			const current = readFileSync(session.bodyPath, "utf8");
			const { updated, index } = applyEdit(current, old_text, new_text);
			writeFileSync(session.bodyPath, updated, "utf8");
			return {
				content: [
					{
						type: "text",
						text: "Applied edit. Updated region:\n```\n" + snippetAround(updated, index) + "\n```\nCall render_svg to see it.",
					},
				],
			};
		},
	);

	server.registerTool(
		"render_svg",
		{
			title: "Render SVG",
			description:
				"Render the CURRENT managed SVG source to a PNG and return it inline so you " +
				"can SEE the picture and iterate. You do NOT pass the source here — it comes " +
				"from the managed file; call write_svg first.\n\n" +
				"Iterate freely with no `save_as` (preview only). When the picture is " +
				"correct and clean, call once more with `save_as` set to a short kebab-case " +
				"topic slug: that publishes the PNG into <cwd>/viz with a unique filename " +
				"and returns the filename to embed. On a render error this returns the " +
				"error text instead of an image — fix with edit_svg and re-render.",
			inputSchema: {
				save_as: z
					.string()
					.optional()
					.describe(
						"Short kebab-case topic slug (e.g. 'number-line'). When set, the " +
							"rendered PNG is published to <cwd>/viz as viz-<slug>-<timestamp>.png " +
							"and the filename is returned. Omit for a preview-only render.",
					),
			},
		},
		async ({ save_as }) => {
			if (!session || !existsSync(session.bodyPath)) {
				throw new Error("render_svg: no source yet — call write_svg first.");
			}
			const { workDir, bodyPath } = session;
			mkdirSync(workDir, { recursive: true });

			const outPath = join(workDir, `render-${Date.now()}.png`);
			const { ok, res } = await renderSvg(bodyPath, outPath, workDir);

			if (!ok) {
				const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n");
				const note = res.timedOut ? "SVG render timed out.\n\n" : "";
				return {
					content: [
						{
							type: "text",
							text: `${note}SVG render FAILED — no image produced (tried magick then rsvg-convert). Fix the source with edit_svg and call render_svg again.\n\nError:\n${detail}`,
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
					text: `Published to viz/.\nfilename: ${filename}\npath: ${path}\n\nLOOK at the picture below to confirm the geometry is correct before returning it.`,
				});
				content.push({ type: "image", data, mimeType: "image/png" });
				return { content };
			}

			content.push({
				type: "text",
				text: "Preview render (not yet saved). LOOK: are coordinates, angles, directions, and proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with `save_as` to publish.",
			});
			content.push({ type: "image", data, mimeType: "image/png" });
			return { content };
		},
	);
}
