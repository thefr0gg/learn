/**
 * Pure grading/shuffle logic for the quiz-ask MCP server, ported from Pi's
 * extensions/quiz.ts. The pi-tui popup rendering is dropped entirely — there
 * is no terminal-popup surface for a headless MCP tool to draw into. Instead:
 *
 *   prepare_quiz  — shuffles + validates the author's options, injects a
 *                   synthesized "I don't know" choice, and returns a payload
 *                   shaped to hand straight to Claude Code's BUILT-IN
 *                   AskUserQuestion tool (which does the actual interactive
 *                   asking). The resolved correct answer is stashed
 *                   server-side, keyed by an opaque quizId, and never
 *                   disclosed in the response.
 *   grade_quiz    — takes the quizId + the labels AskUserQuestion returned,
 *                   grades them against the stash, and returns the same
 *                   ✓/✗ + "Correct answer: …" + explanation text quiz.ts
 *                   produced, for the model to relay verbatim in chat.
 *
 * See mcp-servers/quiz-ask/src/index.ts for the tool registration and the
 * in-memory store.
 */

export interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

export const DONT_KNOW_LABEL = "I don't know";
export const ASK_HEADER = "Quiz";
export const MAX_REAL_OPTIONS = 3; // AskUserQuestion caps at 4 options and always appends its own "Other".

export function normalizeOptions(
	options: Array<{ label: string; value?: string; description?: string }>,
): QuizOption[] {
	const seen = new Set<string>();
	return options
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => {
			if (option.label.length === 0) return false;
			if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`);
			seen.add(option.value);
			return true;
		});
}

// Fisher-Yates shuffle over a copy. Safe to reorder for display because
// correctAnswer is keyed by value, not position — indices are resolved AFTER
// shuffling, so grading always matches what the user actually sees.
export function shuffleOptions(options: QuizOption[]): QuizOption[] {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// The harness sometimes delivers a multi-select `correctAnswer` array as a
// JSON-stringified string (e.g. '["a", "b"]') instead of a real array. Detect
// that case and parse it back into an array. A plain single value is wrapped
// as-is.
export function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
	if (Array.isArray(correctAnswer)) return correctAnswer;
	const trimmed = correctAnswer.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map((v) => String(v));
		} catch {
			// Not valid JSON — fall through and treat as a single literal value.
		}
	}
	return [correctAnswer];
}

export function resolveCorrect(
	correctAnswer: string | string[] | undefined,
	options: QuizOption[],
): { indices: number[]; error?: string } {
	if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
	const arr = coerceCorrectAnswer(correctAnswer);
	if (arr.length === 0) return { indices: [], error: "correctAnswer is required" };
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices: number[] = [];
	for (const raw of arr) {
		const v = typeof raw === "string" ? raw.trim() : raw;
		const idx = byValue.get(v);
		if (idx === undefined) {
			const known = options.map((o) => `"${o.value}"`).join(", ");
			return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
		}
		indices.push(idx);
	}
	return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}

export function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((v, i) => v === b[i]);
}

function formatOptionRef(options: QuizOption[], index: number): string {
	const opt = options.find((_, i) => i + 1 === index);
	return `${index}. ${opt ? opt.label : "(unknown)"}`;
}

export interface StoredQuiz {
	question: string;
	context?: string;
	mode: "single-select" | "multi-select";
	options: QuizOption[]; // real, gradable options, in the shuffled display order
	correctIndices: number[]; // 1-based, into `options`
	explanation: string;
	createdAt: number;
}

export interface GradeResult {
	text: string;
	correct: boolean;
	dontKnow: boolean;
	ungraded: boolean;
}

/**
 * Grade the user's AskUserQuestion selection against a stored quiz.
 * `selectedLabels` are the option labels AskUserQuestion returned. A label
 * that matches neither a real option nor DONT_KNOW_LABEL means the user
 * answered through the native "Other" free-text slot — that's ungraded, not
 * silently marked wrong.
 */
export function gradeQuiz(quiz: StoredQuiz, selectedLabels: string[], note?: string): GradeResult {
	const dontKnow = selectedLabels.length === 1 && selectedLabels[0] === DONT_KNOW_LABEL;

	if (!dontKnow) {
		const unknown = selectedLabels.filter(
			(label) => !quiz.options.some((o) => o.label === label) && label !== DONT_KNOW_LABEL,
		);
		if (unknown.length > 0) {
			let text = `User answered outside the listed options (via "Other"): ${selectedLabels.join(", ")}.`;
			text += `\nThis is UNGRADED — treat it as a free-text note, not a graded right/wrong answer.`;
			const correctStr = quiz.correctIndices.map((i) => formatOptionRef(quiz.options, i)).join(", ");
			text += `\nCorrect answer: ${correctStr}`;
			if (note) text += `\nUser's note: ${note}`;
			if (quiz.explanation) text += `\nExplanation: ${quiz.explanation}`;
			return { text, correct: false, dontKnow: false, ungraded: true };
		}
	}

	const selectedIndices = dontKnow
		? []
		: selectedLabels
				.map((label) => quiz.options.findIndex((o) => o.label === label) + 1)
				.filter((i) => i > 0);

	// "I don't know" is never counted as correct — it's a distinct outcome.
	const correct = dontKnow ? false : isCorrect(selectedIndices, quiz.correctIndices);
	const correctStr = quiz.correctIndices.map((i) => formatOptionRef(quiz.options, i)).join(", ");

	let text: string;
	if (dontKnow) {
		text = `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).`;
		text += `\nCorrect answer: ${correctStr}`;
		if (note) text += `\nUser's note: ${note}`;
	} else {
		const verdict = correct ? "correctly" : "incorrectly";
		const selectedStr = selectedIndices.map((i) => formatOptionRef(quiz.options, i)).join(", ");
		text = `User answered ${verdict}.\nSelected: ${selectedStr}\nCorrect answer: ${correctStr}`;
		if (note) text += `\nUser's note: ${note}`;
	}
	if (quiz.explanation) text += `\nExplanation: ${quiz.explanation}`;

	return { text, correct, dontKnow, ungraded: false };
}
