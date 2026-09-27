#!/usr/bin/env node
/**
 * md-log — mirror the teaching session to a markdown file for comfortable
 * reading (e.g. in Obsidian), reimplementing the Pi extensions/md-log.ts
 * extension on top of Claude Code's hook model.
 *
 * Pi's version hooked into JS events (session_start/message_end/tool_call/
 * tool_result) inside the pi process itself. Claude Code only offers
 * shell-command hooks fed a JSON payload on stdin, so this is a real
 * reimplementation rather than a port:
 *
 *   - Two slash commands (.claude/commands/md-log.md, md-unlog.md) write/
 *     clear a state file (.claude/.md-log-target) recording the linked
 *     markdown file's path. Unlike Pi's session_start backfill, linking here
 *     does NOT backfill prior turns — logging starts from the point you run
 *     /md-log onward. This is a documented simplification.
 *   - A `Stop` hook (fires once per finished assistant turn) appends any new
 *     user prompts and assistant prose since the last append.
 *   - A `PostToolUse` hook matched on the learn-quiz-ask MCP server's
 *     `grade_quiz` tool appends a Q&A block the moment a quiz is graded,
 *     approximating Pi's "write question on tool_call, append answer on
 *     tool_result" ordering (Claude Code has no matching pre/post pair for
 *     MCP tool calls, so the question and its graded answer are logged
 *     together, after grading, rather than the question appearing live
 *     before the user answers).
 *
 * Both hooks share ONE offset (.claude/.md-log-offset — a transcript line
 * count) so content is never logged twice regardless of which hook consumes
 * it first.
 *
 * Usage: node .claude/hooks/md-log.mjs <link|unlink|stop|grade> [path]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = dirname(HOOKS_DIR);
const TARGET_FILE = join(CLAUDE_DIR, ".md-log-target");
const OFFSET_FILE = join(CLAUDE_DIR, ".md-log-offset");

const QA_TOOL_SUFFIX = "__grade_quiz";
const ASK_TOOL_NAME = "AskUserQuestion";

// ---- state -----------------------------------------------------------------

function getTarget() {
	if (!existsSync(TARGET_FILE)) return null;
	const raw = readFileSync(TARGET_FILE, "utf8").trim();
	return raw.length > 0 ? raw : null;
}

function setTarget(path) {
	writeFileSync(TARGET_FILE, path, "utf8");
}

function clearTarget() {
	try {
		rmSync(TARGET_FILE);
	} catch {
		// Already gone.
	}
	try {
		rmSync(OFFSET_FILE);
	} catch {
		// Already gone.
	}
}

function getOffset() {
	if (!existsSync(OFFSET_FILE)) return null; // null = "not yet initialized"
	const raw = readFileSync(OFFSET_FILE, "utf8").trim();
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : null;
}

function setOffset(n) {
	writeFileSync(OFFSET_FILE, String(n), "utf8");
}

// ---- transcript reading -----------------------------------------------------

/** Parse the transcript JSONL into entries, skipping any unparsable lines. */
function readTranscriptLines(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return [];
	const raw = readFileSync(transcriptPath, "utf8");
	return raw.split("\n").filter((l) => l.trim().length > 0);
}

function parseEntry(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/** Plain user-typed prompt text, or null (e.g. for a tool_result-carrying "user" entry). */
function extractUserText(entry) {
	if (entry?.type !== "user") return null;
	const content = entry.message?.content;
	if (!Array.isArray(content)) return null;
	const textParts = content.filter((c) => c?.type === "text").map((c) => c.text);
	if (textParts.length === 0) return null; // tool_result-only entries have no "text" blocks
	return textParts.join("\n").trim();
}

/** Concatenated assistant prose from one assistant message, or null if it's tool-use-only. */
function extractAssistantText(entry) {
	if (entry?.type !== "assistant") return null;
	const content = entry.message?.content;
	if (!Array.isArray(content)) return null;
	const textParts = content.filter((c) => c?.type === "text").map((c) => c.text.trim()).filter(Boolean);
	if (textParts.length === 0) return null;
	return textParts.join("\n\n");
}

/** The most recent AskUserQuestion tool_use before/at `endIndex`, or null. */
function findLastAskUserQuestion(entries, endIndex) {
	for (let i = endIndex; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "assistant") continue;
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "tool_use" && block.name === ASK_TOOL_NAME) {
				return block.input;
			}
		}
	}
	return null;
}

