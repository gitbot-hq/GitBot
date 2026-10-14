import { basename } from "path";
import { getBot, getThread, listThreads, markThreadSeen, setQueuedReports, setThreadActivity, type QueuedReport } from "./bot-store";
import { isShuttingDown, onTurnEnd, sessions, turnStopped, type EndedTurn, type StoredEvent } from "./server-common";
import { startTurn } from "./turns";

// A finished child wakes its Jarvis: when a turn ends in a thread Jarvis
// started, the child's last word goes to the owning Jarvis thread as a new
// turn. The child never knows; nothing it has to call.

/** About how much of a child's last message Jarvis is given. */
export const REPORT_CAP = 4000;

/** The endings that wake Jarvis. A stop is the user's, so it never does. */
export type ReportStatus = "done" | "error";

/**
 * The child's last top-level assistant message: what the turn ended saying.
 * A sub-agent's words are not the child's answer, so events from inside a
 * task are left out (as the setup verdict does).
 */
export function lastAssistantMessage(events: readonly StoredEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as StoredEvent & { content?: unknown; parent_tool_use_id?: unknown };
    if (e.type !== "assistant" || e.parent_tool_use_id) continue;
    const text = String(e.content ?? "").trim();
    if (text) return text;
  }
  return "";
}

/** Caps a report's body, saying so when it cut. */
export function capReport(text: string, cap = REPORT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap).trimEnd()}\n\n[report truncated: ${text.length - cap} more characters; the rest is in the child's thread]`;
}

/** The report Jarvis receives. The header is how the UI knows it is a report. */
export function formatReport(bot: string, project: string, threadId: string, status: ReportStatus, message: string): string {
  return `[${bot} · ${project} · thread ${threadId} · ${status}]\n${capReport(message) || "(no message)"}`;
}

/** The report an ended turn makes, or null when it wakes no one. */
export function reportFor(turn: EndedTurn): { owner: string; prompt: string; child: string } | null {
  const { status, events } = turn;
  // Only a turn Jarvis started reports; one the user typed into the child does not.
  if (!turn.reportable) return null;
  if (status !== "done" && status !== "error") return null;
  // Stopped by the user: the sequence stops with it (slice 08 builds Stop).
  if (turnStopped(turn)) return null;
  // The owner as the turn started: a later change of hands does not redirect it.
  const owner = turn.reportOwner;
  const child = turn.threadId ? getThread(turn.threadId) : undefined;
  if (!owner || !child) return null;
  let message = lastAssistantMessage(events);
  if (!message && status === "error") {
    const err = [...events].reverse().find((e) => e.type === "error" || e.type === "agent_error");
    message = String((err as any)?.message ?? "");
  }
  const bot = getBot(child.botId)?.name ?? "Bot";
  return { owner, child: child.id, prompt: formatReport(bot, basename(child.repoPath), child.id, status, message) };
}

/**
 * True while the Jarvis thread has a turn of its own running: the one refusal
 * a report waits out. The same scan startTurn's 409s make.
 */
export function jarvisIsMidTurn(jarvisThreadId: string): boolean {
  const sdk = getThread(jarvisThreadId)?.sdkSessionId;
  if (sdk && sessions.get(sdk)?.status === "running") return true;
  return [...sessions.values()].some((s) => s.threadId === jarvisThreadId && s.status === "running");
}

/** Starts a report turn on a Jarvis thread: "started", "busy" (Jarvis is mid-turn), or why it was refused. */
function startReportTurn(
  owner: string,
  prompt: string,
  availableAgents: readonly string[],
): { started: true } | { started: false; busy: boolean; agentMissing: boolean; refused: string } {
  try {
    const started = startTurn({ threadId: owner, prompt, report: true }, availableAgents);
    if (started.ok) return { started: true };
    return {
      started: false,
      // "Jarvis is mid-turn": worth waiting for, until that turn ends.
      busy: started.status === 409 && jarvisIsMidTurn(owner),
      // Claude Code not usable right now (this start found no CLI): worth
      // keeping for a later start. Anything else would refuse it again.
      agentMissing: !!started.extra?.agentUnavailable,
      refused: `${started.status} ${started.message}`,
    };
  } catch (err: any) {
    return { started: false, busy: false, agentMissing: false, refused: err?.message ?? "failed to start" };
  }
}

