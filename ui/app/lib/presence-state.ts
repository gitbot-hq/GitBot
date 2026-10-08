// What this tab tells the server about where the user is (src/presence.ts):
// pure, so it can be tested without a browser (scripts/presence-state.test.mjs).

export type PresenceReportState = "watching" | "glancing" | "present" | "away";

export interface PresenceInputs {
  /** document.visibilityState === "visible": on screen, maybe beside another window. */
  visible: boolean;
  /** document.hasFocus(): this window has the keyboard. */
  focused: boolean;
  /** No input for IDLE_MS. */
  idle: boolean;
  /** The thread open and not covered (by a drawer, a panel, a modal); null when none is. */
  threadId: string | null;
}

/** No pointer, key, wheel, scroll or touch for this long, and the user is away. */
export const IDLE_MS = 5 * 60_000;
/** How often a report is renewed while it says the user is here; the server keeps one 45s. */
export const RENEW_MS = 20_000;

/**
 * - watching X: on screen, focused, on thread X;
 * - glancing X: on screen beside a focused window, on thread X;
 * - present: on screen and focused, on no thread;
 * - away: hidden, idle, or unfocused on no thread.
 */
export function presenceState({ visible, focused, idle, threadId }: PresenceInputs): { state: PresenceReportState; thread: string | null } {
  if (!visible || idle) return { state: "away", thread: null };
  if (focused) return threadId ? { state: "watching", thread: threadId } : { state: "present", thread: null };
  return threadId ? { state: "glancing", thread: threadId } : { state: "away", thread: null };
}