// ---- formatting (ported from Pi's md-log.ts style) --------------------------

function callout(type, title, bodyLines) {
	const lines = [`> [!${type}] ${title}`];
	for (const line of bodyLines) {
		lines.push(line.length === 0 ? ">" : `> ${line}`);
	}
	return lines.join("\n");
}

function userBlock(text) {
	return `> [!quote] YOU\n\n${text}`;
}

function appendToFile(targetPath, text) {
	let current = "";
	if (existsSync(targetPath)) {
		current = readFileSync(targetPath, "utf8");
	} else {
		mkdirSync(dirname(targetPath), { recursive: true });
	}
	const prefix = current.trim().length > 0 ? "\n\n" : "";
	writeFileSync(targetPath, current + prefix + text + "\n", "utf8");
}

// ---- generic prose pass: any new user prompts + assistant text -------------

function appendNewProse(targetPath, entries, fromIndex, toIndex) {
	for (let i = fromIndex; i < toIndex; i++) {
		const entry = entries[i];
		const userText = extractUserText(entry);
		if (userText) {
			appendToFile(targetPath, userBlock(userText));
			continue;
		}
		const assistantText = extractAssistantText(entry);
		if (assistantText) {
			appendToFile(targetPath, assistantText);
		}
	}
}

// ---- hook payload -----------------------------------------------------------

function readStdinJson() {
	try {
		const raw = readFileSync(0, "utf8"); // fd 0 = stdin
		return raw.trim() ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

// ---- subcommands -------------------------------------------------------------

function cmdLink(pathArg) {
	if (!pathArg || !pathArg.trim()) {
		console.error("md-log: /md-log requires a file path, e.g. /md-log notes/lesson.md");
		process.exit(1);
	}
	const resolved = isAbsolute(pathArg) ? pathArg : resolve(process.cwd(), pathArg);
	setTarget(resolved);
	// Offset is intentionally left uninitialized here: the Stop/PostToolUse
	// hooks lazily baseline it to "now" on their first run after linking, so
	// linking never backfills prior turns (see file header).
	try {
		rmSync(OFFSET_FILE);
	} catch {
		// No prior offset — fine.
	}
	console.log(`md-log: linked to ${resolved}`);
}

function cmdUnlink() {
	clearTarget();
	console.log("md-log: unlinked.");
}

function cmdStop() {
	const target = getTarget();
	if (!target) return; // not linked — no-op
	const payload = readStdinJson();
	const entries = readTranscriptLines(payload.transcript_path).map(parseEntry);

	let offset = getOffset();
	if (offset === null) {
		// First run since linking (or since transcript growth was never
		// observed): baseline to the current end, no backfill.
		setOffset(entries.length);
		return;
	}
	if (entries.length <= offset) return; // nothing new

	appendNewProse(target, entries, offset, entries.length);
	setOffset(entries.length);
}

function cmdGrade() {
	const target = getTarget();
	if (!target) return; // not linked — no-op
	const payload = readStdinJson();
	const entries = readTranscriptLines(payload.transcript_path).map(parseEntry);

	let offset = getOffset();
	if (offset === null) {
		setOffset(entries.length);
		offset = entries.length;
	}

	// Log any lesson prose that happened since the last append (e.g. the
	// motivation for this quiz) before the Q&A block, to keep rough
	// chronological order.
	if (entries.length > offset) {
		appendNewProse(target, entries, offset, entries.length);
	}

	const question = findLastAskUserQuestion(entries, entries.length - 1)?.questions?.[0]?.question;
	const gradeText = payload.tool_response?.content?.find((c) => c?.type === "text")?.text
		?? (typeof payload.tool_response === "string" ? payload.tool_response : "(no grading text found)");

	const body = [];
	if (question) body.push(question, "");
	body.push(...gradeText.split("\n"));

	appendToFile(target, callout("question", "QUIZ", body));
	setOffset(entries.length);
}

// ---- entry point --------------------------------------------------------------

const [subcommand, arg] = process.argv.slice(2);
switch (subcommand) {
	case "link":
		cmdLink(arg);
		break;
	case "unlink":
		cmdUnlink();
		break;
	case "stop":
		cmdStop();
		break;
	case "grade":
		cmdGrade();
		break;
	default:
		console.error(`md-log: unknown subcommand "${subcommand ?? ""}" (expected link|unlink|stop|grade)`);
		process.exit(1);
}
