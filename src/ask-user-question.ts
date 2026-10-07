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

/**
 * A question as its tool row carries it, live and in history: what was asked,
 * and — once known — what came back. `state` is absent while no result has
 * been seen (the turn may still be waiting on the user); "none" means the
 * question was declined, aborted, or answered with nothing.
 */
export type AskRecord = {
  questions: { header: string; question: string }[];
  /** Question text → the answer, multi-select comma-joined (the tool's own format). */
  answers?: Record<string, string>;
  state?: "answered" | "none";
};

/** The record for a tool input, or null when it is not a question we can read. */
export function askRecord(input: unknown): AskRecord | null {
  const questions = parseAskUserQuestion(input);
  return questions ? { questions: questions.map(({ header, question }) => ({ header, question })) } : null;
}

/** Answers as the client sends them, flattened to the tool's one-string-per-question form. */
export function flattenAskAnswers(input: unknown, answers: AskAnswers): Record<string, string> {
  return withAskAnswers(input, answers).answers as Record<string, string>;
}

/** `"question"="answer"` pairs out of the text the tool echoes to the model. */
export function parseAnswerText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pair = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  for (let m = pair.exec(text); m; m = pair.exec(text)) {
    const q = m[1].trim();
    const a = m[2].trim();
    if (q && a) out[q] = a;
  }
  return out;
}

const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n")
      : "";

/**
 * What a transcript's tool_result says about a question. The SDK records the
 * answers it used in `toolUseResult.answers`; older or unusual entries fall
 * back to the echoed text. An error result (declined, aborted) and an empty
 * answer map — an allow that carried no answers, so the model was told
 * `answered: .` — both read as "none": the user said nothing.
 */
export function askResult(
  toolUseResult: unknown,
  content: unknown,
  isError: boolean,
): Pick<AskRecord, "answers" | "state"> {
  if (isError) return { state: "none" };
  const stored = (toolUseResult as { answers?: unknown } | null)?.answers;
  const answers: Record<string, string> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [q, a] of Object.entries(stored as Record<string, unknown>)) {
      const value = Array.isArray(a) ? a.map(String).join(", ") : typeof a === "string" ? a : "";
      if (q.trim() && value.trim()) answers[q.trim()] = value.trim();
    }
  } else {
    Object.assign(answers, parseAnswerText(resultText(content)));
  }
  return Object.keys(answers).length ? { answers, state: "answered" } : { state: "none" };
}

/** One compact line for a text transcript (Jarvis's thread reader). */
export function askLine(record: AskRecord, max = 200): string {
  const said = record.questions.map((q) => {
    const a = record.answers?.[q.question];
    return `${q.question} → ${a ?? (record.state ? "no answer" : "awaiting answer")}`;
  });
  const line = `[asked: ${said.join("; ")}]`;
  return line.length > max ? `${line.slice(0, max - 2)}…]` : line;
}
