// Where the user is, as gitbot's open tabs report it, so a push is only sent
// when it would tell them something they can't already see. Each tab posts its
// state to /push/presence (src/push.ts routes it) when it changes, and renews
// it every 20s while it is on screen; a report lasts 45s, so a tab that died
// without saying so (a closed lid, an iPhone app swiped away) stops counting
// soon after. Kept in memory only: after a restart everyone is away until
// their tabs next report, which costs at most one push too many.
//
// Suppression has to happen here, on the server: every push must show a
// notification (Safari cancels subscriptions that receive silent ones), so the
// service worker can't drop one the user doesn't need.

/** What one tab says about the user. */
export type PresenceState =
  /** On screen, its window focused, the thread open and not covered. */
  | "watching"
  /** On screen but another window has focus (side by side): the thread is visible. */
  | "glancing"
  /** On screen and focused, but on no thread (or a covered one). */
  | "present";

export interface TabPresence {
  /** The thread on screen; null when none is. */
  threadId: string | null;
  state: PresenceState;
  /** Epoch ms after which this report no longer counts. */
  expiresAt: number;
}

export const PRESENCE_LEASE_MS = 45_000;
export const MAX_PRESENCE_TABS = 100;
const MAX_ID_LENGTH = 128;

/** The clock. A seam: tests move time instead of waiting. */
export const presenceClock = { now: (): number => Date.now() };

const tabs = new Map<string, TabPresence>();

/** Drops reports past their lease. Runs on every read and write. */
function prune(now: number): void {
  for (const [id, tab] of tabs) if (tab.expiresAt <= now) tabs.delete(id);
}

/** Every tab whose report still counts. */
export function liveTabs(now = presenceClock.now()): TabPresence[] {
  prune(now);
  return [...tabs.values()];
}

/** For tests: forget every tab, as a restart does. */
export function clearPresence(): void {
  tabs.clear();
}

export type PresenceUpdate = { tab: string; threadId: string | null; state: PresenceState | "away" };

const STATES = new Set(["watching", "glancing", "present", "away"]);
const ID = /^[A-Za-z0-9_-]+$/;

/** A presence report from a tab, checked, or null when it isn't one. */
export function parsePresence(raw: unknown): PresenceUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const { tab, thread, state } = raw as { tab?: unknown; thread?: unknown; state?: unknown };
  if (typeof tab !== "string" || tab.length < 8 || tab.length > 64 || !ID.test(tab)) return null;
  if (typeof state !== "string" || !STATES.has(state)) return null;
  if (thread !== undefined && thread !== null && (typeof thread !== "string" || !thread || thread.length > MAX_ID_LENGTH || !ID.test(thread))) {
    return null;
  }
  const threadId = typeof thread === "string" ? thread : null;
  // Watching or glancing is at a thread; without one it is only being in gitbot.
  const s = state as PresenceUpdate["state"];
  return { tab, threadId, state: (s === "watching" || s === "glancing") && !threadId ? "present" : s };
}

/** Thrown when a new tab reports while MAX_PRESENCE_TABS live ones are kept. */
export class PresenceLimitError extends Error {
  constructor() {
    super(`gitbot is already tracking ${MAX_PRESENCE_TABS} open tabs`);
  }
}

/**
 * Records a tab's report. "away" forgets the tab. A new tab past the cap is
 * refused rather than making room: evicting would let anyone push the user's
 * own tabs out.
 */
export function recordPresence(update: PresenceUpdate, now = presenceClock.now()): void {
  prune(now);
  if (update.state === "away") {
    tabs.delete(update.tab);
    return;
  }
  if (!tabs.has(update.tab) && tabs.size >= MAX_PRESENCE_TABS) throw new PresenceLimitError();
  tabs.set(update.tab, { threadId: update.threadId, state: update.state, expiresAt: now + PRESENCE_LEASE_MS });
}

export type NotificationKind = "done" | "failed" | "approval" | "question";

/**
 * Whether a notification of this kind, about this thread, is worth sending
 * given where the user is. Pure: the tabs, the time and the owner lookup are
 * all passed in.
 *
 * - Needs you (approval, question): unless a tab is watching the thread, or
 *   watching the Jarvis thread it reports to (its approvals show there as rows).
 * - Failed: unless a tab is watching or glancing at the thread.
 * - Finished: only when the user is away: no tab watching any thread, none
 *   present in gitbot, none glancing at this thread.
 */
export function decide(
  kind: NotificationKind,
  threadId: string | null | undefined,
  tabList: readonly TabPresence[],
  now: number,
  ownerOf: (threadId: string) => string | null | undefined,
): boolean {
  const live = tabList.filter((t) => t.expiresAt > now);
  const on = (id: string | null | undefined, ...states: PresenceState[]) =>
    !!id && live.some((t) => t.threadId === id && states.includes(t.state));
  if (kind === "approval" || kind === "question") {
    if (on(threadId, "watching")) return false;
    const owner = threadId ? ownerOf(threadId) : null;
    return !on(owner, "watching");
  }
  if (on(threadId, "watching", "glancing")) return false;
  if (kind === "failed") return true;
  return !live.some((t) => t.state === "watching" || t.state === "present");
}
