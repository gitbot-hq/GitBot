import { getThread } from "./bot-store";
import { deliverQueuedReport, jarvisIsMidTurn } from "./reports";
import { deliverPendingNewThreadRun, deliverPendingSchedule } from "./scheduler";
import { isShuttingDown, onTurnEnd } from "./server-common";

// The deferred-turn slot. Work that found its thread busy waits on the
// thread and starts when that turn ends: a child's report that found its
// Jarvis mid-turn (reports.ts, Thread.queuedReports, a list, oldest first),
// and a schedule's fire that found its thread busy (scheduler.ts, each
// schedule's one `pending` fire, in schedules.json). A new-thread schedule's
// pending fire waits on its own last run instead, and starts when that run's
// turn ends (in a thread of its own).
//
// The drain never runs inside the turn-end listener pass. Its listener only
// schedules it (setImmediate), so it runs after every other listener and
// after the sessions broadcast for that end: no listener ever reads a store
// whose next turn has already started, and the UI sees the thread go idle,
// then the deferred turn start, in that order.

/**
 * Starts at most one deferred turn on a thread that is free: a queued report
 * first, then the oldest pending schedule fire. That turn's own end drains
 * the next. True when one started.
 */
export function drainThread(threadId: string, availableAgents: readonly string[]): boolean {
  if (isShuttingDown()) return false;
  if (deliverQueuedReport(threadId, availableAgents)) return true;
  // Reports first: one still waiting (its Jarvis busy again, or its agent
  // missing for now) keeps every schedule fire behind it.
  const reports = getThread(threadId)?.queuedReports;
  if (Array.isArray(reports) && reports.length) return false;
  return deliverPendingSchedule(threadId, availableAgents);
}

/**
 * Drains each thread whose turn ends. Register last of all turn-end
 * listeners in start() (test/push.test.ts pins this).
 */
export function watchDeferredTurns(availableAgents: readonly string[]): () => void {
  return onTurnEnd((_store, turn) => {
    // The thread this turn freed. And the Jarvis thread a child's turn
    // reports to, if it is free already: the report went behind older
    // queued ones although Jarvis's turn had ended (in the same batch as
    // this one). A Jarvis still mid-turn is drained by its own turn's end,
    // after its own listeners, never before.
    const owner = turn.reportOwner && !jarvisIsMidTurn(turn.reportOwner) ? turn.reportOwner : undefined;
    const threads = new Set([turn.threadId, owner].filter((id): id is string => !!id));
    // A run of a new-thread schedule: that schedule may have a fire waiting for it.
    const scheduleId = turn.scheduled?.id;
    if (threads.size === 0 && !scheduleId) return;
    setImmediate(() => {
      if (scheduleId) {
        try {
          deliverPendingNewThreadRun(scheduleId, availableAgents);
        } catch (err: any) {
          console.error(`[deferred] schedule ${scheduleId}: ${err?.message ?? err}`);
        }
      }
      for (const threadId of threads) {
        try {
          drainThread(threadId, availableAgents);
        } catch (err: any) {
          console.error(`[deferred] thread ${threadId}: ${err?.message ?? err}`);
        }
      }
    });
  });
}
