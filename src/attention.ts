import { getBot, getThread, isJarvisBot, markThreadSeen, setThreadActivity, type TurnOutcome } from "./bot-store";
import { lastAssistantMessage } from "./reports";
import { isShuttingDown, onTurnEnd, turnStopped, type EndedTurn } from "./server-common";

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

/** How a turn ended. A turn the user aborted is stopped, not failed. */
export function turnOutcome(turn: EndedTurn): TurnOutcome {
  if (turnStopped(turn)) return "stopped";
  return turn.status === "error" ? "failed" : "done";
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
