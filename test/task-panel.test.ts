import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadTranscript, taskEvents, taskOp } from "../src/start-claude-code";
import { NO_TASKS, foldTasks, nextTasks, seedTasks, taskSummary, type TaskOp, type TaskState } from "../ui/app/lib/tasks";

// The task panel folds TaskCreate / TaskGet / TaskUpdate / TaskList calls with
// their results. Every call and result below is copied from a real run (SDK
// 0.3.291, CLI 2.1.291, CLAUDE_CODE_ENABLE_TODO_TOOLS=1 in the probe only):
// the live SDK messages and the transcript carry the same input and result.

const configDir = mkdtempSync(join(tmpdir(), "gitbot-task-panel-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
const cwd = "/work/tasks";

function transcript(id: string, entries: unknown[]): void {
  const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
}

// [tool_use_id, tool, input, result text, structured result]
type Step = [string, string, Record<string, unknown>, string, Record<string, unknown>];
const RUN: Step[] = [
  ["toolu_01Qss", "TaskCreate", { subject: "Write parser", description: "Create parser implementation", activeForm: "Writing parser" },
    "Task #1 created successfully: Write parser", { task: { id: "1", subject: "Write parser" } }],
  ["toolu_01WkW", "TaskCreate", { subject: "Add tests", description: "Add test coverage", activeForm: "Adding tests" },
    "Task #2 created successfully: Add tests", { task: { id: "2", subject: "Add tests" } }],
  ["toolu_01PZ6", "TaskCreate", { subject: "Update docs", description: "Update documentation" },
    "Task #3 created successfully: Update docs", { task: { id: "3", subject: "Update docs" } }],
  ["toolu_019M2", "TaskUpdate", { taskId: "1", status: "in_progress" },
    "Updated task #1 status", { success: true, taskId: "1", updatedFields: ["status"], statusChange: { from: "pending", to: "in_progress" } }],
  ["toolu_0112U", "TaskUpdate", { taskId: "2", addBlockedBy: ["1"], owner: "probe" },
    "Updated task #2 owner, blockedBy", { success: true, taskId: "2", updatedFields: ["owner", "blockedBy"] }],
  ["toolu_01TRC", "TaskUpdate", { taskId: "1", status: "completed", subject: "Write the parser" },
    "Updated task #1 subject, status", { success: true, taskId: "1", updatedFields: ["subject", "status"], statusChange: { from: "in_progress", to: "completed" } }],
  ["toolu_01Q8C", "TaskUpdate", { taskId: "3", status: "deleted" },
    "Updated task #3 deleted", { success: true, taskId: "3", updatedFields: ["deleted"], statusChange: { from: "pending", to: "deleted" } }],
  ["toolu_01SwR", "TaskGet", { taskId: "2" },
    "Task #2: Add tests\nStatus: pending\nDescription: Add test coverage\nBlocked by: #1",
    { task: { id: "2", subject: "Add tests", description: "Add test coverage", status: "pending", blocks: [], blockedBy: ["1"] } }],
  ["toolu_01TuR", "TaskUpdate", { taskId: "99", status: "completed" },
    "Task not found", { success: false, taskId: "99", updatedFields: [], error: "Task not found" }],
  ["toolu_01JDA", "TaskList", {},
    "#1 [completed] Write the parser\n#2 [pending] Add tests (probe)",
    { tasks: [{ id: "1", subject: "Write the parser", status: "completed", blockedBy: [] }, { id: "2", subject: "Add tests", status: "pending", owner: "probe", blockedBy: [] }] }],
];

// The resumed session: same list, and a deleted id is never reused.
const RESUMED: Step[] = [
  ["toolu_01UYA", "TaskList", {}, "#1 [completed] Write the parser\n#2 [pending] Add tests (probe)", RUN[9][4]],
  ["toolu_0129e", "TaskCreate", { subject: "Ship it", description: "Ready to ship", activeForm: "Shipping" },
    "Task #4 created successfully: Ship it", { task: { id: "4", subject: "Ship it" } }],
  ["toolu_01BJ2", "TaskUpdate", { taskId: "4", status: "in_progress" },
    "Updated task #4 status", { success: true, taskId: "4", updatedFields: ["status"], statusChange: { from: "pending", to: "in_progress" } }],
];

// Live SDK messages: an assistant message with the call, then a user message
// with the result and its structured `tool_use_result`.
const sdkCall = ([id, name, input]: Step, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] },
});
const sdkResult = ([id, , , text, result]: Step, parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text }] },
  tool_use_result: result,
});

