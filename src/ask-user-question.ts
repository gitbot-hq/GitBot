/**
 * Claude Code's AskUserQuestion tool: the one tool whose whole point is to
 * stop and ask the person at the keyboard.
 *
 * The SDK never runs it unattended — its own `checkPermissions` always answers
 * "ask", so the harness's `canUseTool` is called for every one of these, which
 * is where gitbot picks it up (see start-claude-code.ts). It is also on
 * TOOL_BLACKLIST, so no permission mode (not even yolo) can wave it through:
 * an unanswered question auto-approved is a question answered with nothing.
 *
 * Answers do not travel as a tool result. The tool reads them back out of its
 * *own input*: the permission layer returns `{behavior:"allow", updatedInput}`
 * with an `answers` map added, and the tool echoes it to the model as
 * `"<question>"="<answer>"`. Multi-select answers are one comma-joined string.
 * That contract is the SDK's; it lives here so only this file knows it.
 */

export const ASK_USER_QUESTION = "AskUserQuestion";

export type AskOption = { label: string; description: string };

export type AskQuestion = {
  /** Short chip label ("Auth method"), max 12 chars by the tool's schema. */
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
};

/** Answers as the client sends them: question text → chosen labels (or free text). */
export type AskAnswers = Record<string, string[]>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The questions in a tool input, or null when it does not look like one.
 * Null is a real answer: the caller falls back to the plain approval card
 * rather than guessing at a shape the SDK may have changed under us.
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
    // No options at all is not this tool's shape — it would render as a card
    // with nothing to pick. "Other" alone is not worth a special case.
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

/** True when this pending approval is a question for the user, not a tool to allow. */
export function isAskUserQuestion(toolName: string, input: unknown): boolean {
  return toolName === ASK_USER_QUESTION && parseAskUserQuestion(input) !== null;
}

/**
 * The input to hand back as `updatedInput`: the original plus the `answers`
 * map the tool reads. Keyed by question text, because that is the key the
 * tool echoes to the model. Questions left unanswered are left out, so a
 * partial answer says only what the user actually said.
 */
export function withAskAnswers(input: unknown, answers: AskAnswers): Record<string, unknown> {
  const base = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const questions = parseAskUserQuestion(input);
  const out: Record<string, string> = {};
  for (const q of questions ?? []) {
    const picked = (answers[q.question] ?? [])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    // Multi-select arrives as one comma-joined string: the tool's own format.
    if (picked.length) out[q.question] = picked.join(", ");
  }
  return { ...base, answers: out };
}

/** One line naming what was asked, for a tool chip or an approval row. */
export function askUserQuestionLabel(input: unknown): string {
  const questions = parseAskUserQuestion(input);
  if (!questions) return ASK_USER_QUESTION;
  return questions.map((q) => q.question).join(" · ");
}
