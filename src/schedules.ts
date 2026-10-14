import { randomUUID } from "crypto";
import { join } from "path";
import { dataDir, quarantineCorrupt, readCollection, writeCollection } from "./json-store";
import { getThread, type Bot, type TurnOutcome } from "./bot-store";

// Schedules: a prompt gitbot sends itself at a given time, as a real turn on
// a thread. Stored in <dataDir>/schedules.json, read fully and written
// atomically (json-store.ts). The scheduler (scheduler.ts) fires them; this
// module is their types, validation, limits and storage only.

// --- Types ---

export interface Schedule {
  id: string;
  /** Shown in the UI, a push, and the agent's tag. ≤ 60 chars, no quotes or <>. */
  name: string;
  /** The message the turn sends. ≤ 4000 chars, text only. */
  prompt: string;
  when:
    | { kind: "once"; at: string }
    | { kind: "cron"; expr: string; tz: string }
    | { kind: "interval"; everyMinutes: number; anchor: string };
  target:
    | { kind: "thread"; threadId: string }
    | { kind: "new-thread"; botId: string; projectId: string; permissionMode?: Bot["permissionMode"] };
  /** The Jarvis thread that gets the schedule note (its creator). */
  notesTo?: string;
  createdBy: { kind: "jarvis"; threadId: string } | { kind: "user"; remote?: string };
  enabled: boolean;
  pausedReason?: string;
  /** What a fire does when its target is busy. Stored; not read yet (always skipped). */
  overlap: "queue" | "skip";
  /** Which of its turns' ends push. Stored; not read yet. */
  notify: "always" | "on-failure" | "never";
  maxRuns?: number;
  endsAt?: string;
  /** Fires claimed so far, however each turned out. */
  runCount: number;
  consecutiveFailures: number;
  /** When it next fires; null once it never will. */
  nextRunAt: string | null;
  lastRunAt?: string;
  pending?: { dueAt: string };
  /** The last HISTORY_MAX runs, oldest first. */
  history: ScheduleRun[];
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  at: string;
  outcome: "started" | "skipped-busy" | "missed" | "failed-to-start";
  missedCount?: number;
  delayedMs?: number;
  threadId?: string;
  /** How the turn a "started" run began ended, once it has. */
  turnOutcome?: TurnOutcome;
  error?: string;
}

// --- Limits ---

export const NAME_MAX = 60;
export const PROMPT_MAX = 4000;
export const SCHEDULES_MAX = 100;
export const SCHEDULES_PER_THREAD_MAX = 20;
export const HISTORY_MAX = 20;

// --- Storage ---

function file(): string {
  return join(dataDir(), "schedules.json");
}

const now = () => new Date().toISOString();

/** Every schedule, or those targeting one thread. */
export function listSchedules(filter: { threadId?: string } = {}): Schedule[] {
  const all = readCollection<Schedule>(file(), "schedules");
  return filter.threadId ? all.filter((s) => targetThreadId(s) === filter.threadId) : all;
}

/**
 * Every schedule, read to be written back. A schedules.json that does not
 * parse is moved aside first (schedules.json.bad-<time>), so the write that
 * follows never overwrites what it could not read.
 */
function listForWrite(): Schedule[] {
  quarantineCorrupt(file(), "schedules");
  return listSchedules();
}

export function getSchedule(id: string): Schedule | undefined {
  return listSchedules().find((s) => s.id === id);
}

/** True for the kinds this build can fire: a `once` on a thread. */
export function isRunnable(s: Pick<Schedule, "when" | "target">): boolean {
  return s.when?.kind === "once" && s.target?.kind === "thread" && typeof s.target.threadId === "string";
}

/** A schedule that may still fire. A fired or missed once is kept for its history, but is done. */
export function canStillFire(s: Pick<Schedule, "enabled" | "nextRunAt">): boolean {
  return s.enabled || s.nextRunAt != null;
}

/** The thread a thread-target schedule runs on. */
export function targetThreadId(s: Pick<Schedule, "target">): string | undefined {
  return s.target?.kind === "thread" ? s.target.threadId : undefined;
}

/**
 * Changes one schedule in place and saves it. `edit` mutates the schedule it
 * is given, or returns false to change nothing (and write nothing). The read,
 * the edit and the write happen in one synchronous step, so no other change
 * can land in between. Returns the schedule as it now stands.
 */
export function updateSchedule(id: string, edit: (s: Schedule) => void | false): Schedule | undefined {
  const all = listForWrite();
  const s = all.find((x) => x.id === id);
  if (!s) return undefined;
  if (edit(s) === false) return s;
  if (s.history.length > HISTORY_MAX) s.history = s.history.slice(-HISTORY_MAX);
  s.updatedAt = now();
  writeCollection(file(), all);
  return s;
}