// The same in the transcript.
const entryCall = ([id, name, input]: Step, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  isSidechain: false,
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] },
  ...extra,
});
const entryResult = ([id, , , text, result]: Step, extra: Record<string, unknown> = {}) => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text }] },
  toolUseResult: result,
  ...extra,
});

/** The live ops a run of steps makes, through the server's taskEvents. */
function liveOps(steps: Step[]): TaskOp[] {
  const calls = new Map();
  return steps.flatMap((s) => [...taskEvents(calls, sdkCall(s)), ...taskEvents(calls, sdkResult(s))]) as unknown as TaskOp[];
}

const AFTER_RUN = [
  { id: "1", subject: "Write the parser", activeForm: "Writing parser", status: "completed", owner: undefined, blockedBy: [] },
  { id: "2", subject: "Add tests", activeForm: "Adding tests", status: "pending", owner: "probe", blockedBy: [] },
];

test("live: each Task call pairs with its result as one task_op", () => {
  const ops = liveOps(RUN);
  // The unknown id's TaskUpdate still makes an op; its result says it failed.
  assert.equal(ops.length, RUN.length);
  assert.deepEqual(ops[0], {
    type: "task_op",
    tool_use_id: "toolu_01Qss",
    tool: "TaskCreate",
    // The description is dropped: the panel never shows it.
    input: { subject: "Write parser", activeForm: "Writing parser" },
    result: { task: { id: "1", subject: "Write parser" } },
  });
});

test("live: the list follows creates, updates, a delete, a get and a list", () => {
  let state: TaskState = NO_TASKS;
  const seen: string[] = [];
  for (const op of liveOps(RUN)) {
    state = nextTasks(state, op);
    seen.push(`${taskSummary(state.tasks)} ${state.tasks.filter((t) => t.status === "completed").length}/${state.tasks.length}`);
  }
  assert.deepEqual(seen, [
    "Write parser 0/1",
    "Write parser 0/2",
    "Write parser 0/3",
    "Writing parser 0/3", // in progress: the activeForm
    "Writing parser 0/3",
    "Add tests 1/3", // done, struck; the next pending one shows
    "Add tests 1/2", // deleted
    "Add tests 1/2",
    "Add tests 1/2", // unknown id: nothing
    "Add tests 1/2",
  ]);
  assert.deepEqual(state.tasks, AFTER_RUN);
});

test("live: a replayed op is skipped; the next session's ids carry on", () => {
  let state: TaskState = NO_TASKS;
  for (const op of liveOps(RUN)) state = nextTasks(state, op);
  const before = state;
  for (const op of liveOps(RUN)) state = nextTasks(state, op);
  assert.equal(state, before);
  for (const op of liveOps(RESUMED)) state = nextTasks(state, op);
  assert.deepEqual(state.tasks.map((t) => `#${t.id} ${t.status}`), ["#1 completed", "#2 pending", "#4 in_progress"]);
  assert.equal(taskSummary(state.tasks), "Shipping");
});

test("live: sub-agent calls, failed calls, and other tools make no op", () => {
  const calls = new Map();
  const [create] = RUN;
  assert.deepEqual(taskEvents(calls, sdkCall(create, "toolu_agent")), []);
  assert.deepEqual(taskEvents(calls, sdkResult(create, "toolu_agent")), []);
  taskEvents(calls, sdkCall(create));
  const failed = { ...sdkResult(create), tool_use_result: "Error: blocked by hook" };
  failed.message.content[0] = { ...failed.message.content[0], is_error: true } as any;
  assert.deepEqual(taskEvents(calls, failed), []);
  assert.equal(calls.size, 0);
  const read = { type: "assistant", message: { content: [{ type: "tool_use", id: "tu-r", name: "Read", input: {} }] } };
  assert.deepEqual(taskEvents(calls, read), []);
  assert.equal(calls.size, 0);
  assert.equal(taskOp("TodoWrite", {}, { todos: [] }, false), undefined);
});

