import { deliverQueuedReport, jarvisIsMidTurn } from "./reports";
import { isShuttingDown, onTurnEnd } from "./server-common";

// The deferred-turn slot. Work that found its thread mid-turn waits on the
// thread and starts when that turn ends: today, a child's report that found
// its Jarvis busy (reports.ts, Thread.queuedReports).
//
// The drain never runs inside the turn-end listener pass. Its listener only
// schedules it (setImmediate), so it runs after every other listener and
// after the sessions broadcast for that end: no listener ever reads a store
// whose next turn has already started, and the UI sees the thread go idle,
// then the deferred turn start, in that order.

/**
 * Starts at most one deferred turn on a thread that is free: a queued report
 * first. That turn's own end drains the next. True when one started.
 */
export function drainThread(threadId: string, availableAgents: readonly string[]): boolean {
  if (isShuttingDown()) return false;
  return deliverQueuedReport(threadId, availableAgents);
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
    if (threads.size === 0) return;
    setImmediate(() => {
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
