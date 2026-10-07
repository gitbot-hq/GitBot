import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatMessage, loadTranscript } from "../src/start-claude-code";
import { nextSubagents, seedSubagents, stopRunning, type Subagent } from "../ui/app/lib/subagents";

// Rebuilding the subagent panel from a transcript. The entries below are
// trimmed from real runs (CLI 2.1.291): only fields the loader reads, plus
// enough around them to look like the real thing.

const configDir = mkdtempSync(join(tmpdir(), "gitbot-subagent-history-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
const cwd = "/work/subagents";

function transcript(id: string, entries: unknown[]): void {
  const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
}

const at = "2026-10-07T13:11:41.408Z";
const userPrompt = (text: string) => ({ type: "user", userType: "external", isSidechain: false, message: { role: "user", content: text }, timestamp: at });
const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant", userType: "external", isSidechain: false, timestamp: at,
  message: { role: "assistant", content: [{ type: "text", text }] }, ...extra,
});
const agentCall = (id: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "assistant", userType: "external", isSidechain: false, timestamp: at,
  message: { type: "message", role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input, caller: { type: "direct" } }] },
  ...extra,
});
const toolResult = (id: string, content: unknown, toolUseResult: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user", userType: "external", isSidechain: false, timestamp: at,
  message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, ...(extra.is_error ? { is_error: true } : {}) }] },
  toolUseResult,
  ...(extra.toolDenialKind ? { toolDenialKind: extra.toolDenialKind } : {}),
});
const launched = (id: string, agentId: string, description: string) =>
  toolResult(id, [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)` }], {
    isAsync: true, status: "async_launched", agentId, description, resolvedModel: "claude-haiku-4-5-20251001", canReadOutputFile: true,
  });
const notification = (agentId: string, toolUseId: string, status: string, description: string) =>
  `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
  `<output-file>/private/tmp/claude-501/x/tasks/${agentId}.output</output-file>\n<status>${status}</status>\n` +
  `<summary>Agent "${description}" finished</summary>\n<note>A task-notification fires each time this agent stops.</note>\n` +
  `<result>alpha</result>\n<usage><subagent_tokens>11532</subagent_tokens><tool_uses>0</tool_uses><duration_ms>1148</duration_ms></usage>\n</task-notification>`;
/** The end woke the main agent: a user turn of its own. */
const notifiedTurn = (text: string) => ({
  type: "user", userType: "external", isSidechain: false, timestamp: at,
  message: { role: "user", content: text },
  permissionMode: "default", origin: { kind: "task-notification", producer: "session-task" },
  promptSource: "system", turnOrigin: "task_notification", queueSkipAttachments: true,
});
/** The end landed mid-turn: absorbed as a queued command. */
const queued = (text: string) => ({
  type: "attachment", userType: "external", isSidechain: false, timestamp: at,
  attachment: { type: "queued_command", prompt: text, commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" } },
});
const enqueued = (text: string) => ({ type: "queue-operation", operation: "enqueue", timestamp: at, content: text });

/** Every subagent record in a loaded transcript, in order. */
async function load(id: string) {
  const messages = await loadTranscript(id, cwd);
  const rows = messages.flatMap((m) => m.content.filter((b: any) => b.subagent).map((b: any) => ({ id: b.tool_use_id, ...b.subagent })));
  return { messages, rows };
}

test("a foreground sub-agent reads as completed from its tool_result", async () => {
  transcript("fg", [
    userPrompt("run one"),
    agentCall("toolu_fg", { run_in_background: false, subagent_type: "general-purpose", model: "haiku", description: "Fg delta", prompt: "…" }),
    toolResult("toolu_fg", [{ type: "text", text: "[Subagent hand-back] …\nagentId: aeac72ced0bc493a4" }], {
      status: "completed", agentId: "aeac72ced0bc493a4", agentType: "general-purpose",
      content: [{ type: "text", text: "delta" }], totalDurationMs: 3462, totalTokens: 13668, totalToolUseCount: 1,
    }),
    reply("Done."),
  ]);
  const { rows, messages } = await load("fg");
  assert.deepEqual(rows, [{ id: "toolu_fg", description: "Fg delta", type: "general-purpose", taskId: "aeac72ced0bc493a4", status: "completed" }]);
  // The chip reads as the Agent call, not its raw JSON.
  const chip = messages.flatMap((m) => m.content).find((b: any) => b.tool_use_id === "toolu_fg");
  assert.equal(chip.tool_input, "[general-purpose] Fg delta");
});

test("background sub-agents end by notification, in each form the CLI records", async () => {
  const alpha = notification("acd216ab8f30cbee7", "toolu_a", "completed", "Echo alpha");
  const beta = notification("a320f0390f3bbfc73", "toolu_b", "failed", "Fail beta");
  const gamma = notification("ab553dc32fff23e53", "toolu_c", "killed", "Bg gamma");
  transcript("bg", [
    userPrompt("run three"),
    // Real order: the CLI logged alpha's enqueue ahead of the call itself.
    enqueued(alpha),
    agentCall("toolu_a", { description: "Echo alpha", prompt: "…", model: "haiku", subagent_type: "general-purpose" }),
    launched("toolu_a", "acd216ab8f30cbee7", "Echo alpha"),
    agentCall("toolu_b", { description: "Fail beta", prompt: "…", model: "haiku", subagent_type: "general-purpose" }),
    launched("toolu_b", "a320f0390f3bbfc73", "Fail beta"),
    agentCall("toolu_c", { description: "Bg gamma", prompt: "…", model: "haiku", subagent_type: "general-purpose" }),
    launched("toolu_c", "ab553dc32fff23e53", "Bg gamma"),
    queued(alpha),
    reply("Launched three."),
    enqueued(beta),
    notifiedTurn(beta),
    reply("Beta failed."),
    notifiedTurn(gamma),
    reply("Gamma was stopped."),
  ]);
  const { rows } = await load("bg");
  assert.deepEqual(rows.map((r) => [r.id, r.taskId, r.status]), [
    ["toolu_a", "acd216ab8f30cbee7", "completed"],
    ["toolu_b", "a320f0390f3bbfc73", "failed"],
    ["toolu_c", "ab553dc32fff23e53", "stopped"],
  ]);
});

test("a notification is not a chat bubble; the reply it woke still shows", async () => {
  const { messages } = await load("bg");
  const users = messages.filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => m.content[0].text), ["run three"]);
  assert.ok(!JSON.stringify(messages).includes("<task-notification>"));
  const texts = messages.flatMap((m) => m.content).filter((b: any) => b.type === "text").map((b: any) => b.text);
  assert.ok(texts.includes("Beta failed.") && texts.includes("Gamma was stopped."));
});

