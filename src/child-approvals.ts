import { getBot, getThread, setThreadApprovals, type ChildApproval } from "./bot-store";
import { permissionsEmitter, sessions, turnReportsTo, type SessionStore } from "./server-common";

// Approvals in Jarvis. A child that Jarvis owns and that waits on an approval
// shows up as a row in its Jarvis thread. gitbot places the row; Jarvis never
// sees it and is never woken by it. Rows are stored on the Jarvis thread:
// whether a pending approval exists is in the live stream, but how it was
// answered is not, and the history must still say so after a reload.

/** How many rows a Jarvis thread keeps; the oldest go first. */
const MAX_ROWS = 200;

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

function settle(owner: string, id: string, outcome: NonNullable<ChildApproval["outcome"]>): void {
  setThreadApprovals(owner, (rows) =>
    rows.map((r) => (r.id === id && !r.outcome ? { ...r, outcome } : r)),
  );
}

/**
 * Brings the rows up to date with the live approvals: a new one gets a row,
 * one that left without an answer (its turn ended or was stopped) is marked
 * dropped. Runs before each approvals broadcast, so a client that refetches
 * on the broadcast finds the row already there.
 */
export function syncChildApprovals(): void {
  const live = new Set<string>();
  for (const store of sessions.values()) {
    const owner = turnReportsTo(store);
    if (!owner || !store.threadId || store.pendingPermissions.size === 0) continue;
    const child = getThread(store.threadId);
    const jarvis = getThread(owner);
    if (!child || !jarvis) continue;
    const fresh: ChildApproval[] = [];
    for (const perm of store.pendingPermissions.values()) {
      live.add(perm.toolUseID);
      if (recorded.has(perm.toolUseID)) continue;
      recorded.set(perm.toolUseID, owner);
      fresh.push({
        id: perm.toolUseID,
        childThreadId: child.id,
        childBotId: child.botId,
        bot: getBot(child.botId)?.name ?? "Bot",
        tool: approvalLabel(perm.toolName, perm.input),
        after: jarvis.messageCount,
      });
    }
    if (fresh.length) {
      setThreadApprovals(owner, (rows) => {
        const known = new Set(rows.map((r) => r.id));
        return [...rows, ...fresh.filter((r) => !known.has(r.id))].slice(-MAX_ROWS);
      });
    }
  }
  for (const [id, owner] of recorded) {
    if (live.has(id)) continue;
    recorded.delete(id);
    settle(owner, id, "dropped");
  }
}

/**
 * The user answered an approval. Called by whatever answers it, before the
 * approval leaves the store, so its row says how. A no-op for an approval
 * that is not a Jarvis-owned child's.
 */
export function answerChildApproval(store: SessionStore, toolUseID: string, approved: boolean): void {
  const owner = recorded.get(toolUseID) ?? turnReportsTo(store);
  if (!owner) return;
  recorded.delete(toolUseID);
  settle(owner, toolUseID, approved ? "approved" : "denied");
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