export function deleteSchedule(id: string): boolean {
  const all = listForWrite();
  const remaining = all.filter((s) => s.id !== id);
  if (remaining.length === all.length) return false;
  writeCollection(file(), remaining);
  return true;
}

// --- Validation and creation ---

export type NewScheduleResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

/**
 * An ISO instant whose fields are all real: no 30 February, no hour 24.
 * (Date.parse rolls impossible dates over to the next month, so the regex
 * alone would store a "2026-02-30" that fires on 2 March.)
 */
function isIsoInstant(at: string): boolean {
  const m = ISO_INSTANT_FIELDS.exec(at);
  if (!m || Number.isNaN(Date.parse(at))) return false;
  const [, y, mo, d, h, mi, sec, oh, om] = m.map((x) => (x === undefined ? undefined : Number(x)));
  const daysInMonth = new Date(Date.UTC(y!, mo!, 0)).getUTCDate();
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > daysInMonth) return false;
  if (h! > 23 || mi! > 59 || (sec ?? 0) > 59) return false;
  if ((oh ?? 0) > 23 || (om ?? 0) > 59) return false;
  return true;
}
/** "at" as an ISO instant: a date, a time, and an explicit zone (Z or ±hh:mm). */
const ISO_INSTANT_FIELDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Why a name can't be used, or null. It rides in the agent's tag, so no quotes or <>. */
export function nameError(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return "name is required";
  if (name.length > NAME_MAX) return `name must be at most ${NAME_MAX} characters`;
  if (/["'<>]/.test(name)) return `name must not contain quotes or < >`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "name must be one line of plain text";
  return null;
}

/** Why a prompt can't be used, or null. */
export function promptError(prompt: unknown): string | null {
  if (typeof prompt !== "string" || !prompt.trim()) return "prompt is required";
  if (prompt.length > PROMPT_MAX) return `prompt must be at most ${PROMPT_MAX} characters`;
  return null;
}

/**
 * Checks a new schedule from a request body and stores it. Only what this
 * build runs is accepted: a `once` on an existing thread. Anything else is
 * refused, not stored half-understood.
 */
export function createSchedule(
  body: any,
  createdBy: Schedule["createdBy"],
  at: number = Date.now(),
): NewScheduleResult {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const { name, prompt, when, target } = body;

  const badName = nameError(name);
  if (badName) return { ok: false, error: badName };
  const badPrompt = promptError(prompt);
  if (badPrompt) return { ok: false, error: badPrompt };
  if (body.attachments !== undefined) return { ok: false, error: "a schedule's prompt is text only: attachments are not supported" };

  if (!when || typeof when !== "object") return { ok: false, error: "when is required" };
  if (when.kind !== "once") return { ok: false, error: `when.kind "${String(when.kind)}" is not supported yet: use "once"` };
  if (typeof when.at !== "string" || !isIsoInstant(when.at)) {
    return { ok: false, error: "when.at must be an ISO 8601 time with a zone, e.g. 2026-10-14T17:00:00Z" };
  }
  if (Date.parse(when.at) <= at) return { ok: false, error: "when.at must be in the future" };

  if (!target || typeof target !== "object") return { ok: false, error: "target is required" };
  if (target.kind !== "thread") return { ok: false, error: `target.kind "${String(target.kind)}" is not supported yet: use "thread"` };
  if (typeof target.threadId !== "string" || !target.threadId) return { ok: false, error: "target.threadId is required" };
  const thread = getThread(target.threadId);
  if (!thread) return { ok: false, error: `no thread with id "${target.threadId}"` };
  if (thread.kind === "setup") return { ok: false, error: "a bot's setup thread cannot be scheduled" };

  const all = listForWrite();
  // The total counts every stored schedule (it bounds the file); a thread's
  // 20 counts only those that can still fire, so fired one-shots kept for
  // their history never block a new one.
  if (all.length >= SCHEDULES_MAX) return { ok: false, error: `at most ${SCHEDULES_MAX} schedules: delete one first` };
  if (all.filter((s) => targetThreadId(s) === thread.id && canStillFire(s)).length >= SCHEDULES_PER_THREAD_MAX) {
    return { ok: false, error: `at most ${SCHEDULES_PER_THREAD_MAX} active schedules on one thread: delete one first` };
  }

  const stamp = now();
  const schedule: Schedule = {
    id: randomUUID(),
    name: name.trim(),
    prompt,
    when: { kind: "once", at: when.at },
    target: { kind: "thread", threadId: thread.id },
    createdBy,
    enabled: true,
    overlap: "queue",
    notify: "always",
    runCount: 0,
    consecutiveFailures: 0,
    nextRunAt: when.at,
    history: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  writeCollection(file(), [...all, schedule]);
  return { ok: true, schedule };
}
