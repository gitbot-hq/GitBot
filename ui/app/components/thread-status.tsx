"use client";

import type { ThreadRowState } from "../lib/use-thread-sessions";

const LABELS: Record<ThreadRowState, string> = {
  running: "Working",
  waiting: "Needs you",
  done: "Done — not seen yet",
  failed: "Failed — not seen yet",
  stopped: "Stopped — not seen yet",
};

/**
 * A thread row's state at a glance: a spinner while a turn runs, an amber dot
 * while it waits on the user, then, until the thread is seen, green (done),
 * red (failed) or grey (stopped) for how its last turn ended. Nothing once
 * it has been seen. Which state to show is threadIndicator's call.
 */
export default function ThreadStatus({ state }: { state: ThreadRowState | null }) {
  if (!state) return null;
  const label = LABELS[state];
  return <span className={`thread-status thread-status-${state}`} role="img" aria-label={label} title={label} />;
}
