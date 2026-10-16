import { getBot, getThread, setRunningFor, settleRunningMarks, threadAgent } from "./bot-store";
import { threadLabel } from "./child-lock";
import { isShuttingDown, onTurnEnd, sessions, turnReportsTo } from "./server-common";

// Restart recovery. Sessions live in memory, so a restart kills a running
// child. Its Jarvis thread unlocks on its own (the lock is derived from live
// sessions); what it would miss is hearing why no report ever came. A thread
// running a reportable turn is marked with its Jarvis thread and our pid
// (runningFor) when the turn starts and unmarked when it ends, so a mark
// still there at startup, from a process now gone, is a child the restart
// interrupted.

/** Whether a process is alive. EPERM means it is, just not ours to signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * At startup, before any turn runs: tells each interrupted child's Jarvis
 * thread, with the user's next message there, and clears the marks. Never
 * throws: a failed recovery must not stop gitbot starting.
 */
export function recoverInterruptedChildren(isAlive: (pid: number) => boolean = pidAlive): string[] {
  try {
    return settleRunningMarks((child) => `[${threadLabel(child)} was interrupted by a restart]`, isAlive);
  } catch (err: any) {
    console.error(`[restart-recovery] skipped: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * At startup, after recoverInterruptedChildren and once opencode is up: stops
 * each interrupted opencode child's session on the opencode server. gitbot's
 * exit kills a server it spawned, but not one it found running (the user's
 * own `opencode serve`), and a turn there runs on after gitbot is gone. A
 * session that is not running takes the abort as a no-op. Fire and forget:
 * never throws, never waits.
 */
export function abortInterruptedOpencode(
  threadIds: readonly string[],
  abort: (sdkSessionId: string, repoPath: string) => Promise<void>,
): void {
  for (const id of threadIds) {
    try {
      const thread = getThread(id);
      if (!thread?.sdkSessionId) continue;
      const bot = getBot(thread.botId);
      const agent = bot ? threadAgent(thread, bot) : thread.agent;
      if (agent !== "opencode") continue;
      const sdkSessionId = thread.sdkSessionId;
      console.log(`[restart-recovery] stopping interrupted opencode session ${sdkSessionId} (thread ${id})`);
      Promise.resolve()
        .then(() => abort(sdkSessionId, thread.repoPath))
        .catch((err: any) => console.warn(`[restart-recovery] could not stop opencode session ${sdkSessionId}: ${err?.message ?? err}`));
    } catch (err: any) {
      console.error(`[restart-recovery] thread ${id}: ${err?.message ?? err}`);
    }
  }
}

/** Unmarks a thread when its turn ends, however it ends. Call once at start. */
export function watchRunningMarks(): () => void {
  return onTurnEnd((_store, turn) => {
    // Our own shutdown killed it: keep the mark, so the next start tells Jarvis.
    if (isShuttingDown()) return;
    const threadId = turn.threadId;
    if (!threadId) return;
    // A reportable turn already running again on the thread keeps its mark.
    // A user's turn does not: it cleared the mark when it started.
    if ([...sessions.values()].some((s) => s.threadId === threadId && s.status === "running" && turnReportsTo(s))) return;
    setRunningFor(threadId, undefined);
  });
}
