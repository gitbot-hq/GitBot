// Claude Code's AskUserQuestion, as the chat needs to read it. A mirror of
// src/ask-user-question.ts's parse half, kept frontend-only like the rest of
// lib/gitbot.ts: no fetches, and no knowledge of how an answer reaches the
// SDK. The client sends the labels the user picked; the server turns those
// into the tool's own `answers` map.

export const ASK_USER_QUESTION = "AskUserQuestion";

export type AskOption = { label: string; description: string };

export type AskQuestion = {
  /** Short chip label ("Auth method"), max 12 chars by the tool's schema. */
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
};

/** Question text → the labels chosen (or the words typed under "Other"). */
export type AskAnswers = Record<string, string[]>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The questions in a tool input, or null when it does not look like one —
 * in which case the chat falls back to the plain approval card rather than
 * guessing at a shape the SDK may have changed under us.
 */
export function parseAskUserQuestion(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const questions: AskQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const question = str(e.question);
    if (!question) return null;

    const options: AskOption[] = [];
    if (Array.isArray(e.options)) {
      for (const opt of e.options) {
        if (!opt || typeof opt !== "object") continue;
        const label = str((opt as Record<string, unknown>).label);
        if (!label) continue;
        options.push({ label, description: str((opt as Record<string, unknown>).description) });
      }
    }
    if (options.length === 0) return null;

    questions.push({
      header: str(e.header) || question,
      question,
      multiSelect: e.multiSelect === true,
      options,
    });
  }
  return questions;
}

/** True when a pending approval is a question to answer, not a tool to allow. */
export function isAskUserQuestion(toolName: string, input: unknown): boolean {
  return toolName === ASK_USER_QUESTION && parseAskUserQuestion(input) !== null;
}

/**
 * Every question has something chosen. The tool offers "Other" on every
 * question, so there is always a way to answer; an empty "Other" box is not
 * an answer, and `pick` drops it before it gets here.
 */
export function isComplete(questions: AskQuestion[], answers: AskAnswers): boolean {
  return questions.every((q) => (answers[q.question] ?? []).length > 0);
}

/** Add or remove one value, honouring single- vs multi-select. */
export function pick(
  answers: AskAnswers,
  q: AskQuestion,
  value: string,
  on: boolean,
): AskAnswers {
  const current = answers[q.question] ?? [];
  if (!q.multiSelect) {
    const next = { ...answers };
    if (on && value) next[q.question] = [value];
    else delete next[q.question];
    return next;
  }
  const without = current.filter((v) => v !== value);
  const list = on && value ? [...without, value] : without;
  const next = { ...answers };
  if (list.length) next[q.question] = list;
  else delete next[q.question];
  return next;
}
