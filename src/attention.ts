import { getBot, getThread, isJarvisBot, markThreadSeen, setThreadActivity, type TurnOutcome } from "./bot-store";
import { lastAssistantMessage } from "./reports";
import { isShuttingDown, onTurnEnd, turnStopped, type EndedTurn, type StoredEvent } from "./server-common";

// Attention signals, the server's part. "Has news" on a thread is
// lastActivityAt > lastSeenAt: a turn there ended since anyone last viewed
// it, and lastOutcome says how (the thread list's green, red or grey dot).
// The turn end stamps both (and, on a Jarvis thread, the preview, with what
// Jarvis last said) before the session snapshot goes out, so a UI that
// refetches the thread list on that snapshot already sees it. "Needs you" is
// not stored: the UI reads it from the approvals in the same snapshot.

/** The opening line of what a turn ended saying, as a thread-list preview. */
export function latestLine(message: string, cap = 140): string {
  const line = message
    .split("\n")
    // Code fences and horizontal rules say nothing on their own.
    .filter((l) => !/^\s*(?:```|~~~)/.test(l) && !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(l))
    .map((l) => l.replace(/^\s*#+\s*/, "").replace(/^\s*(?:[-*>]|\d+\.)\s+/, "").replace(/[*_`]{2,}/g, "").trim())
    .find(Boolean);
  return line ? line.slice(0, cap) : "";
}

/** This turn's events: the session's, from its last prompt on (a session's store outlives its turns). */
function thisTurn(events: readonly StoredEvent[]): readonly StoredEvent[] {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "user_prompt") return events.slice(i + 1);
  return events;
}

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: "it reached its turn limit",
  error_max_budget_usd: "it reached its budget",
  error_during_execution: "it failed while running",
  error_max_structured_output_retries: "it couldn't produce the output asked for",
};

/**
 * The error a Claude Code turn's result reports, or null when it reports none:
 * one of the error subtypes (out of turns or budget, a failure mid-run), or a
 * "success" that is_error (the turn ended on an API error). Its status is
 * still "done": the harness ended normally, but the work did not.
 */
export function resultError(events: readonly StoredEvent[]): string | null {
  const turn = thisTurn(events);
  for (let i = turn.length - 1; i >= 0; i--) {
    const e = turn[i] as StoredEvent & { subtype?: unknown; is_error?: unknown; result?: unknown; errors?: unknown };
    if (e.type !== "result") continue;
    if (e.subtype === "success") {
      if (e.is_error !== true) return null;
      return (typeof e.result === "string" && e.result.trim()) || "it ended on an API error";
    }
    const errors = Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
    return errors[0] ?? RESULT_ERRORS[String(e.subtype)] ?? `it stopped early (${String(e.subtype)})`;
  }
  return null;
}

/**
 * What went wrong in a failed turn, as one line: the last error event's
 * message, else the error its result reports. Empty when neither says.
 */
export function errorLine(turn: Pick<EndedTurn, "events">, cap = 140): string {
  const events = thisTurn(turn.events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as StoredEvent & { message?: unknown };
    if (e.type === "error" && typeof e.message === "string" && e.message.trim()) return latestLine(e.message, cap);
  }
  const fromResult = resultError(turn.events);
  return fromResult ? latestLine(fromResult, cap) : "";
}

/**
 * How a turn ended. A turn the user aborted is stopped, not failed; one whose
 * result reports an error (resultError) failed, whatever its status says.
 */
export function turnOutcome(turn: EndedTurn): TurnOutcome {
  if (turnStopped(turn)) return "stopped";
  if (turn.status === "error") return "failed";
  return resultError(turn.events) ? "failed" : "done";
}

/** Stamps a thread's activity when a turn on it ends; a Jarvis thread's preview too. */
export function noteThreadActivity(turn: EndedTurn, at: string = new Date().toISOString()): void {
  // A turn our own shutdown killed did not end on its own: nothing to tell.
  if (isShuttingDown()) return;
  if (!turn.threadId) return;
  const thread = getThread(turn.threadId);
  if (!thread) return;
  // Other threads keep their preview: the prompt that started the turn.
  const preview = isJarvisBot(getBot(thread.botId)) ? latestLine(lastAssistantMessage(turn.events)) || undefined : undefined;
  setThreadActivity(thread.id, at, preview, turnOutcome(turn));
  // Its report is with Jarvis already (reports.ts): seen.
  if (turn.reportDelivered) markThreadSeen(thread.id, at);
}

/** Wires activity stamps to every turn end, whichever agent ran it. Call once at start. */
export function watchThreadActivity(): () => void {
  return onTurnEnd((_store, turn) => {
    try {
      noteThreadActivity(turn);
    } catch (err: any) {
      console.error(`[attention] thread ${turn.threadId}: ${err?.message ?? err}`);
    }
  });
}
