import { listThreads, setRunningFor } from "./bot-store";
import { addPendingNote, childLabel } from "./child-lock";
import { onTurnEnd, sessions } from "./server-common";

// Restart recovery. Sessions live in memory, so a restart kills a running
// child. Its Jarvis thread unlocks on its own (the lock is derived from live
// sessions); what it would miss is hearing why no report ever came. A thread
// running a reportable turn is marked with its Jarvis thread (runningFor) when
// the turn starts and unmarked when it ends, so a mark still there at startup
// is a child the restart interrupted.

/**
 * At startup, before any turn runs: tells each interrupted child's Jarvis
 * thread, with the user's next message there, and clears the marks.
 */
export function recoverInterruptedChildren(): string[] {
  const interrupted: string[] = [];
  for (const thread of listThreads()) {
    if (!thread.runningFor) continue;
    addPendingNote(thread.runningFor, `[${childLabel(thread.id)} was interrupted by a restart]`);
    setRunningFor(thread.id, undefined);
    interrupted.push(thread.id);
  }
  return interrupted;
}

/** Unmarks a thread when its turn ends, however it ends. Call once at start. */
export function watchRunningMarks(): () => void {
  return onTurnEnd((_store, turn) => {
    const threadId = turn.threadId;
    if (!threadId) return;
    // A turn already running again on the thread keeps its mark.
    if ([...sessions.values()].some((s) => s.threadId === threadId && s.status === "running")) return;
    setRunningFor(threadId, undefined);
  });
}