/**
 * Starts the owning Jarvis thread's report turn. A Jarvis that is still mid-
 * turn refuses it (409): the report is queued on the Jarvis thread instead,
 * and starts once that turn ends (deferred-turns.ts). Queued counts as
 * delivered: Jarvis is sure to hear it, so the child is seen and makes no
 * push of its own. Any other refusal drops it, as before.
 */
export function deliverReport(turn: EndedTurn, availableAgents: readonly string[]): void {
  // A child our own shutdown killed did not finish; the next start notes it.
  if (isShuttingDown()) return;
  const report = reportFor(turn);
  if (!report) return;
  // Older reports are waiting on this Jarvis thread: this one goes behind
  // them, never ahead. If the thread is free now (Jarvis's turn ended in the
  // same batch as this child's), the deferred-turn drain for this child's
  // end starts the oldest (deferred-turns.ts drains the owner too).
  if (getThread(report.owner)?.queuedReports?.length) {
    if (queueReport(turn, report, "older reports are waiting")) return;
  }
  const result = startReportTurn(report.owner, report.prompt, availableAgents);
  if (result.started) {
    console.log(`[report] thread ${report.child} reported to Jarvis thread ${report.owner}`);
    reportedIsSeen(turn, report.child);
    return;
  }
  if (result.busy) {
    if (queueReport(turn, report, "Jarvis is mid-turn")) return;
    result.refused = "its thread is gone";
  }
  console.warn(`[report] dropped: thread ${report.child} finished, but Jarvis thread ${report.owner} refused its report (${result.refused})`);
}

/**
 * Queues a report behind its Jarvis thread's turn. Queued counts as
 * delivered: Jarvis is sure to hear it, so the child is seen and makes no
 * push of its own. False when the Jarvis thread is gone.
 */
function queueReport(turn: EndedTurn, report: { owner: string; prompt: string; child: string }, why: string): boolean {
  const entry: QueuedReport = { childThreadId: report.child, prompt: report.prompt, at: new Date().toISOString() };
  if (!setQueuedReports(report.owner, (queue) => [...queue, entry])) return false;
  console.log(`[report] queued: thread ${report.child} → Jarvis thread ${report.owner} (${why})`);
  reportedIsSeen(turn, report.child);
  return true;
}

/**
 * Starts the oldest report queued on a Jarvis thread, if the thread is free.
 * True when one started; false when none is queued, gitbot is shutting down,
 * or Jarvis is mid-turn again (the user's message got in first: the report
 * waits for that turn's end). A queued report that is refused for any other
 * reason is dropped with a log line, and the next one is tried.
 */
export function deliverQueuedReport(jarvisThreadId: string, availableAgents: readonly string[]): boolean {
  for (;;) {
    if (isShuttingDown()) return false;
    const queue = getThread(jarvisThreadId)?.queuedReports;
    if (!Array.isArray(queue) || queue.length === 0) return false;
    const next = queue[0];
    if (!isQueuedReport(next)) {
      // Hand-edited, or from a future version: nothing to start. Dropped so it can't block the rest.
      setQueuedReports(jarvisThreadId, (q) => (q.length && !isQueuedReport(q[0]) ? q.slice(1) : q));
      console.warn(`[report] dropped: a malformed queued report on Jarvis thread ${jarvisThreadId}`);
      reportNotDelivered((next as Partial<QueuedReport> | null)?.childThreadId);
      continue;
    }
    const result = startReportTurn(jarvisThreadId, next.prompt, availableAgents);
    if (!result.started && result.busy) return false;
    if (!result.started && result.agentMissing) {
      console.warn(`[report] kept: thread ${next.childThreadId}'s queued report waits on Jarvis thread ${jarvisThreadId} (${result.refused})`);
      return false;
    }
    // Off the queue the moment it starts (or is refused), in the same tick: never both queued and started.
    setQueuedReports(jarvisThreadId, (queue) => {
      const i = queue.findIndex((q) => sameReport(q, next));
      return i < 0 ? queue : [...queue.slice(0, i), ...queue.slice(i + 1)];
    });
    if (result.started) {
      console.log(`[report] thread ${next.childThreadId} reported to Jarvis thread ${jarvisThreadId} (queued since ${next.at})`);
      return true;
    }
    console.warn(`[report] dropped: thread ${next.childThreadId}'s queued report, Jarvis thread ${jarvisThreadId} refused it (${result.refused})`);
    reportNotDelivered(next.childThreadId);
  }
}

