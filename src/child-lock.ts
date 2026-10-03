import { basename } from "path";
import { getBot, getThread, isJarvisBot, setRunningFor, updateThread } from "./bot-store";
import { sessions, turnReportsTo, type SessionStore } from "./server-common";

// Lock and Stop. A Jarvis thread is locked exactly while one of its children
// has a running turn that reports back to it. The lock is derived from the
// live sessions, never stored: a turn that ends — by report, error or stop —
// unlocks it without anyone having to remember to.

export interface RunningChild {
  /** The child thread. */
  threadId: string;
  /** Its running session, the one Stop aborts. */
  sessionId: string;
}

/**
 * The child of this Jarvis thread whose turn is running (awaiting approval
 * counts) and will report back, or undefined when the thread is not locked.
 * At most one: start_thread and send_to_thread refuse a second. A thread
 * send_to_thread handed to Jarvis counts like one start_thread made.
 */
export function runningChildOf(jarvisThreadId: string): RunningChild | undefined {
  for (const s of sessions.values()) {
    if (s.status !== "running" || !s.threadId) continue;
    if (turnReportsTo(s) === jarvisThreadId) return { threadId: s.threadId, sessionId: s.gitbotId };
  }
  return undefined;
}

/** "PR Validator on Trophy": how a child is named to the user and to Jarvis. */
export function childLabel(childThreadId: string): string {
  const child = getThread(childThreadId);
  if (!child) return "a child thread";
  return `${getBot(child.botId)?.name ?? "Bot"} on ${basename(child.repoPath)}`;
}

/**
 * Why Jarvis cannot start or send to another child now: what start_thread
 * and send_to_thread both say when refused.
 */
export function oneChildAtATime(running: RunningChild): string {
  return `one child at a time: ${childLabel(running.threadId)} (thread ${running.threadId}) is still running. Tell the user: its report arrives when it finishes, or they can stop it.`;
}

/**
 * The user stopped a turn Jarvis started: leave its Jarvis thread a note for
 * the user's next message there. Called by the abort route, which has already
 * set abortRequested, so the stop wakes no one. Stored on the thread, so it
 * survives a reload or a restart.
 */
export function noteChildStopped(store: SessionStore): void {
  const owner = turnReportsTo(store);
  if (!owner || !store.threadId) return;
  addPendingNote(owner, `[you stopped ${childLabel(store.threadId)}]`);
  // Jarvis has its note: a restart before the turn winds down owes no other.
  setRunningFor(store.threadId, undefined);
}

/**
 * Adds a note for the user's next message on a Jarvis thread, after any
 * already waiting there.
 */
export function addPendingNote(jarvisThreadId: string, note: string): void {
  const jarvis = getThread(jarvisThreadId);
  if (!jarvis) return;
  updateThread(jarvisThreadId, { pendingNote: jarvis.pendingNote ? `${jarvis.pendingNote}\n${note}` : note });
}

/**
 * The note waiting for a user turn on a Jarvis thread, if any. A report is
 * not the user's message, so it never carries one.
 */
export function pendingNoteFor(threadId: string | undefined, report: boolean | undefined): string | undefined {
  if (!threadId || report) return undefined;
  const thread = getThread(threadId);
  if (!thread?.pendingNote || !isJarvisBot(getBot(thread.botId))) return undefined;
  return thread.pendingNote;
}

/** The message as Jarvis receives it: the pending note first. */
export function withNote(note: string | undefined, prompt: string | undefined): string | undefined {
  if (!note) return prompt;
  return prompt ? `${note}\n\n${prompt}` : note;
}

/** The note has been delivered: clear it so it is prepended only once. */
export function clearPendingNote(threadId: string): void {
  updateThread(threadId, { pendingNote: undefined });
}
