#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ASK_HEADER,
	DONT_KNOW_LABEL,
	MAX_REAL_OPTIONS,
	type StoredQuiz,
	gradeQuiz,
	normalizeOptions,
	resolveCorrect,
	shuffleOptions,
} from "./quiz.js";

const server = new McpServer({ name: "learn-quiz-ask", version: "0.1.0" });

// In-memory store, keyed by quizId. Safe because this MCP server is a
// long-lived stdio child process for the lifetime of one Claude Code
// session — same lifetime assumption Pi's quiz.ts module-level state made.
const store = new Map<string, StoredQuiz>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

function sweep(): void {
	const now = Date.now();
	for (const [id, quiz] of store) {
		if (now - quiz.createdAt > TTL_MS) store.delete(id);
	}
}

const OptionSchema = z.object({
	label: z.string().describe("Display label for the answer option."),
	value: z.string().optional().describe("Machine-readable value returned for the option. Defaults to the label."),
	description: z.string().optional().describe("Optional extra detail shown below the option."),
});

server.registerTool(
	"prepare_quiz",
	{
		title: "Prepare quiz",
		description:
			"Prepare a GRADED question with a known correct answer. Unlike a plain " +
			"question (use the built-in AskUserQuestion tool for those — no right " +
			"answer), a quiz always has a correct answer you supply, and grading is " +
			"exact and automatic. Use it to (1) assess what the learner already " +
			"understands before teaching, and (2) run tight practice/retrieval loops " +
			"after explaining, or whenever you're unsure they've got it.\n\n" +
			"This tool does NOT ask the user anything itself — it validates and " +
			"shuffles your options, adds an automatic 'I don't know' choice, and " +
			"returns an `askUserQuestion` payload plus a `quizId`. You then call the " +
			"BUILT-IN AskUserQuestion tool with that exact payload to actually ask the " +
			"user, and finally call grade_quiz with the quizId and the user's selected " +
			"label(s) to get graded feedback to relay back to them.\n\n" +
			"Options-only, no free-text mode: give at most 3 real, gradable options " +
			"(AskUserQuestion caps at 4 total and this tool reserves one slot for the " +
			"automatic 'I don't know'). Never add your own uncertainty/opt-out option " +
			"— that is handled for you. correctAnswer is REQUIRED and must be the " +
			"option's `value` (not a position number): a single string for " +
			"single-select, or an array of strings for multi-select (graded as an " +
			"exact-set match). explanation is REQUIRED. Treat each wrong option as a " +
			"diagnostic probe — a specific, believable misconception — not filler, and " +
			"keep option phrasing/length even so the correct one can't be picked from " +
			"shape alone. Options are shuffled by default; set shuffle: false only when " +
			"order is meaningful (ordered values, or an 'All/None of the above' option " +
			"that must stay last).",
		inputSchema: {
			question: z.string().describe("The single quiz question to ask."),
			details: z.string().optional().describe("Optional extra context shown under the question."),
			options: z
				.array(OptionSchema)
				.min(2)
				.max(MAX_REAL_OPTIONS)
				.describe(`The real, gradable answer options (2 to ${MAX_REAL_OPTIONS}). "I don't know" is added automatically — do not include it yourself.`),
			multiSelect: z.boolean().optional().describe("Set to true when more than one option is correct."),
			correctAnswer: z
				.union([z.string(), z.array(z.string())])
				.describe(
					'REQUIRED. The correct answer as the option value(s). Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]).',
				),
			explanation: z.string().describe("REQUIRED. Revealed after the user answers, shown whether right or wrong."),
			shuffle: z
				.boolean()
				.optional()
				.describe("Defaults to true: options are randomly reordered before display."),
		},
	},
	async ({ question, details, options, multiSelect, correctAnswer, explanation, shuffle }) => {
		sweep();

		let normalized;
		try {
			normalized = normalizeOptions(options);
		} catch (e) {
			return { content: [{ type: "text" as const, text: `prepare_quiz: ${(e as Error).message}` }], isError: true };
		}
		if (normalized.length < 2) {
			return { content: [{ type: "text" as const, text: "prepare_quiz requires at least two options." }], isError: true };
		}

		const displayed = shuffle === false ? normalized : shuffleOptions(normalized);

		const { indices: correctIndices, error } = resolveCorrect(correctAnswer, displayed);
		if (error) {
			return { content: [{ type: "text" as const, text: `prepare_quiz: ${error}` }], isError: true };
		}

		const quizId = randomUUID();
		store.set(quizId, {
			question,
			context: details,
			mode: multiSelect ? "multi-select" : "single-select",
			options: displayed,
			correctIndices,
			explanation,
			createdAt: Date.now(),
		});

		const askUserQuestion = {
			questions: [
				{
					question,
					header: ASK_HEADER,
					multiSelect: Boolean(multiSelect),
					options: [
						...displayed.map((o) => ({ label: o.label, description: o.description })),
						{ label: DONT_KNOW_LABEL, description: "You genuinely don't know — this is not a guess." },
					],
				},
			],
		};

		const payload = { quizId, askUserQuestion };
		return {
			content: [
				{
					type: "text" as const,
					text:
						"Now call the BUILT-IN AskUserQuestion tool with the `askUserQuestion` payload below verbatim " +
						"(it already includes the automatic 'I don't know' option), then call grade_quiz with this " +
						"quizId and the user's selected label(s).\n\n" +
						JSON.stringify(payload, null, 2),
				},
			],
		};
	},
);

server.registerTool(
	"grade_quiz",
	{
		title: "Grade quiz",
		description:
			"Grade a quiz answer against the quiz prepared by prepare_quiz, and return " +
			"✓/✗ feedback + the correct answer + the explanation, ready to relay " +
			"verbatim to the user in your reply. Call this immediately after the " +
			"built-in AskUserQuestion tool returns the user's selection for that " +
			"question. If the user answered via AskUserQuestion's own 'Other' free-text " +
			"slot (not one of the listed options), this returns an UNGRADED result — " +
			"treat it as a note, not a right/wrong grade.",
		inputSchema: {
			quizId: z.string().describe("The quizId returned by prepare_quiz."),
			selectedLabels: z
				.array(z.string())
				.min(1)
				.describe("The option label(s) the user selected, exactly as AskUserQuestion returned them."),
			note: z.string().optional().describe("Optional free-text note to fold into the feedback."),
		},
	},
	async ({ quizId, selectedLabels, note }) => {
		sweep();
		const quiz = store.get(quizId);
		if (!quiz) {
			return {
				content: [
					{
						type: "text" as const,
						text: `grade_quiz: unknown or expired quizId "${quizId}" — call prepare_quiz again.`,
					},
				],
				isError: true,
			};
		}
		const result = gradeQuiz(quiz, selectedLabels, note);
		store.delete(quizId); // one-shot: a quiz is graded exactly once
		return { content: [{ type: "text" as const, text: result.text }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
