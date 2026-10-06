import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatMessage, loadTranscript } from "../src/start-claude-code";
import { nextPlan } from "../ui/app/lib/plan";
import type { HistoryMsg, TodoItem } from "../ui/app/lib/gitbot";

// The plan panel mirrors the main agent's TodoWrite list. A Task sub-agent
// keeps its own todos, and those must never stand in for the main plan —
// neither live (`parent_tool_use_id`) nor on replay (`isSidechain`).

const configDir = mkdtempSync(join(tmpdir(), "gitbot-plan-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
const cwd = "/work/demo";

function transcript(id: string, entries: unknown[]): void {
  const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
}

const todoWrite = (content: string, status = "in_progress") => ({
  type: "tool_use",
  name: "TodoWrite",
  input: { todos: [{ content, status, activeForm: `${content}ing` }] },
});

/** One assistant SDK message carrying the given content blocks. */
const assistantMsg = (content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: "assistant", message: { content }, ...extra }) as any;

const payloads = (msg: any) => {
  const out = formatMessage(msg);
  return (Array.isArray(out) ? out : out ? [out] : []) as Record<string, any>[];
};

// --- Live path ---------------------------------------------------------

test("the main agent's TodoWrite carries the plan alongside its chip", () => {
  const [p] = payloads(assistantMsg([todoWrite("Ship the panel")]));
  assert.equal(p.tool_name, "TodoWrite");
  assert.deepEqual(p.todos, [
    { content: "Ship the panel", status: "in_progress", activeForm: "Ship the paneling" },
  ]);
  // The one-line chip summary is untouched by the structured list.
  assert.equal(p.tool_input, "[in_progress] Ship the panel");
});

test("a sub-agent's TodoWrite does not drive the panel, but still shows a chip", () => {
  const [p] = payloads(assistantMsg([todoWrite("Sub-agent busywork")], { parent_tool_use_id: "toolu_task1" }));
  assert.equal(p.tool_name, "TodoWrite");
  assert.equal(p.parent_tool_use_id, "toolu_task1");
  // The chip renders like any other sub-agent call; the plan does not travel.
  assert.equal(p.tool_input, "[in_progress] Sub-agent busywork");
  assert.equal("todos" in p, false);
});

test("a non-TodoWrite call never carries todos", () => {
  const [p] = payloads(assistantMsg([{ type: "tool_use", name: "Read", input: { file_path: "/a.ts" } }]));
  assert.equal("todos" in p, false);
});

// --- Replay path -------------------------------------------------------

test("replay seeds from the main agent's plan and ignores a later sub-agent's", async () => {
  transcript("t1", [
    { type: "assistant", message: { content: [todoWrite("Main plan")] } },
    // A Task's sub-agent writes its own list after the main agent's.
    { type: "assistant", isSidechain: true, message: { content: [todoWrite("Sidechain plan")] } },
  ]);
  const msgs = await loadTranscript("t1", cwd);
  const blocks = msgs.flatMap((m) => m.content);

  // Both calls still appear as chips in the transcript.
  assert.equal(blocks.filter((b) => b.tool_name === "TodoWrite").length, 2);
  // Only the main agent's carries the list, so the last one found is its own.
  const withTodos = blocks.filter((b) => b.todos);
  assert.equal(withTodos.length, 1);
  assert.equal(withTodos[0].todos[0].content, "Main plan");
  assert.equal(nextPlan(null, msgs as HistoryMsg[])?.[0].content, "Main plan");
});

// --- Seeding -----------------------------------------------------------

const plan = (content: string): TodoItem[] => [{ content, status: "pending", activeForm: content }];
const history = (todos?: TodoItem[]): HistoryMsg[] => [
  { role: "assistant", content: todos ? [{ type: "tool_use", tool_name: "TodoWrite", todos }] : [{ type: "text", text: "hi" }] },
];

test("seeding takes the last plan the transcript wrote", () => {
  const msgs: HistoryMsg[] = [...history(plan("first")), ...history(plan("second"))];
  assert.equal(nextPlan(null, msgs)?.[0].content, "second");
});

test("seeding never wipes a live plan when the transcript holds none", () => {
  const live = plan("in flight");
  // A quiet mid-turn refresh: the transcript has not caught up with the stream.
  assert.equal(nextPlan(live, history()), live);
  assert.equal(nextPlan(live, []), live);
  // With nothing live and nothing written, there is still no panel.
  assert.equal(nextPlan(null, history()), null);
});

test("a transcript plan replaces a live one, so a turn run elsewhere still shows", () => {
  assert.equal(nextPlan(plan("stale"), history(plan("newer")))?.[0].content, "newer");
});