test("history: a Task call's block carries its op, as live", async () => {
  transcript("run", [
    { type: "user", userType: "external", message: { content: "test the task tools" } },
    ...RUN.flatMap((s) => [entryCall(s), entryResult(s)]),
  ]);
  const messages = await loadTranscript("run", cwd);
  const blocks = messages.flatMap((m) => m.content).filter((b) => b.task);
  assert.equal(blocks.length, RUN.length);
  const live = liveOps(RUN);
  blocks.forEach((b, i) => assert.deepEqual({ type: "task_op", tool_use_id: b.tool_use_id, ...b.task }, live[i]));
  assert.deepEqual(seedTasks(NO_TASKS, messages as any).tasks, AFTER_RUN);
});

test("history: sub-agent calls, unanswered calls and errors get no op", async () => {
  const [create, second] = RUN;
  transcript("other", [
    entryCall(create, { isSidechain: true }),
    entryResult(create, { isSidechain: true }),
    entryCall(second),
    { type: "user", message: { content: [{ tool_use_id: second[0], type: "tool_result", content: "<tool_use_error>InputValidationError</tool_use_error>", is_error: true }] }, toolUseResult: "Error: InputValidationError" },
    entryCall(RUN[3]),
  ]);
  const messages = await loadTranscript("other", cwd);
  assert.equal(messages.flatMap((m) => m.content).filter((b) => b.task).length, 0);
  assert.equal(seedTasks(NO_TASKS, messages as any), NO_TASKS);
});

test("seed: history then the live ops it lacks; repeating changes nothing", () => {
  const history = (steps: Step[]) => [{
    role: "assistant",
    content: liveOps(steps).map(({ tool_use_id, tool, input, result }) => ({ type: "tool_use", tool_use_id, task: { tool, input, result } })),
  }];
  // Live has run to the end of the resumed session; the transcript is behind.
  let live: TaskState = NO_TASKS;
  for (const op of liveOps([...RUN, ...RESUMED])) live = nextTasks(live, op);
  const seeded = seedTasks(live, history(RUN));
  assert.equal(seeded, live, "same ops in the same order: nothing to redo");
  // A page opened mid-turn: only the live tail, then history arrives.
  let tail: TaskState = NO_TASKS;
  for (const op of liveOps(RESUMED).slice(1)) tail = nextTasks(tail, op);
  assert.deepEqual(tail.tasks.map((t) => t.id), ["4"]);
  const merged = seedTasks(tail, history([...RUN, RESUMED[0]]));
  assert.deepEqual(merged.tasks, live.tasks);
  assert.equal(seedTasks(merged, history([...RUN, RESUMED[0]])), merged);
  assert.equal(seedTasks(NO_TASKS, []), NO_TASKS);
});

test("TaskList replaces the list but keeps each task's activeForm", () => {
  const ops = liveOps(RUN);
  const list = ops[ops.length - 1];
  const tasks = foldTasks([ops[0], ops[1], { ...list, tool_use_id: "x", result: { tasks: [{ id: "2", subject: "Add tests", status: "in_progress", blockedBy: [] }] } }]);
  assert.deepEqual(tasks, [{ id: "2", subject: "Add tests", activeForm: "Adding tests", status: "in_progress", owner: undefined, blockedBy: [] }]);
  assert.deepEqual(foldTasks([ops[0], { ...list, tool_use_id: "y", result: { tasks: [] } }]), []);
  assert.equal(taskSummary([{ id: "1", subject: "A", status: "completed", blockedBy: [] }]), "All tasks done");
});

// --- Dependencies, deletes, interrupted turns, compaction ---

const created = (id: string, subject: string): TaskOp => ({
  tool_use_id: `c${id}`, tool: "TaskCreate", input: { subject }, result: { task: { id, subject } },
});
const updated = (n: number, input: Record<string, unknown>, fields: string[], statusChange?: object): TaskOp => ({
  tool_use_id: `u${n}`, tool: "TaskUpdate", input, result: { success: true, taskId: input.taskId, updatedFields: fields, ...(statusChange ? { statusChange } : {}) },
});
const blockedBy = (ops: TaskOp[]) => Object.fromEntries(foldTasks(ops).map((t) => [t.id, t.blockedBy]));

