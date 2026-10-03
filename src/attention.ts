import { getBot, getThread, isJarvisBot, setThreadActivity } from "./bot-store";
import { lastAssistantMessage } from "./reports";
import { isShuttingDown, onTurnEnd, type EndedTurn } from "./server-common";

// Attention signals, the server's part. "Has news" on a Jarvis thread is
// lastActivityAt > lastSeenAt: a turn there ended since anyone last viewed
// it. The turn end stamps lastActivityAt (and the preview, with what Jarvis
// last said) before the session snapshot goes out, so a UI that refetches
// the thread list on that snapshot already sees it. "Needs you" is not
// stored: the UI reads it from the approvals in the same snapshot.

/** The opening line of what a turn ended saying, as a thread-list preview. */
export function latestLine(message: string, cap = 140): string {
  const line = message
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, "").replace(/[*_`]{2,}/g, "").trim())
    .find(Boolean);
  return line ? line.slice(0, cap) : "";
}

/** Stamps a Jarvis thread's activity when a turn on it ends. */
export function noteJarvisActivity(turn: EndedTurn, at: string = new Date().toISOString()): void {
  // A turn our own shutdown killed did not end on its own: nothing to tell.
  if (isShuttingDown()) return;
  if (!turn.threadId) return;
  const thread = getThread(turn.threadId);
  if (!thread || !isJarvisBot(getBot(thread.botId))) return;
  setThreadActivity(thread.id, at, latestLine(lastAssistantMessage(turn.events)) || undefined);
}

/** Wires activity stamps to every turn end, whichever agent ran it. Call once at start. */
export function watchJarvisActivity(): () => void {
  return onTurnEnd((_store, turn) => {
    try {
      noteJarvisActivity(turn);
    } catch (err: any) {
      console.error(`[attention] thread ${turn.threadId}: ${err?.message ?? err}`);
    }
  });
}