test("an interrupted call reads stopped; one with no end on record has no status", async () => {
  transcript("cut", [
    agentCall("toolu_slow", { run_in_background: false, subagent_type: "general-purpose", description: "Slow eps", prompt: "…" }),
    toolResult(
      "toolu_slow",
      "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
      "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
      { is_error: true, toolDenialKind: "interrupted" },
    ),
    agentCall("toolu_open", { run_in_background: true, subagent_type: "Explore", description: "Bg zeta", prompt: "…" }),
    launched("toolu_open", "a293b0e339ba3381d", "Bg zeta"),
  ]);
  const { rows } = await load("cut");
  assert.deepEqual(rows, [
    { id: "toolu_slow", description: "Slow eps", type: "general-purpose", status: "stopped" },
    { id: "toolu_open", description: "Bg zeta", type: "Explore", taskId: "a293b0e339ba3381d" },
  ]);
});

test("a sub-agent's own Agent calls and a denied call are not rows", async () => {
  transcript("skip", [
    agentCall("toolu_top", { description: "Top", subagent_type: "general-purpose", prompt: "…" }),
    agentCall("toolu_inner", { description: "Inner", subagent_type: "general-purpose", prompt: "…" }, { isSidechain: true }),
    toolResult("toolu_top", [{ type: "text", text: "ok" }], { status: "completed", agentId: "atop" }),
    agentCall("toolu_denied", { description: "Denied", subagent_type: "general-purpose", prompt: "…" }),
    toolResult("toolu_denied", "User denied", "Error: User denied", { is_error: true }),
  ]);
  const { rows } = await load("skip");
  assert.deepEqual(rows.map((r) => r.id), ["toolu_top"]);
});

// --- Merging history with the live list ---

