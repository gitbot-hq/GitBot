// Approvals in Jarvis. A Jarvis-owned child waiting on an approval shows as a
// row in its Jarvis thread. The server keeps the rows on the Jarvis thread
// (src/child-approvals.ts) because how one was answered is known nowhere
// else; whether one is still waiting comes from the live approvals stream.

/** One stored row, as the server keeps it on the Jarvis thread. */
export type ChildApproval = {
  id: string;
  childThreadId: string;
  childBotId: string;
  bot: string;
  tool: string;
  /** When it asked (ISO time). */
  askedAt: string;
  outcome?: "approved" | "denied" | "dropped";
};

/** "unknown": unanswered, and the stream not heard from yet to say whether it still waits. */
export type ApprovalState = "pending" | "approved" | "denied" | "dropped" | "unknown";

export type ApprovalRow = ChildApproval & { state: ApprovalState };

/** The parts of a /permissions/events snapshot this reads. */
export type ApprovalsSnapshot = {
  permissions?: { sessionId: string; toolUseID: string }[];
  sessions?: { gitbotId: string; threadId: string | null; reportTo?: string | null }[];
};

/**
 * By Jarvis thread id: the approvals its children are waiting on now (their
 * toolUseIDs, sorted). An approval belongs to the Jarvis thread its session's
 * turn reports to.
 */
export function pendingByJarvis(snapshot: ApprovalsSnapshot): Record<string, string[]> {
  const owner = new Map<string, string>();
  for (const s of snapshot.sessions ?? []) if (s.reportTo && s.threadId) owner.set(s.gitbotId, s.reportTo);
  const out: Record<string, string[]> = {};
  for (const p of snapshot.permissions ?? []) {
    const jarvis = owner.get(p.sessionId);
    if (jarvis) (out[jarvis] ??= []).push(p.toolUseID);
  }
  for (const ids of Object.values(out)) ids.sort();
  return out;
}

/**
 * Each stored row with its state now. A row the server has answered says
 * so; an unanswered one is pending while the stream lists it, and dropped
 * once it does not (its turn ended, or gitbot restarted). Until the stream is
 * first heard from (`pending` null) an unanswered row is "unknown": shown
 * neutral, offering no Review.
 */
export function approvalRows(log: ChildApproval[], pending: readonly string[] | null): ApprovalRow[] {
  const waiting = pending ? new Set(pending) : null;
  return log.map((r) => ({
    ...r,
    state: r.outcome ?? (!waiting ? "unknown" : waiting.has(r.id) ? "pending" : "dropped"),
  }));
}

/**
 * Where rows sit among the conversation's messages, by time: each goes just
 * before the first message that began after it was asked, in the order
 * asked. `times` are the messages' start times (ISO); a message with none is
 * no boundary. Rows asked after every message trail the conversation.
 */
export function placeApprovals<R extends { askedAt: string }>(
  times: readonly (string | undefined)[],
  rows: readonly R[],
): { before: Map<number, R[]>; trailing: R[] } {
  const ms = (t: string) => {
    const n = Date.parse(t);
    return Number.isNaN(n) ? Infinity : n;
  };
  let rest = [...rows].sort((a, b) => ms(a.askedAt) - ms(b.askedAt));
  const before = new Map<number, R[]>();
  times.forEach((t, i) => {
    if (!t || rest.length === 0) return;
    const at = ms(t);
    const here = rest.filter((r) => ms(r.askedAt) < at);
    if (here.length === 0) return;
    before.set(i, here);
    rest = rest.filter((r) => ms(r.askedAt) >= at);
  });
  return { before, trailing: rest };
}
