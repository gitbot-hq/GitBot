import { getBot, getThread, isJarvisBot, markThreadSeen, setThreadActivity, type TurnOutcome } from "./bot-store";
import { lastAssistantMessage } from "./reports";
import { getSchedule, isNotify, type Notify } from "./schedules";
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

/**
 * The `notify` of the schedule that started this turn, or undefined for a
 * turn no schedule started. A schedule deleted mid-run, or one whose stored
 * value this build does not know, counts as `always`: told as any turn is.
 */
export function scheduledNotify(turn: Pick<EndedTurn, "scheduled">): Notify | undefined {
  if (!turn.scheduled) return undefined;
  const notify = getSchedule(turn.scheduled.id)?.notify;
  return isNotify(notify) ? notify : "always";
}

/**
 * True when this turn's end is to be neither pushed nor left as unread news:
 * a scheduled turn whose schedule's `notify` does not cover its outcome
 * (`never`: done or failed; `on-failure`: done). The one rule for the push
 * listener (push.ts) and the activity stamp below, which run as separate
 * turn-end listeners and must agree. A stopped turn is never quiet here (it
 * is no push anyway); an unscheduled turn never is.
 */
export function scheduledOutcomeIsQuiet(turn: EndedTurn, outcome: TurnOutcome = turnOutcome(turn)): boolean {
  const notify = scheduledNotify(turn);
  if (!notify || notify === "always" || outcome === "stopped") return false;
  return notify === "never" || outcome === "done";
}

/** True when the thread shows news no one has seen yet (the UI's hasNews). */
function hasUnseenNews(thread: { lastActivityAt?: string; lastSeenAt?: string }): boolean {
  if (!thread.lastActivityAt) return false;
  if (!thread.lastSeenAt) return true;
  return Date.parse(thread.lastActivityAt) > Date.parse(thread.lastSeenAt);
}

/**
 * Stamps a thread's activity when a turn on it ends; a Jarvis thread's
 * preview too. A quiet scheduled run (scheduledOutcomeIsQuiet) is stamped
 * seen, so it leaves no unread dot, unless the thread already had news no
 * one has seen: that news stays, outcome (its dot's colour) and all.
 * Returns true for a quiet run it stamped: its ending is not news.
 */
export function noteThreadActivity(turn: EndedTurn, at: string = new Date().toISOString()): boolean {
  // A turn our own shutdown killed did not end on its own: nothing to tell.
  if (isShuttingDown()) return false;
  if (!turn.threadId) return false;
  const thread = getThread(turn.threadId);
  if (!thread) return false;
  // Other threads keep their preview: the prompt that started the turn.
  const preview = isJarvisBot(getBot(thread.botId)) ? latestLine(lastAssistantMessage(turn.events)) || undefined : undefined;
  const outcome = turnOutcome(turn);
  const quiet = scheduledOutcomeIsQuiet(turn, outcome);
  if (quiet && hasUnseenNews(thread)) {
    setThreadActivity(thread.id, at, preview, thread.lastOutcome);
    return true;
  }
  setThreadActivity(thread.id, at, preview, outcome);
  // Its report is with Jarvis already (reports.ts): seen. So is a quiet
  // scheduled run: its schedule's notify says not to tell.
  if (turn.reportDelivered || quiet) markThreadSeen(thread.id, at);
  return quiet;
}

/** Wires activity stamps to every turn end, whichever agent ran it. Call once at start. */
export function watchThreadActivity(): () => void {
  return onTurnEnd((store, turn) => {
    try {
      const quiet = noteThreadActivity(turn);
      // The session snapshot says so (quietEnd), and the thread row shows the
      // stored lastOutcome, not this ending: a quiet success must not turn an
      // earlier unseen failure's dot green. Only while the store is still on
      // this turn: a newer one has its own flags.
      if (quiet && store.turn === turn.turnNumber) store.quietEnd = true;
    } catch (err: any) {
      console.error(`[attention] thread ${turn.threadId}: ${err?.message ?? err}`);
    }
  });
}
