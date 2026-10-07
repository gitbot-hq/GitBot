/**
 * The task list a Claude Code thread keeps with TaskCreate / TaskGet /
 * TaskUpdate / TaskList, for the task panel.
 *
 * The CLI stores the list itself and reports no event for it, so the panel
 * folds the calls. The server pairs each call with its result and sends one op
 * — live as a `task_op` event, on load as the `task` field of the call's
 * history block — and both go through `foldTasks`:
 *
 * - TaskCreate: the result holds the new id ("1", "2", … per session, never
 *   reused); the call holds the subject and activeForm. Tasks start pending.
 * - TaskUpdate: the call says what changed; the result says whether it took.
 *   Status "deleted" removes the task.
 * - TaskGet: one task as it is now; null when it no longer exists.
 * - TaskList: the whole list, so it replaces what the panel had. It carries no
 *   activeForm, which is kept from earlier calls.
 *
 * A call that failed (unknown id, refused, a hook said no) has no op or an
 * unsuccessful result, and changes nothing.
 */

import type { HistoryMsg } from "./gitbot";

export type TaskStatus = "pending" | "in_progress" | "completed";

export type Task = {
  id: string;
  subject: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];
};

/** One Task tool call with its result, keyed by the call's tool_use_id. */
export type TaskOp = {
  tool_use_id: string;
  tool: string;
  input: Record<string, any>;
  result: Record<string, any>;
};

/** Every op applied so far, in order, and the list they make. */
export type TaskState = { ops: TaskOp[]; tasks: Task[] };

export const NO_TASKS: TaskState = { ops: [], tasks: [] };

const STATUSES = new Set<string>(["pending", "in_progress", "completed"]);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function applyOp(list: Task[], op: TaskOp): Task[] {
  const { input, result } = op;
  const at = (id: string) => list.findIndex((t) => t.id === id);
  const put = (i: number, t: Task) => (i < 0 ? [...list, t] : list.map((x, j) => (j === i ? t : x)));

  switch (op.tool) {
    case "TaskCreate": {
      const id = str(result.task?.id);
      if (!id) return list;
      const i = at(id);
      const subject = str(input.subject) ?? str(result.task?.subject) ?? `Task #${id}`;
      const base: Task = i >= 0 ? list[i] : { id, subject, status: "pending", blockedBy: [] };
      return put(i, { ...base, subject, activeForm: str(input.activeForm) ?? base.activeForm });
    }
    case "TaskUpdate": {
      if (result.success !== true) return list;
      const id = str(result.taskId) ?? str(input.taskId);
      if (!id) return list;
      // A delete is all the CLI does with the call; the task stops blocking any.
      if (input.status === "deleted" || result.statusChange?.to === "deleted") {
        return list
          .filter((t) => t.id !== id)
          .map((t) => (t.blockedBy.includes(id) ? { ...t, blockedBy: t.blockedBy.filter((b) => b !== id) } : t));
      }
      // "This task blocks those": each of them is now blocked by it. Applied
      // first, since a blocked task can be known when this one is not.
      const blocks = ids(input.addBlocks).filter((b) => b !== id);
      if (blocks.length) {
        list = list.map((t) =>
          blocks.includes(t.id) && !t.blockedBy.includes(id) ? { ...t, blockedBy: [...t.blockedBy, id] } : t,
        );
      }
      const i = at(id);
      // Unknown here (made before the panel saw it): the next TaskList adds it.
      if (i < 0) return list;
      const t = list[i];
      const status = str(input.status);
      return put(i, {
        ...t,
        subject: str(input.subject) ?? t.subject,
        activeForm: str(input.activeForm) ?? t.activeForm,
        owner: str(input.owner) ?? t.owner,
        status: status && STATUSES.has(status) ? (status as TaskStatus) : t.status,
        blockedBy: [...new Set([...t.blockedBy, ...ids(input.addBlockedBy)])],
      });
    }
    case "TaskGet": {
      const id = str(input.taskId);
      if (result.task === null) return id ? list.filter((t) => t.id !== id) : list;
      const g = result.task;
      const gid = str(g?.id);
      if (!gid) return list;
      const i = at(gid);
      const t = i >= 0 ? list[i] : undefined;
      return put(i, {
        id: gid,
        subject: str(g.subject) ?? t?.subject ?? `Task #${gid}`,
        activeForm: t?.activeForm,
        status: STATUSES.has(g.status) ? g.status : t?.status ?? "pending",
        owner: t?.owner,
        blockedBy: Array.isArray(g.blockedBy) ? ids(g.blockedBy) : t?.blockedBy ?? [],
      });
    }
    case "TaskList": {
      if (!Array.isArray(result.tasks)) return list;
      return result.tasks.flatMap((r: any): Task[] => {
        const id = str(r?.id);
        if (!id) return [];
        const t = list.find((x) => x.id === id);
        return [{
          id,
          subject: str(r.subject) ?? t?.subject ?? `Task #${id}`,
          activeForm: t?.activeForm,
          status: STATUSES.has(r.status) ? r.status : t?.status ?? "pending",
          owner: str(r.owner),
          blockedBy: ids(r.blockedBy),
        }];
      });
    }
    default:
      return list;
  }
}

/** The list a run of ops makes, from nothing. */
export function foldTasks(ops: readonly TaskOp[]): Task[] {
  return ops.reduce(applyOp, [] as Task[]);
}

/**
 * The state after one live op. One already applied (a rejoin replays the
 * turn's events) returns `prev` itself.
 */
export function nextTasks(prev: TaskState, op: TaskOp): TaskState {
  if (!op?.tool_use_id || prev.ops.some((o) => o.tool_use_id === op.tool_use_id)) return prev;
  return { ops: [...prev.ops, op], tasks: applyOp(prev.tasks, op) };
}

/**
 * The state after loading a transcript: history's ops in order, then the live
 * ones the transcript does not have yet (it runs behind the stream), folded
 * afresh. Safe to repeat. Like the plan, a load never clears: a thread switch
 * does that.
 */
export function seedTasks(prev: TaskState, messages: readonly HistoryMsg[]): TaskState {
  const ops: TaskOp[] = [];
  for (const m of messages) {
    for (const b of m.content || []) {
      if (b.task && b.tool_use_id) ops.push({ ...b.task, tool_use_id: b.tool_use_id });
    }
  }
  if (!ops.length) return prev;
  const known = new Set(ops.map((o) => o.tool_use_id));
  const all = [...ops, ...prev.ops.filter((o) => !known.has(o.tool_use_id))];
  if (all.length === prev.ops.length && all.every((o, i) => o.tool_use_id === prev.ops[i].tool_use_id)) return prev;
  return { ops: all, tasks: foldTasks(all) };
}

/** The panel's collapsed line: the task under way, else the next one up. */
export function taskSummary(list: readonly Task[]): string {
  const now = list.find((t) => t.status === "in_progress");
  if (now) return now.activeForm || now.subject;
  const next = list.find((t) => t.status === "pending");
  return next ? next.subject : "All tasks done";
}
