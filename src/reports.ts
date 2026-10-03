import { basename } from "path";
import { getBot, getThread } from "./bot-store";
import { onTurnEnd, type EndedTurn, type StoredEvent } from "./server-common";
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
  if (turn.abortRequested || events.some((e) => e.type === "aborted")) return null;
  const child = turn.threadId ? getThread(turn.threadId) : undefined;
  if (!child?.reportTo) return null;
  let message = lastAssistantMessage(events);
  if (!message && status === "error") {
    const err = [...events].reverse().find((e) => e.type === "error" || e.type === "agent_error");
    message = String((err as any)?.message ?? "");
  }
  const bot = getBot(child.botId)?.name ?? "Bot";
  return { owner: child.reportTo, child: child.id, prompt: formatReport(bot, basename(child.repoPath), child.id, status, message) };
}

/**
 * Starts the owning Jarvis thread's report turn. A Jarvis that is still mid-
 * turn refuses it (409), and the report is dropped — parked:
 * docs/issues/future/report-collides-with-jarvis-turn.md.
 */
export function deliverReport(turn: EndedTurn, availableAgents: readonly string[]): void {
  const report = reportFor(turn);
  if (!report) return;
  let refused: string;
  try {
    const turn = startTurn({ threadId: report.owner, prompt: report.prompt, report: true }, availableAgents);
    if (turn.ok) {
      console.log(`[report] thread ${report.child} reported to Jarvis thread ${report.owner}`);
      return;
    }
    refused = `${turn.status} ${turn.message}`;
  } catch (err: any) {
    refused = err?.message ?? "failed to start";
  }
  console.warn(`[report] dropped: thread ${report.child} finished, but Jarvis thread ${report.owner} refused its report (${refused})`);
}

/** Wires reports to every turn end, whichever agent ran it. Call once at start. */
export function watchChildReports(availableAgents: readonly string[]): () => void {
  return onTurnEnd((_store, turn) => deliverReport(turn, availableAgents));
}