/**
 * A queued report counted as delivered, and then was not: Jarvis will never
 * hear it, so the child's result is news again (its unread dot comes back).
 */
function reportNotDelivered(childThreadId: string | undefined): void {
  if (typeof childThreadId !== "string") return;
  try {
    const child = getThread(childThreadId);
    if (!child) return;
    // Later than the seen stamp queueing left, even within the same millisecond.
    const seen = child.lastSeenAt ? Date.parse(child.lastSeenAt) : 0;
    const at = new Date(Math.max(Date.now(), seen + 1)).toISOString();
    setThreadActivity(child.id, at, undefined, child.lastOutcome);
  } catch (err: any) {
    console.error(`[report] thread ${childThreadId}: ${err?.message ?? err}`);
  }
}

function isQueuedReport(value: unknown): value is QueuedReport {
  const q = value as QueuedReport | null;
  return !!q && typeof q === "object" && typeof q.prompt === "string" && !!q.prompt && typeof q.childThreadId === "string";
}

function sameReport(a: QueuedReport, b: QueuedReport): boolean {
  return a.childThreadId === b.childThreadId && a.at === b.at && a.prompt === b.prompt;
}

/**
 * At startup, before the server listens: delivers each report a restart
 * left queued. No turn runs yet, so each Jarvis thread is free and takes
 * its oldest one now; the rest follow turn by turn (deferred-turns.ts).
 * Never throws: a failed delivery must not stop gitbot starting.
 */
export function deliverQueuedReports(availableAgents: readonly string[]): number {
  let started = 0;
  try {
    for (const thread of listThreads()) {
      if (!Array.isArray(thread.queuedReports) || !thread.queuedReports.length) continue;
      try {
        if (deliverQueuedReport(thread.id, availableAgents)) started++;
      } catch (err: any) {
        console.error(`[report] queued reports on Jarvis thread ${thread.id}: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    console.error(`[report] queued reports skipped: ${err?.message ?? err}`);
  }
  return started;
}

/**
 * A thread Jarvis started counts as seen once its result is in front of
 * Jarvis: its report turn has started on the Jarvis thread. The user reads it
 * there, so the child's own dot, in its bot's list and in "Started N
 * threads", would only pile up. A report queued behind Jarvis's own turn
 * counts too: it is sure to start. A report Jarvis refused is not
 * delivered, and a stopped child makes none: those keep their dot.
 *
 * Either turn-end listener may run first. If the activity stamp already ran,
 * seen is stamped no earlier than it; if not, it reads the flag and stamps
 * seen with its own time (attention.ts).
 */
function reportedIsSeen(turn: EndedTurn, childId: string): void {
  turn.reportDelivered = true;
  const now = new Date().toISOString();
  const stamped = getThread(childId)?.lastActivityAt;
  markThreadSeen(childId, stamped && stamped > now ? stamped : now);
}

/** Wires reports to every turn end, whichever agent ran it. Call once at start. */
export function watchChildReports(availableAgents: readonly string[]): () => void {
  return onTurnEnd((_store, turn) => deliverReport(turn, availableAgents));
}
