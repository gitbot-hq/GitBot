// Attention signals: which Jarvis thread needs you, and which has news.
// All derived, nothing stored here. "Needs you" comes from the session
// stream (a child of the thread waits on an approval: pendingByJarvis);
// "has news" from the thread list (a turn ended since anyone viewed it).

import type { ChildApproval } from "./approvals";

/** The thread fields the signals read. */
export type AttentionThread = {
  id: string;
  title: string;
  preview?: string;
  approvals?: ChildApproval[];
  lastActivityAt?: string;
  lastSeenAt?: string;
};

/** A turn ended since the thread was last viewed, on any device. */
export function hasNews(thread: Pick<AttentionThread, "lastActivityAt" | "lastSeenAt">): boolean {
  if (!thread.lastActivityAt) return false;
  if (!thread.lastSeenAt) return true;
  return Date.parse(thread.lastActivityAt) > Date.parse(thread.lastSeenAt);
}

/**
 * A re-read thread list, keeping the later lastSeenAt where this page holds
 * one: a read sent before a thread was marked seen can land after it, and
 * would bring the cleared dot back.
 */
export function keepLaterSeen<T extends { id: string; lastSeenAt?: string }>(loaded: T[], local: readonly T[]): T[] {
  const seen = new Map(local.map((t) => [t.id, t.lastSeenAt]));
  return loaded.map((t) => {
    const mine = seen.get(t.id);
    return mine && (!t.lastSeenAt || Date.parse(mine) > Date.parse(t.lastSeenAt)) ? { ...t, lastSeenAt: mine } : t;
  });
}

/** How many Jarvis threads have a child waiting on an approval. */
export function needsYouCount(pending: Record<string, readonly string[]> | null): number {
  if (!pending) return 0;
  return Object.values(pending).filter((ids) => ids.length > 0).length;
}

/** The Bots panel's line for Jarvis: "1 needs you", "2 need you". */
export function needsYouLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

const PREFIX = /^\(\d+\) /;

/** The tab title with "(n) " in front while anything needs you; the rest kept as it is. */
export function attentionTitle(title: string, count: number): string {
  const base = title.replace(PREFIX, "");
  return count > 0 ? `(${count}) ${base}` : base;
}

/** What a waiting approval says on its thread's row. */
export function needsYouLine(approvals: readonly ChildApproval[] | undefined, pending: readonly string[]): string {
  const waiting = new Set(pending);
  // The latest one asked is the line to show.
  const row = [...(approvals ?? [])].reverse().find((r) => waiting.has(r.id) && !r.outcome);
  return row ? `${row.bot} needs permission to run \`${row.tool}\`` : "A child is waiting on your approval";
}

export type AttentionRow<T extends AttentionThread> = {
  thread: T;
  needsYou: boolean;
  hasNews: boolean;
  /** The row's second line: the waiting approval, else the thread's latest line. */
  preview: string;
};

/**
 * Thread rows with their signals, threads that need you first (each group
 * keeps the list's order). The open thread, while the tab is visible, is
 * being looked at: it has no news to show.
 */
export function attentionRows<T extends AttentionThread>(
  threads: readonly T[],
  pending: Record<string, readonly string[]> | null,
  viewing?: string | null,
): AttentionRow<T>[] {
  const rows = threads.map((thread) => {
    const waiting = pending?.[thread.id] ?? [];
    const needsYou = waiting.length > 0;
    return {
      thread,
      needsYou,
      hasNews: thread.id !== viewing && hasNews(thread),
      preview: needsYou ? needsYouLine(thread.approvals, waiting) : thread.preview ?? "",
    };
  });
  return [...rows.filter((r) => r.needsYou), ...rows.filter((r) => !r.needsYou)];
}
