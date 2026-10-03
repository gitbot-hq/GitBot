import { getBot, getThread, setThreadApprovals, type ChildApproval } from "./bot-store";
import { isShuttingDown, permissionsEmitter, sessions, turnReportsTo, type SessionStore } from "./server-common";

// Approvals in Jarvis. A child that Jarvis owns and that waits on an approval
// shows up as a row in its Jarvis thread. gitbot places the row; Jarvis never
// sees it and is never woken by it. Rows are stored on the Jarvis thread:
// whether a pending approval exists is in the live stream, but how it was
// answered is not, and the history must still say so after a reload.

/** How many answered rows a Jarvis thread keeps; the oldest go first. Rows still waiting are never evicted. */
const MAX_SETTLED_ROWS = 200;

/** Pending approvals already given a row, by toolUseID: the Jarvis thread each belongs to. */
const recorded = new Map<string, string>();

/** What a tool request asks to run, in a few words: the command, the file, or the tool. */
export function approvalLabel(toolName: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const command = pick(i.command);
  const file = pick(i.file_path) ?? pick(i.filePath) ?? pick(i.notebook_path) ?? pick(i.path);
  const text = command ?? (file ? `${toolName} ${file}` : toolName);
  const line = text.split("\n")[0];
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Drops the oldest answered rows past the cap; rows still waiting all stay. */
function capped(rows: ChildApproval[]): ChildApproval[] {
  let excess = rows.filter((r) => r.outcome).length - MAX_SETTLED_ROWS;
  if (excess <= 0) return rows;
  return rows.filter((r) => !(r.outcome && excess-- > 0));
}

/** Gives these rows of one Jarvis thread an outcome, in one write (none if nothing changes). */
function settle(owner: string, ids: readonly string[], outcome: NonNullable<ChildApproval["outcome"]>): void {
  const wanted = new Set(ids);
  setThreadApprovals(owner, (rows) => {
    if (!rows.some((r) => wanted.has(r.id) && !r.outcome)) return rows;
    return capped(rows.map((r) => (wanted.has(r.id) && !r.outcome ? { ...r, outcome } : r)));
  });
}

/**
 * Brings the rows up to date with the live approvals: a new one gets a row,
 * one that left without an answer (its turn ended or was stopped) is marked
 * dropped, except during a shutdown, which leaves it unanswered. Runs
 * before each approvals broadcast, so a client that refetches on the
 * broadcast finds the row already there.
 */
export function syncChildApprovals(): void {
  const live = new Set<string>();
  const owned: Array<[SessionStore, string]> = [];
  // Every pending id counts as live before any lookup: a thread that cannot
  // be read now must not get a waiting approval marked dropped.
  for (const store of sessions.values()) {
    const owner = turnReportsTo(store);
    if (!owner || !store.threadId || store.pendingPermissions.size === 0) continue;
    for (const id of store.pendingPermissions.keys()) live.add(id);
    owned.push([store, owner]);
  }
  for (const [store, owner] of owned) {
    const fresh = [...store.pendingPermissions.values()].filter((p) => !recorded.has(p.toolUseID));
    if (fresh.length === 0) continue;
    const child = getThread(store.threadId!);
    if (!child || !getThread(owner)) continue;
    const askedAt = new Date().toISOString();
    const rows: ChildApproval[] = fresh.map((perm) => ({
      id: perm.toolUseID,
      childThreadId: child.id,
      childBotId: child.botId,
      bot: getBot(child.botId)?.name ?? "Bot",
      tool: approvalLabel(perm.toolName, perm.input),
      askedAt,
    }));
    setThreadApprovals(owner, (existing) => {
      const known = new Set(existing.map((r) => r.id));
      const added = rows.filter((r) => !known.has(r.id));
      return added.length ? capped([...existing, ...added]) : existing;
    });
    for (const r of rows) recorded.set(r.id, owner);
  }
  // A shutdown kills turns rather than ending them: their approvals stay
  // unanswered, as after any restart, not dropped.
  if (isShuttingDown()) return;
  const gone = new Map<string, string[]>();
  for (const [id, owner] of recorded) {
    if (live.has(id)) continue;
    recorded.delete(id);
    gone.set(owner, [...(gone.get(owner) ?? []), id]);
  }
  for (const [owner, ids] of gone) settle(owner, ids, "dropped");
}

/**
 * The user answered these approvals of one store. Called by whatever answers
 * them, once they are resolved and before the change is broadcast, so the
 * rows say how. A no-op for approvals that are not a Jarvis-owned child's.
 * Never throws: a row that cannot be written must not hold up an answer.
 */
export function answerChildApprovals(store: SessionStore, toolUseIDs: readonly string[], approved: boolean): void {
  try {
    const byOwner = new Map<string, string[]>();
    for (const id of toolUseIDs) {
      const owner = recorded.get(id) ?? turnReportsTo(store);
      recorded.delete(id);
      if (owner) byOwner.set(owner, [...(byOwner.get(owner) ?? []), id]);
    }
    for (const [owner, ids] of byOwner) settle(owner, ids, approved ? "approved" : "denied");
  } catch (err: any) {
    console.error("[child-approvals] could not record an answer:", err?.message ?? err);
  }
}

/**
 * Keeps the rows in step with every approvals broadcast. Ahead of every
 * other listener, so the rows are written before any client hears of the
 * change. Returns the unsubscribe.
 */
export function watchChildApprovals(): () => void {
  const listener = () => {
    try { syncChildApprovals(); } catch (err: any) { console.error("[child-approvals]", err?.message ?? err); }
  };
  permissionsEmitter.prependListener("update", listener);
  return () => { permissionsEmitter.off("update", listener); };
}