const live = (taskId: string, toolUseId: string, status: Subagent["status"] = "running"): Subagent =>
  ({ taskId, toolUseId, description: `Agent ${taskId}`, type: "general-purpose", status });
const started = (taskId: string, toolUseId: string) => ({
  subtype: "task_started",
  data: { task_id: taskId, tool_use_id: toolUseId, description: `Agent ${taskId}`, subagent_type: "general-purpose", spawn_depth: 1, task_type: "local_agent" },
});
const ended = (taskId: string, toolUseId: string, status: string) => ({
  subtype: "task_notification", data: { task_id: taskId, tool_use_id: toolUseId, status },
});

test("a reopened thread lists every sub-agent; unfinished ones show stopped, never running", async () => {
  const list = seedSubagents([], (await load("bg")).messages);
  assert.deepEqual(list.map((s) => [s.taskId, s.toolUseId, s.status]), [
    ["acd216ab8f30cbee7", "toolu_a", "completed"],
    ["a320f0390f3bbfc73", "toolu_b", "failed"],
    ["ab553dc32fff23e53", "toolu_c", "stopped"],
  ]);
  const cut = seedSubagents([], (await load("cut")).messages);
  assert.deepEqual(cut.map((s) => s.status), ["stopped", "stopped"]);
  // Without an agent id, the tool call stands in for the task id.
  assert.equal(cut[0].taskId, "toolu_slow");
});

test("loading the same history again changes nothing", async () => {
  const { messages } = await load("bg");
  const once = seedSubagents([], messages);
  assert.equal(seedSubagents(once, messages), once);
  // And a transcript with no sub-agents leaves the list alone.
  const { messages: none } = await load("fg");
  const empty: Subagent[] = [];
  assert.equal(seedSubagents(empty, []), empty);
  assert.equal(seedSubagents(once, none.filter((m) => m.role === "user")), once);
});

test("rejoining a live turn: history first, then the replay, gives one running row", async () => {
  // History shows the launch with no end yet; the live replay re-sends its start.
  const seeded = seedSubagents([], (await load("cut")).messages);
  const rejoined = [started("a293b0e339ba3381d", "toolu_open")].reduce(nextSubagents, seeded);
  assert.deepEqual(rejoined.map((s) => [s.taskId, s.status]), [["toolu_slow", "stopped"], ["a293b0e339ba3381d", "running"]]);
  // Its live end settles it as usual.
  assert.equal(nextSubagents(rejoined, ended("a293b0e339ba3381d", "toolu_open", "completed"))[1].status, "completed");
});

test("rejoining a live turn: replay first, then history, keeps the live row and its place", async () => {
  const { messages } = await load("cut");
  const replayed = [live("a293b0e339ba3381d", "toolu_open"), live("newer", "toolu_new")];
  const merged = seedSubagents(replayed, messages);
  assert.deepEqual(merged.map((s) => [s.taskId, s.status]), [
    ["toolu_slow", "stopped"],
    ["a293b0e339ba3381d", "running"], // live wins over history's guess
    ["newer", "running"], // not in the transcript yet: kept, after
  ]);
  assert.equal(merged[1], replayed[0]);
});

test("history's real outcome settles a row live left stopped, never a running or ended one", async () => {
  const { messages } = await load("bg");
  // Live stopped alpha (Stop, a lost connection) and still runs b mid-turn.
  const prev = [live("acd216ab8f30cbee7", "toolu_a", "stopped"), live("a320f0390f3bbfc73", "toolu_b")];
  const merged = seedSubagents(prev, messages);
  assert.deepEqual(merged.map((s) => s.status), ["completed", "running", "stopped"]);
  // A live outcome is never overwritten by history.
  const done = [live("a320f0390f3bbfc73", "toolu_b", "completed")];
  assert.equal(seedSubagents(done, messages).find((s) => s.toolUseId === "toolu_b")!.status, "completed");
});

test("live task ids match the transcript's agent ids, so a live end finds a history row", async () => {
  const seeded = seedSubagents([], (await load("cut")).messages);
  // Real wire event, as the browser receives it.
  const ev = formatMessage({ type: "system", subtype: "task_notification", task_id: "a293b0e339ba3381d", tool_use_id: "toolu_open", status: "completed", output_file: "", summary: "" } as any) as any;
  assert.equal(nextSubagents(seeded, ev)[1].status, "completed");
  // And a turn end with history rows only marks nothing new.
  assert.equal(stopRunning(seeded), seeded);
});

