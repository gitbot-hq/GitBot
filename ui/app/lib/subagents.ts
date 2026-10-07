/**
 * The sub-agents a Claude Code thread has run, for the subagent panel.
 *
 * Driven by the SDK's task events, which the server forwards as `system`
 * events ({ subtype, data }): `task_started` opens a row, `task_updated` and
 * `task_notification` close it. The Agent tool's own result is no finish
 * signal — a background sub-agent's comes back "async launched" at once —
 * so it is never read here.
 *
 * Only top-level sub-agents count: `local_agent` tasks at spawn depth 1. A
 * sub-agent's own shells (`local_bash`) and the agents it spawns are not rows.
 */

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
 * events, and a start already seen or an end already applied changes nothing.
 */
export function nextSubagents(prev: Subagent[], ev: { subtype?: unknown; data?: any }): Subagent[] {
  const d = ev.data;
  if (!d || typeof d !== "object") return prev;
  const taskId = str(d.task_id);
  if (!taskId) return prev;

  if (ev.subtype === "task_started") {
    if (d.task_type !== "local_agent" || (d.spawn_depth ?? 1) !== 1 || d.ambient) return prev;
    if (prev.some((s) => s.taskId === taskId)) return prev;
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
