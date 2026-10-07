/**
 * The sub-agents a Claude Code thread has run, for the subagent panel.
 *
 * Driven by the SDK's task events, which the server forwards as `system`
 * events ({ subtype, data }): `task_started` opens a row, `task_updated` and
 * `task_notification` close it. The Agent tool's own result is no finish
 * signal — a background sub-agent's comes back "async launched" at once —
 * so it is never read here.
 *
 * The transcript keeps none of those events. On load, the server rebuilds each
 * sub-agent from the Agent call and what ended it, and `seedSubagents` merges
 * that in.
 *
 * Only top-level sub-agents count: `local_agent` tasks at spawn depth 1. A
 * sub-agent's own shells (`local_bash`) and the agents it spawns are not rows.
 */

import type { HistoryMsg } from "./gitbot";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export type Subagent = {
  taskId: string;
  toolUseId?: string;
  description: string;
  /** The subagent_type it ran as, e.g. "Explore". */
  type?: string;
  status: SubagentStatus;
};

const ENDED: Record<string, SubagentStatus> = {
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  killed: "stopped",
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * The list after one `system` event. Unrelated events return `prev` itself, so
 * a caller can skip the re-render. Safe to replay: a rejoin re-sends the turn's
 * events in order, so a start re-opens a row and the end after it settles it
 * again, as before; a start with no end yet is a run still going.
 */
export function nextSubagents(prev: Subagent[], ev: { subtype?: unknown; data?: any }): Subagent[] {
  const d = ev.data;
  if (!d || typeof d !== "object") return prev;
  const taskId = str(d.task_id);
  if (!taskId) return prev;

  if (ev.subtype === "task_started") {
    if (d.task_type !== "local_agent" || (d.spawn_depth ?? 1) !== 1 || d.ambient) return prev;
    const toolUseId = str(d.tool_use_id);
    const i = prev.findIndex((s) => s.taskId === taskId || (toolUseId && s.toolUseId === toolUseId));
    // A start for a row that is not running is a new run: a sub-agent resumed
    // (SendMessage) starts again under the same task id, and a row history
    // guessed stopped turns out to be going. The next end sets the outcome.
    if (i >= 0 && prev[i].status !== "running") {
      const next = prev.slice();
      next[i] = { ...prev[i], status: "running" };
      return next;
    }
    if (i >= 0) return prev;
    return [
      ...prev,
      {
        taskId,
        toolUseId: str(d.tool_use_id),
        description: str(d.description) ?? "Sub-agent",
        type: str(d.subagent_type),
        status: "running",
      },
    ];
  }

  // An end. task_updated carries it as a patch; task_notification as a status.
  // Either may come alone, and both may come: the first one settles it.
  const raw = ev.subtype === "task_updated" ? d.patch?.status : ev.subtype === "task_notification" ? d.status : undefined;
  const status = typeof raw === "string" ? ENDED[raw] : undefined;
  if (!status) return prev;
  const toolUseId = str(d.tool_use_id);
  const i = prev.findIndex((s) => s.taskId === taskId || (toolUseId && s.toolUseId === toolUseId));
  // A row gitbot stopped itself (see stopRunning) still takes the real outcome
  // if one turns up later; an outcome the SDK already gave is final.
  if (i < 0 || (prev[i].status !== "running" && prev[i].status !== "stopped") || prev[i].status === status) return prev;
  const next = prev.slice();
  next[i] = { ...prev[i], status };
  return next;
}

/**
 * The panel's collapsed line. "Finished" only when every one completed; any
 * that failed or stopped are counted, so an ended list never reads as done.
 */
export function subagentSummary(list: readonly Subagent[]): string {
  const running = list.filter((s) => s.status === "running");
  if (running.length === 1) return running[0].description;
  if (running.length > 1) return `${running.length} sub-agents running`;
  const n = `${list.length} sub-agent${list.length === 1 ? "" : "s"}`;
  const failed = list.filter((s) => s.status === "failed").length;
  const stopped = list.filter((s) => s.status === "stopped").length;
  if (!failed && !stopped) return `${n} finished`;
  const parts = [failed && `${failed} failed`, stopped && `${stopped} stopped`].filter(Boolean);
  return `${n} · ${parts.join(", ")}`;
}

/**
 * Every row still running, marked stopped. For a turn that ended without
 * finishing them — Stop, an error — since no finish event will come.
 */
export function stopRunning(prev: Subagent[]): Subagent[] {
  if (!prev.some((s) => s.status === "running")) return prev;
  return prev.map((s) => (s.status === "running" ? { ...s, status: "stopped" } : s));
}

/**
 * The list after loading a transcript (see the server's loadTranscript): every
 * top-level sub-agent the thread ever ran, in order, merged with `prev`.
 *
 * One with no end on record shows stopped, never running: history cannot tell
 * a run still going from one cut off. A live turn sets it right — its
 * task_started replay revives the row (nextSubagents). Live rows win and keep
 * their place. History's real outcome settles only a row live left stopped
 * (Stop, a lost connection): a running row exists only mid-turn, when the
 * transcript is behind it — it may even hold a resumed sub-agent's last run.
 * Live rows the transcript does not have yet stay, after.
 * Like the plan, a load never clears: a thread switch does that.
 */
export function seedSubagents(prev: Subagent[], messages: readonly HistoryMsg[]): Subagent[] {
  const seen: Subagent[] = [];
  for (const m of messages) {
    for (const b of m.content || []) {
      const r = b.subagent;
      if (!r || !b.tool_use_id) continue;
      seen.push({
        taskId: r.taskId ?? b.tool_use_id,
        toolUseId: b.tool_use_id,
        description: r.description,
        type: r.type,
        status: r.status ?? "stopped",
      });
    }
  }
  if (!seen.length) return prev;
  const same = (a: Subagent, b: Subagent) => a.taskId === b.taskId || (!!a.toolUseId && a.toolUseId === b.toolUseId);
  const merged = seen.map((h) => {
    const live = prev.find((p) => same(p, h));
    if (!live) return h;
    const known = h.status === "completed" || h.status === "failed";
    return known && live.status === "stopped" ? { ...live, status: h.status } : live;
  });
  const rest = prev.filter((p) => !seen.some((h) => same(p, h)));
  const next = [...merged, ...rest];
  return next.length === prev.length && next.every((s, i) => s === prev[i]) ? prev : next;
}
