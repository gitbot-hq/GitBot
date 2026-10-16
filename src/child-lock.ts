import { basename } from "path";
import { appendNote, getBot, getThread, isJarvisBot, isScheduleNotes, setRunningFor, updateThread, type Thread } from "./bot-store";
import { sessions, turnReportsTo, type SessionStore } from "./server-common";
import type { ScheduledTurn } from "./schedule-tag";

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
  return child ? threadLabel(child) : "a child thread";
}

/** childLabel for a thread already in hand. */
export function threadLabel(child: Pick<Thread, "botId" | "repoPath">): string {
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
 * already waiting there; a note already waiting is not added twice.
 */
export function addPendingNote(jarvisThreadId: string, note: string): void {
  const jarvis = getThread(jarvisThreadId);
  if (!jarvis) return;
  updateThread(jarvisThreadId, { pendingNote: appendNote(jarvis.pendingNote, note) });
}

/**
 * The notes waiting for a user turn on a Jarvis thread, if any: the pending
 * note first, then each schedule's line (Thread.scheduleNotes). A report is
 * not the user's message, and neither is a scheduled turn, so neither ever
 * carries them: they wait for the user's own next message.
 */
export function pendingNoteFor(
  threadId: string | undefined,
  report: boolean | undefined,
  scheduled?: ScheduledTurn,
): string | undefined {
  if (!threadId || report || scheduled) return undefined;
  const thread = getThread(threadId);
  if (!thread || !isJarvisBot(getBot(thread.botId))) return undefined;
  const schedules = isScheduleNotes(thread.scheduleNotes)
    ? Object.values(thread.scheduleNotes).map((n) => n?.line).filter((l): l is string => typeof l === "string" && !!l)
    : [];
  const lines = [...(thread.pendingNote ? [thread.pendingNote] : []), ...schedules];
  return lines.length ? lines.join("\n") : undefined;
}

/** The message as Jarvis receives it: the pending note first. */
export function withNote(note: string | undefined, prompt: string | undefined): string | undefined {
  if (!note) return prompt;
  return prompt ? `${note}\n\n${prompt}` : note;
}

/**
 * The notes have been delivered: clear them so they are prepended only once.
 * The schedule lines go too, so each schedule's run count starts again from 0.
 */
export function clearPendingNote(threadId: string): void {
  updateThread(threadId, { pendingNote: undefined, scheduleNotes: undefined });
}
