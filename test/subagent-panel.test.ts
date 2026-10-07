import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessage } from "../src/start-claude-code";
import { nextSubagents, stopRunning, subagentSummary, type Subagent } from "../ui/app/lib/subagents";

// The subagent panel is driven by the SDK's task events, forwarded as
// `system` events. Shapes below are trimmed from a real run (SDK 0.3.291).

const started = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  description: `Agent ${taskId}`,
  subagent_type: "general-purpose",
  is_backgrounded: true,
  spawn_depth: 1,
  task_type: "local_agent",
  prompt: "…",
  ...extra,
});
const updated = (taskId: string, status: string) => ({
  type: "system", subtype: "task_updated", task_id: taskId, patch: { status, end_time: 1 },
});
const notified = (taskId: string, status: string, extra: Record<string, unknown> = {}) => ({
  type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: `toolu_${taskId}`,
  status, output_file: "", summary: "", ...extra,
});

/** What the browser receives: formatMessage's payload, as emitted. */
const wire = (msg: any) => formatMessage(msg) as { subtype?: unknown; data?: any };
const run = (msgs: any[], from: Subagent[] = []) => msgs.reduce((acc, m) => nextSubagents(acc, wire(m)), from);

test("the server forwards task events with their subtype and data", () => {
  const p = wire(started("a"));
  assert.equal((p as any).type, "system");
  assert.equal(p.subtype, "task_started");
  assert.equal(p.data.task_id, "a");
});

test("a sub-agent opens running and is closed by its notification", () => {
  const list = run([started("a")]);
  assert.deepEqual(list, [
    { taskId: "a", toolUseId: "toolu_a", description: "Agent a", type: "general-purpose", status: "running" },
  ]);
  assert.equal(run([started("a"), notified("a", "completed")])[0].status, "completed");
  assert.equal(run([started("a"), updated("a", "completed")])[0].status, "completed");
});

test("parallel sub-agents end independently, in any order", () => {
  const list = run([started("a"), started("b"), started("c"), notified("b", "completed"), notified("a", "failed")]);
  assert.deepEqual(list.map((s) => [s.taskId, s.status]), [["a", "failed"], ["b", "completed"], ["c", "running"]]);
});

test("a sub-agent's shells and nested agents are not rows", () => {
  const list = run([
    started("a"),
    started("bash1", { task_type: "local_bash", owned_by_subagent: true, spawn_depth: undefined }),
    started("nested", { spawn_depth: 2 }),
    started("w", { ambient: true }),
  ]);
  assert.deepEqual(list.map((s) => s.taskId), ["a"]);
  // A shell's own notification touches nothing.
  assert.equal(run([notified("bash1", "completed")], list), list);
});

test("replaying the same events (a rejoin) changes nothing", () => {
  const events = [started("a"), updated("a", "completed"), notified("a", "completed")];
  const once = run(events);
  assert.equal(run(events, once), once);
});

test("killed reads as stopped; non-terminal patches are ignored", () => {
  assert.equal(run([started("a"), updated("a", "killed")])[0].status, "stopped");
  assert.equal(run([started("a"), updated("a", "paused")])[0].status, "running");
});

test("an outcome the SDK gave is final", () => {
  assert.equal(run([started("a"), notified("a", "failed"), notified("a", "completed")])[0].status, "failed");
});

test("Stop or an error marks running rows stopped, leaving ended ones", () => {
  const list = run([started("a"), started("b"), notified("a", "completed")]);
  assert.deepEqual(stopRunning(list).map((s) => s.status), ["completed", "stopped"]);
  const settled = stopRunning(list);
  assert.equal(stopRunning(settled), settled);
});

test("a row gitbot stopped still takes a real outcome that arrives later", () => {
  const stopped = stopRunning(run([started("a")]));
  assert.equal(run([notified("a", "completed")], stopped)[0].status, "completed");
});

test("a background sub-agent outliving the turn's first result still finishes", () => {
  // Real order: launch, the main agent's result, then the sub-agent's end
  // on the same stream before it closes.
  const list = run([
    started("a"),
    { type: "result", subtype: "success", result: "launched", total_cost_usd: 0, duration_ms: 1, num_turns: 1 },
    updated("a", "completed"),
    notified("a", "completed"),
    { type: "system", subtype: "init", session_id: "s" },
  ]);
  assert.equal(list[0].status, "completed");
});

test("any turn end (a lost connection too) stops running rows; a rejoin replay restores the outcome", () => {
  // The connection drops mid-run: finish() stops what is still running.
  const events = [started("a"), started("b"), notified("a", "completed")];
  const dropped = stopRunning(run(events));
  assert.deepEqual(dropped.map((s) => s.status), ["completed", "stopped"]);
  // Rejoining replays the whole turn, now including b's real end.
  const rejoined = run([...events, notified("b", "completed")], dropped);
  assert.deepEqual(rejoined.map((s) => s.status), ["completed", "completed"]);
});

test("the collapsed line never calls a failed or stopped list finished", () => {
  const [a, b, c] = ["a", "b", "c"];
  assert.equal(subagentSummary(run([started(a)])), "Agent a");
  assert.equal(subagentSummary(run([started(a), started(b)])), "2 sub-agents running");
  assert.equal(subagentSummary(run([started(a), notified(a, "completed")])), "1 sub-agent finished");
  const mixed = stopRunning(run([started(a), started(b), started(c), notified(a, "completed"), notified(b, "failed")]));
  assert.equal(subagentSummary(mixed), "3 sub-agents · 1 failed, 1 stopped");
  assert.equal(subagentSummary(stopRunning(run([started(a)]))), "1 sub-agent · 1 stopped");
});