test("addBlocks: the tasks it names become blocked by the updated one", () => {
  const ops = [created("1", "A"), created("2", "B"), updated(1, { taskId: "1", addBlocks: ["2"] }, ["blocks"])];
  assert.deepEqual(blockedBy(ops), { "1": [], "2": ["1"] });
  // Again changes nothing (the CLI skips one it already has).
  assert.deepEqual(blockedBy([...ops, updated(2, { taskId: "1", addBlocks: ["2"] }, [])]), { "1": [], "2": ["1"] });
  // The blocked task is known even when the updated one is not.
  assert.deepEqual(blockedBy([created("2", "B"), updated(1, { taskId: "1", addBlocks: ["2"] }, ["blocks"])]), { "2": ["1"] });
});

test("addBlockedBy: the updated task is blocked by those it names", () => {
  const ops = [created("1", "A"), created("2", "B"), created("3", "C"), updated(1, { taskId: "3", addBlockedBy: ["1", "2"] }, ["blockedBy"])];
  assert.deepEqual(blockedBy(ops), { "1": [], "2": [], "3": ["1", "2"] });
  assert.deepEqual(blockedBy([...ops, updated(2, { taskId: "3", addBlockedBy: ["2"] }, [])]), { "1": [], "2": [], "3": ["1", "2"] });
});

test("a deleted task no longer blocks the tasks that waited on it", () => {
  const ops = [
    created("1", "A"), created("2", "B"), created("3", "C"),
    updated(1, { taskId: "2", addBlockedBy: ["3", "1"] }, ["blockedBy"]),
    updated(2, { taskId: "3", status: "deleted" }, ["deleted"], { from: "pending", to: "deleted" }),
  ];
  assert.deepEqual(blockedBy(ops), { "1": [], "2": ["1"] });
});

test("an interrupted turn: a call with no result, or an interrupted one, makes no op", async () => {
  // Live: the call goes out, then Stop; the turn ends with no result.
  const calls = new Map();
  const [create, second] = RUN;
  assert.deepEqual(taskEvents(calls, sdkCall(create)), []);
  // Or the CLI closes it as interrupted: an error result with no object.
  assert.deepEqual(taskEvents(calls, sdkCall(second)), []);
  const cut = {
    type: "user", parent_tool_use_id: null,
    message: { role: "user", content: [{ tool_use_id: second[0], type: "tool_result", content: "[Request interrupted by user for tool use]", is_error: true }] },
    tool_use_result: "Error: [Request interrupted by user for tool use]",
  };
  assert.deepEqual(taskEvents(calls, cut), []);
  // The next turn's calls fold as usual, with nothing left from the first.
  const next = new Map();
  const ops = RUN.slice(2, 3).flatMap((s) => [...taskEvents(next, sdkCall(s)), ...taskEvents(next, sdkResult(s))]);
  assert.deepEqual(ops.map((o) => o.tool_use_id), ["toolu_01PZ6"]);

  // History: the same transcript gives no op for either call.
  transcript("interrupted", [
    entryCall(create),
    entryCall(second),
    { type: "user", isSidechain: false, message: cut.message, toolUseResult: cut.tool_use_result },
    entryCall(RUN[2]), entryResult(RUN[2]),
  ]);
  const messages = await loadTranscript("interrupted", cwd);
  const state = seedTasks(NO_TASKS, messages as any);
  assert.deepEqual(state.ops.map((o) => o.tool_use_id), ["toolu_01PZ6"]);
  assert.deepEqual(state.tasks.map((t) => t.id), ["3"]);
});

test("history: tasks made before a compaction are still seeded", async () => {
  transcript("compacted", [
    ...RUN.slice(0, 4).flatMap((s) => [entryCall(s), entryResult(s)]),
    // Trimmed from a real compaction (CLI 2.1.291).
    { parentUuid: null, logicalParentUuid: "f2b0a17a", isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted", isMeta: false, level: "info", compactMetadata: { trigger: "auto", preTokens: 166509 } },
    { parentUuid: "c02ee4d5", isSidechain: false, type: "user", message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." }, isVisibleInTranscriptOnly: true, isCompactSummary: true, userType: "external" },
    ...RUN.slice(5, 6).flatMap((s) => [entryCall(s), entryResult(s)]),
  ]);
  const state = seedTasks(NO_TASKS, (await loadTranscript("compacted", cwd)) as any);
  assert.deepEqual(state.tasks.map((t) => `#${t.id} ${t.status} ${t.subject}`), [
    "#1 completed Write the parser",
    "#2 pending Add tests",
    "#3 pending Update docs",
  ]);
});
