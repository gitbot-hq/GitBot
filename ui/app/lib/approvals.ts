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
  /** The Jarvis thread's turn count when asked: the row follows that many turns. */
  after: number;
  outcome?: "approved" | "denied" | "dropped";
};

export type ApprovalState = "pending" | "approved" | "denied" | "dropped";

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
 * so; an unanswered one is pending while the stream lists it, or until the
 * stream is first heard from (`pending` null). One the stream no longer lists
 * and nobody answered was dropped: its turn ended, or gitbot restarted.
 */
export function approvalRows(log: ChildApproval[], pending: readonly string[] | null): ApprovalRow[] {
  const waiting = pending ? new Set(pending) : null;
  return log.map((r) => ({
    ...r,
    state: r.outcome ?? (!waiting || waiting.has(r.id) ? "pending" : "dropped"),
  }));
}
