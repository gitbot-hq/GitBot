import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { askLine, askResult, parseAnswerText } from "../src/ask-user-question";
import { loadTranscript } from "../src/start-claude-code";

// The transcript lives under CLAUDE_CONFIG_DIR, read when the loader runs.
const configDir = mkdtempSync(join(tmpdir(), "gitbot-ask-history-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
const cwd = "/work/ask";

function transcript(id: string, entries: unknown[]): void {
  const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
}

const LAYOUT = "Which layout should we use?";
const SCOPE = "What should the thread do?";
const question = (q: string, header: string) => ({
  question: q,
  header,
  multiSelect: false,
  options: [{ label: "A", description: "" }, { label: "B", description: "" }],
});
const asked = (id: string, questions: unknown[]) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] },
});
const result = (id: string, content: unknown, toolUseResult?: unknown, isError = false) => ({
  type: "user",
  userType: "external",
  message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  ...(toolUseResult !== undefined ? { toolUseResult } : {}),
});

/** Every AskUserQuestion row in a loaded transcript, by tool_use_id. */
async function asks(id: string) {
  const out: Record<string, any> = {};
  for (const m of await loadTranscript(id, cwd)) {
    for (const b of m.content) if (b.ask) out[b.tool_use_id] = b.ask;
  }
  return out;
}

test("a question's row carries the answers the SDK recorded, by tool_use_id", async () => {
  transcript("answered", [
    { type: "user", userType: "external", message: { content: "plan it" } },
    asked("tu-1", [question(LAYOUT, "Layout"), question(SCOPE, "Scope")]),
    result("tu-1", `The user answered: "${LAYOUT}"="Option A (Recommended)"`, {
      questions: [],
      answers: { [LAYOUT]: "Option A (Recommended)", [SCOPE]: "Fix all, then push" },
    }),
    { type: "assistant", message: { content: [{ type: "text", text: "Going with A." }] } },
  ]);
  const messages = await loadTranscript("answered", cwd);
  // The answer is not a user message of its own: it rides on the row.
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "assistant"]);
  assert.deepEqual((await asks("answered"))["tu-1"], {
    questions: [{ header: "Layout", question: LAYOUT }, { header: "Scope", question: SCOPE }],
    answers: { [LAYOUT]: "Option A (Recommended)", [SCOPE]: "Fix all, then push" },
    state: "answered",
  });
});

test("declined, aborted, and empty answers read as none; no result yet leaves the state open", async () => {
  transcript("unanswered", [
    asked("tu-declined", [question(LAYOUT, "Layout")]),
    result("tu-declined", "User declined to answer the questions", undefined, true),
    // A real transcript: allowed with no answers, so the tool echoed an empty list.
    asked("tu-empty", [question(SCOPE, "Scope")]),
    result("tu-empty", "User has answered your questions: . You can now continue with the user's answers in mind.", {
      questions: [],
      answers: {},
    }),
    asked("tu-waiting", [question(LAYOUT, "Layout")]),
  ]);
  const got = await asks("unanswered");
  assert.equal(got["tu-declined"].state, "none");
  assert.equal(got["tu-empty"].state, "none");
  assert.equal(got["tu-empty"].answers, undefined);
  assert.equal(got["tu-waiting"].state, undefined);
});

test("without a recorded answers map, the echoed text is read instead", async () => {
  transcript("text-only", [
    asked("tu-1", [question(LAYOUT, "Layout")]),
    result("tu-1", [{ type: "text", text: `User has answered your questions: "${LAYOUT}"="B, with tweaks". You can now continue.` }]),
  ]);
  assert.deepEqual((await asks("text-only"))["tu-1"].answers, { [LAYOUT]: "B, with tweaks" });
});

test("other tools keep their id and no ask", async () => {
  transcript("plain", [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu-r", name: "Read", input: { file_path: "/a" } }] } },
  ]);
  const [m] = await loadTranscript("plain", cwd);
  assert.equal(m.content[0].tool_use_id, "tu-r");
  assert.equal(m.content[0].ask, undefined);
});

test("parseAnswerText reads quoted pairs and ignores the rest", () => {
  assert.deepEqual(parseAnswerText(`The user answered: "a?"="x", "b \\"q\\"?"="y, z". Continue.`), {
    "a?": "x",
    'b \\"q\\"?': "y, z",
  });
  assert.deepEqual(parseAnswerText("User has answered your questions: . You can now continue."), {});
});

test("askResult joins array answers and drops blanks", () => {
  assert.deepEqual(askResult({ answers: { q: ["a", "b"], r: "  " } }, "", false), { answers: { q: "a, b" }, state: "answered" });
  assert.deepEqual(askResult({ answers: { q: "a" } }, "", true), { state: "none" });
});

test("askLine is one compact line for Jarvis's reader", () => {
  const record = { questions: [{ header: "L", question: LAYOUT }, { header: "S", question: SCOPE }], answers: { [LAYOUT]: "A" }, state: "answered" as const };
  assert.equal(askLine(record), `[asked: ${LAYOUT} → A; ${SCOPE} → no answer]`);
  assert.equal(askLine({ questions: [{ header: "L", question: LAYOUT }] }), `[asked: ${LAYOUT} → awaiting answer]`);
  const long = askLine({ questions: [{ header: "L", question: "x".repeat(400) }], state: "none" }, 200);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…]"));
});
