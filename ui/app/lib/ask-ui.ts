import type { AskAnswers, AskRecord } from "./gitbot";

// How an AskUserQuestion reads as a tool row: collapsed, the first question
// and its answer, each shortened; expanded, every question with its full
// answer. Pure, so the wording is tested without a browser.

/** Where a question stands. "waiting" is known only to the chat (a pending
 *  card for it); the record itself says answered or none. */
export type AskStatus = "waiting" | "answered" | "none";

export const ASK_QUESTION_CHARS = 60;
export const ASK_ANSWER_CHARS = 40;

/** Cut to `max` characters on a word boundary where one is near, with "…". */
export function shorten(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

export function askStatus(ask: AskRecord, waiting: boolean): AskStatus {
  if (ask.state === "answered" && ask.answers && Object.keys(ask.answers).length) return "answered";
  if (ask.state === "none") return "none";
  return waiting ? "waiting" : "none";
}

/** One question's answer as words, or the status in its place. */
function answerOf(ask: AskRecord, question: string, status: AskStatus): string {
  const a = ask.answers?.[question];
  if (a) return a;
  return status === "waiting" ? "waiting for your answer" : "no answer";
}

/** The collapsed row: `Which layout should we use? → Option A (+1 more)`. */
export function askSummary(ask: AskRecord, waiting: boolean): string {
  const status = askStatus(ask, waiting);
  const first = ask.questions[0];
  if (!first) return status === "waiting" ? "waiting for your answer" : "no answer";
  const more = ask.questions.length > 1 ? ` (+${ask.questions.length - 1} more)` : "";
  const answer = answerOf(ask, first.question, status);
  const shown = ask.answers?.[first.question] ? shorten(answer, ASK_ANSWER_CHARS) : answer;
  return `${shorten(first.question, ASK_QUESTION_CHARS)} → ${shown}${more}`;
}

/** The expanded row: every question in full, with its full answer. */
export function askDetail(ask: AskRecord, waiting: boolean): { question: string; answer: string; answered: boolean }[] {
  const status = askStatus(ask, waiting);
  return ask.questions.map((q) => ({
    question: q.question,
    answer: answerOf(ask, q.question, status),
    answered: !!ask.answers?.[q.question],
  }));
}

/** The client's answers as the record keeps them: one string per question,
 *  multi-select comma-joined — the server's own format, so the live row and
 *  the reloaded one read the same. */
export function flattenAnswers(answers: AskAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [q, list] of Object.entries(answers)) {
    const value = list.map((v) => v.trim()).filter(Boolean).join(", ");
    if (value) out[q.trim()] = value;
  }
  return out;
}