// --- Review fixes ---

test("a resumed sub-agent: history then the live resume, and the replay then history", async () => {
  // Run 1 of alpha completed in an earlier turn; the agent then resumes it.
  const { messages } = await load("bg");
  const resume = started("acd216ab8f30cbee7", "toolu_a");
  // History first: the resume's start re-opens the row, its end settles it.
  const seeded = seedSubagents([], messages);
  const running = nextSubagents(seeded, resume);
  assert.equal(running[0].status, "running");
  assert.equal(nextSubagents(running, ended("acd216ab8f30cbee7", "toolu_a", "failed"))[0].status, "failed");
  // Replay first: history's run-1 "completed" must not end the live run.
  const replayed = nextSubagents([], resume);
  const merged = seedSubagents(replayed, messages);
  assert.equal(merged.find((s) => s.taskId === "acd216ab8f30cbee7")!.status, "running");
  assert.equal(merged.length, 3);
});

test("an interrupt reads stopped and a crash failed; only a denial drops the row", async () => {
  const err = (id: string, text: string, extra: Record<string, unknown> = {}) => toolResult(id, text, `Error: ${text}`, { is_error: true, ...extra });
  const call = (id: string) => agentCall(id, { description: id, subagent_type: "general-purpose", prompt: "…" });
  transcript("errors", [
    call("t_user_stop"), err("t_user_stop", "[Request interrupted by user for tool use]"),
    call("t_crash"), err("t_crash", "API Error: 529 overloaded"),
    call("t_crash_ran"), toolResult("t_crash_ran", "boom", { agentId: "aran", status: "error" }, { is_error: true }),
    call("t_gitbot_deny"), err("t_gitbot_deny", "User denied"),
    call("t_stop_deny"), err("t_stop_deny", "Request aborted"),
    call("t_cli_reject"), toolResult("t_cli_reject", "The user doesn't want to proceed with this tool use. The tool use was rejected.", "User rejected tool use", { is_error: true, toolDenialKind: "user-rejected" }),
    call("t_classifier"), toolResult("t_classifier", "Permission for this action was denied by the Claude Code auto mode classifier.", "Error: Permission for this action was denied", { is_error: true, toolDenialKind: "automode-blocked" }),
  ]);
  const { rows } = await load("errors");
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [
    ["t_user_stop", "stopped"],
    ["t_crash", "failed"],
    ["t_crash_ran", "failed"],
  ]);
});

test("an older CLI's notification (task id only, no origin) settles the row and is not a bubble", async () => {
  // CLI 2.1.42 shape: no <tool-use-id>, no origin, a trailing line after the tag.
  const old = (taskId: string, status: string) =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<output-file>/private/tmp/claude-501/x/tasks/${taskId}.output</output-file>\n` +
    `<status>${status}</status>\n<summary>Agent "Old" completed</summary>\n</task-notification>\n` +
    `Read the output file to retrieve the result: /private/tmp/claude-501/x/tasks/${taskId}.output`;
  transcript("old", [
    userPrompt("run it"),
    agentCall("toolu_old", { description: "Old", subagent_type: "general-purpose", prompt: "…", run_in_background: true }),
    launched("toolu_old", "a1b2c3d4", "Old"),
    reply("Launched."),
    enqueued(old("a1b2c3d4", "completed")),
    { type: "user", userType: "external", isSidechain: false, timestamp: at, message: { role: "user", content: old("a1b2c3d4", "completed") } },
    reply("It finished."),
    // A background shell's notice names a task no Agent row has: ignored, still hidden.
    { type: "user", userType: "external", isSidechain: false, timestamp: at, message: { role: "user", content: old("b1825f7", "completed") } },
    // A user who merely mentions the tag mid-message keeps their bubble.
    userPrompt("what is a <task-notification>?"),
  ]);
  const { rows, messages } = await load("old");
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [["toolu_old", "completed"]]);
  const users = messages.filter((m) => m.role === "user").map((m) => m.content[0].text);
  assert.deepEqual(users, ["run it", "what is a <task-notification>?"]);
});
