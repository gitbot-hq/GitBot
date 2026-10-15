import { randomUUID } from "crypto";
import { join } from "path";
import { dataDir, quarantineCorrupt, readCollection, writeCollection } from "./json-store";
import { getThread, type Bot, type TurnOutcome } from "./bot-store";
import { countOccurrences, isIsoInstant, isUsableWhen, minGapMinutes, nextOccurrence, parseWhen, upcomingRuns, type When } from "./schedule-time";

// Schedules: a prompt gitbot sends itself at a given time, or again and
// again (cron, interval), as a real turn on a thread. Stored in
// <dataDir>/schedules.json, read fully and written atomically
// (json-store.ts). The scheduler (scheduler.ts) fires them; this module is
// their types, validation, limits, storage, and the rules for what a due
// time does to a schedule (runs counted, runs missed, the next time, the
// end). The time maths is schedule-time.ts.

// --- Types ---

export interface Schedule {
  id: string;
  /** Shown in the UI, a push, and the agent's tag. ≤ 60 chars, no quotes or <>. */
  name: string;
  /** The message the turn sends. ≤ 4000 chars, text only. */
  prompt: string;
  /** A cron's `tz` is an IANA zone; an interval runs at anchor + N, + 2N, … minutes. */
  when: When;
  target:
    | { kind: "thread"; threadId: string }
    | { kind: "new-thread"; botId: string; projectId: string; permissionMode?: Bot["permissionMode"] };
  /** The Jarvis thread that gets the schedule note (its creator). */
  notesTo?: string;
  createdBy: { kind: "jarvis"; threadId: string } | { kind: "user"; remote?: string };
  enabled: boolean;
  /**
   * Why it is paused: PAUSED_BY_USER, its failures, or a start that can never
   * work (scheduler.ts). Absent while it runs, and on one that has ended.
   */
  pausedReason?: string;
  /**
   * What a fire does when its target is busy. `queue` (the default): it waits
   * as `pending`, and starts once the thread is free. `skip`: it is recorded
   * `skipped-busy`, and nothing starts.
   */
  overlap: "queue" | "skip";
  /**
   * Which of its turns' ends push, and leave the thread's unread dot
   * (attention.ts, scheduledOutcomeIsQuiet): `always`, only `on-failure`, or
   * `never`. Default by gap: defaultNotify. Needs-you pushes, and the push
   * for a pause, go out whatever it says.
   */
  notify: Notify;
  /** It ends once runCount reaches this. */
  maxRuns?: number;
  /** No run at or after this time; it ends instead. */
  endsAt?: string;
  /**
   * Runs used up so far: every fire claimed, however it turned out, every
   * queued fire given up (replaced by a newer one, or found at startup; not
   * one a pause or a new `when` dropped, which never ran), and
   * every run missed (while gitbot was down, or while a fire waited). A
   * fire's "run N" is this count when it was claimed. A pending fire is not
   * counted until it starts, but it holds its run: see runsLeft.
   */
  runCount: number;
  /** Failed runs in a row; it pauses at PAUSE_AFTER_FAILURES (scheduler.ts). */
  consecutiveFailures: number;
  /** When it next fires; null once it never will. */
  nextRunAt: string | null;
  lastRunAt?: string;
  /**
   * A fire that found its thread busy (`overlap: "queue"`) and waits for it to
   * be free: at most one per schedule, `dueAt` being when that fire came due.
   * A newer fire replaces it (the old one is recorded `skipped-busy`). The
   * deferred-turn drain starts it when the thread's turn ends
   * (deferred-turns.ts), and it is claimed then; a restart records it missed.
   * It may outlive the schedule's end: a once, or a last run, still waits.
   * `manual`: a run now the user asked for, not one of its times; a new
   * `when` keeps it (a due fire of the old times is dropped).
   */
  pending?: { dueAt: string; manual?: true };
  /** The last HISTORY_MAX runs, oldest first (see trimHistory). */
  history: ScheduleRun[];
  createdAt: string;
  updatedAt: string;
}

export type Notify = "always" | "on-failure" | "never";

export interface ScheduleRun {
  at: string;
  outcome: "started" | "skipped-busy" | "missed" | "failed-to-start";
  missedCount?: number;
  /** How late it started: held by the rate cap, or queued behind a busy thread. */
  delayedMs?: number;
  /** A queued fire a newer one replaced (`skipped-busy`): when it came due. */
  dueAt?: string;
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
export const MAX_RUNS_MAX = 100_000;
/** At this many minutes between runs or more, a schedule pushes every run by default. */
export const NOTIFY_ALWAYS_GAP_MINUTES = 15;

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

/**
 * True for what this build can fire: a once, cron or interval (whose times
 * it can work out) on a thread. Not a new-thread target yet, nor a `when`
 * it can't read (a bad pattern written by hand).
 */
export function isRunnable(s: Pick<Schedule, "when" | "target">): boolean {
  return isUsableWhen(s.when) && s.target?.kind === "thread" && typeof s.target.threadId === "string";
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
  s.history = trimHistory(s.history);
  s.updatedAt = now();
  writeCollection(file(), all);
  return s;
}

/**
 * The last HISTORY_MAX entries, but never the newest `started` one still
 * waiting for its turn's outcome: its turn may be running yet (a 1-minute
 * schedule whose own turn runs long logs a `skipped-busy` every minute), and
 * its outcome is still to be written to it. Kept in place of the oldest.
 */
function trimHistory(history: ScheduleRun[]): ScheduleRun[] {
  if (history.length <= HISTORY_MAX) return history;
  const kept = history.slice(-HISTORY_MAX);
  let open: ScheduleRun | undefined;
  for (let i = history.length - 1; i >= 0 && !open; i--) {
    if (history[i].outcome === "started" && !history[i].turnOutcome) open = history[i];
  }
  if (!open || kept.includes(open)) return kept;
  return [open, ...history.slice(-(HISTORY_MAX - 1))];
}

export function deleteSchedule(id: string): boolean {
  const all = listForWrite();
  const remaining = all.filter((s) => s.id !== id);
  if (remaining.length === all.length) return false;
  writeCollection(file(), remaining);
  return true;
}

// --- What a due time does to a schedule ---

const iso = (ms: number) => new Date(ms).toISOString();

/** Done: kept, with its history, but never fires again. */
function endSchedule(s: Schedule): void {
  s.enabled = false;
  s.nextRunAt = null;
}

/**
 * Runs it may still use: Infinity without a maxRuns. A pending fire holds
 * one: it is counted only when it starts (or is given up), but no later fire
 * may take its place, so a schedule whose pending fire is its last has ended.
 */
function runsLeft(s: Schedule): number {
  return s.maxRuns ? Math.max(0, s.maxRuns - s.runCount - (s.pending ? 1 : 0)) : Infinity;
}

export interface SettledDue {
  /** The fire's run number, when it fires; absent when it must not. */
  run?: number;
  /** True when the fire was queued as `pending` instead (`fire: "queue"`). */
  queued?: boolean;
  /** One entry for every run that came due and will never fire. */
  missed?: ScheduleRun;
  /** True when the missed count was estimated (a very long gap). */
  estimated?: boolean;
}

/**
 * The schedule's due time (`nextRunAt`, at or before `now`) has come; mutates
 * `s` for it. With `fire`, the scheduler is about to start that run: it is
 * counted, unless the schedule may no longer run (`endsAt` has passed, or
 * maxRuns is used up), in which case nothing fires. With `fire: "queue"` the
 * thread is busy: the run becomes `pending` instead, uncounted until it
 * starts (the caller has already given up any older pending fire). Without `fire` (startup
 * after gitbot was down; a retry of that; or a fire found far too late, the
 * process having been suspended), the run is missed.
 *
 * Runs that came due between then and now and will not fire (gitbot was
 * down or suspended, or the fire waited for the rate cap) become one
 * `missed` entry with their count. They never fire late (decision 3), and
 * count toward maxRuns. Runs at or after `endsAt`, or past maxRuns, would
 * never have happened, so they are not counted.
 *
 * Then the schedule moves to its next run strictly after both its due time
 * and now, or ends: a once after its time, a recurring one when maxRuns is
 * used up or its next run would be at or after `endsAt`.
 */
export function settleDue(s: Schedule, now: number, fire: boolean | "queue"): SettledDue {
  const out: SettledDue = {};
  const due = Date.parse(s.nextRunAt!);
  const endsAt = s.endsAt ? Date.parse(s.endsAt) : Infinity;
  const lastCountable = Math.min(now, endsAt - 1);

  let missedFrom: number | null = due;
  if (fire && due < endsAt && now < endsAt && runsLeft(s) > 0) {
    if (fire === "queue") {
      s.pending = { dueAt: s.nextRunAt! };
      out.queued = true;
    } else {
      s.runCount += 1;
      out.run = s.runCount;
      s.lastRunAt = iso(now);
    }
    missedFrom = s.when.kind === "once" ? null : nextOccurrence(s.when, due);
  }
  if (missedFrom != null && missedFrom <= lastCountable) {
    const { count, estimated } = countOccurrences(s.when, missedFrom, lastCountable, runsLeft(s));
    if (count > 0) {
      s.runCount += count;
      out.missed = { at: iso(missedFrom), outcome: "missed", missedCount: count };
      if (estimated) out.estimated = true;
    }
  }

  moveToNextRun(s, Math.max(now, due), endsAt);
  return out;
}

/**
 * Sets the next run strictly after `from`, or ends the schedule. The next
 * run never goes back or stays put: if it would, the schedule ends rather
 * than risk firing again and again (schedule-time.ts already steps croner
 * past DST changes, so this is a last guard).
 */
function moveToNextRun(s: Schedule, from: number, endsAt: number): void {
  if (s.when.kind === "once" || runsLeft(s) <= 0) return endSchedule(s);
  const next = nextOccurrence(s.when, from);
  if (next == null || next >= endsAt) return endSchedule(s);
  if (!(next > from)) {
    console.error(`[schedules] ${s.id}: the next run (${iso(next)}) is not after ${iso(from)}; ending the schedule rather than fire it again`);
    return endSchedule(s);
  }
  s.nextRunAt = iso(next);
}

/**
 * A run now (POST /schedules/:id/run) when nothing is due: it counts as a
 * run and leaves the next due time be, unless that run used up maxRuns.
 * Returns the run's number.
 */
export function claimManualRun(s: Schedule, now: number): number {
  s.runCount += 1;
  s.lastRunAt = iso(now);
  if (s.enabled && runsLeft(s) <= 0) endSchedule(s);
  return s.runCount;
}

/**
 * A run now that found the thread busy (`overlap: "queue"`): it waits as
 * `pending` like a due fire, and counts once it starts. Like claimManualRun,
 * it leaves the next due time be, unless it holds the last run.
 */
export function queueManualRun(s: Schedule, now: number): void {
  s.pending = { dueAt: iso(now), manual: true };
  if (s.enabled && runsLeft(s) <= 0) endSchedule(s);
}

/**
 * Gives up the schedule's pending fire, if it has one: it counts as a run
 * used up, and leaves an entry (`skipped-busy` when a newer fire replaced it,
 * `missed` when a restart found it). Returns that entry.
 */
export function dropPending(s: Schedule, now: number, outcome: "skipped-busy" | "missed"): ScheduleRun | undefined {
  if (!s.pending) return undefined;
  const dueAt = s.pending.dueAt;
  delete s.pending;
  s.runCount += 1;
  const threadId = targetThreadId(s);
  const entry: ScheduleRun = outcome === "missed"
    ? { at: dueAt, outcome, missedCount: 1 }
    : { at: iso(now), outcome, dueAt, ...(threadId ? { threadId } : {}) };
  s.history.push(entry);
  return entry;
}

// --- Pausing, resuming and editing ---

/** After this many failed runs in a row, a schedule pauses itself. */
export const PAUSE_AFTER_FAILURES = 3;

/** The pausedReason of a schedule the user paused. */
export const PAUSED_BY_USER = "paused by the user";

/**
 * Pauses the schedule: it fires no more until it is resumed. Its pending
 * fire, if any, is dropped: it never started, so it is not counted (and no
 * longer holds a run). Returns that fire's dueAt.
 */
export function pauseSchedule(s: Schedule, reason: string): string | undefined {
  s.enabled = false;
  s.nextRunAt = null;
  s.pausedReason = reason;
  const dropped = s.pending?.dueAt;
  delete s.pending;
  return dropped;
}

/**
 * True when the schedule can never fire again from `now`, paused or not: a
 * once whose time has passed (so one that has fired or been missed), a
 * used-up maxRuns, or no run left before endsAt. Resuming it is refused.
 * A once goes by its time alone: runCount spans the schedule's whole life
 * (runs of an earlier `when`, a run now before its time), and none of those
 * use up the once.
 */
export function hasEnded(s: Schedule, now: number): boolean {
  if (s.when.kind === "once") return Date.parse(s.when.at) <= now;
  if (runsLeft(s) <= 0) return true;
  const next = nextOccurrence(s.when, now);
  return next == null || (!!s.endsAt && next >= Date.parse(s.endsAt));
}

/** What PATCH /schedules/:id may change. */
export const EDITABLE_FIELDS = ["enabled", "name", "prompt", "when", "overlap", "notify", "maxRuns", "endsAt"] as const;

export type EditScheduleResult =
  | {
      ok: true;
      schedule: Schedule;
      /** "pause" or "resume" when `enabled` changed it, else "update". */
      verb: "pause" | "resume" | "update";
      /** The pending fire the edit dropped: its dueAt. */
      droppedPending?: string;
    }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Changes a schedule from a PATCH body: `enabled` to pause or resume it, and
 * `name`, `prompt`, `when`, `overlap`, `notify`, `maxRuns`, `endsAt` (null
 * clears the last two), checked as createSchedule checks them. A refused edit
 * changes nothing. A new `when` keeps the stored `notify`: only a schedule
 * being created takes the default by gap.
 *
 * Pausing drops the pending fire. Resuming clears pausedReason, resets
 * consecutiveFailures and sets nextRunAt to the next run after now: runs
 * that came due while it was paused never fire (decision 3), and are not
 * counted. A schedule that has ended (hasEnded) is not resumed. A new `when`
 * drops the pending fire (it was a fire of the old times) and, on a schedule
 * that is enabled, moves nextRunAt to its first run after now.
 */
export function editSchedule(id: string, body: any, at: number = Date.now()): EditScheduleResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const keys = Object.keys(body);
  const editable: readonly string[] = EDITABLE_FIELDS;
  const fields = `${EDITABLE_FIELDS.join(", ")}`;
  const unknown = keys.find((k) => !editable.includes(k));
  if (unknown) return { ok: false, status: 400, error: `${unknown} cannot be changed: a schedule's PATCH takes ${fields}` };
  if (!keys.length) return { ok: false, status: 400, error: `nothing to change: a schedule's PATCH takes ${fields}` };

  const { enabled, name, prompt, overlap, notify, maxRuns, endsAt } = body;
  if (enabled !== undefined && typeof enabled !== "boolean") return { ok: false, status: 400, error: "enabled must be true or false" };
  if (name !== undefined) {
    const bad = nameError(name);
    if (bad) return { ok: false, status: 400, error: bad };
  }
  if (prompt !== undefined) {
    const bad = promptError(prompt);
    if (bad) return { ok: false, status: 400, error: bad };
  }
  let when: When | undefined;
  if (body.when !== undefined) {
    const parsed = parseWhen(body.when, at);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    if (nextOccurrence(parsed.when, at) == null) return { ok: false, status: 400, error: "when never comes due" };
    when = parsed.when;
  }
  if (overlap !== undefined && overlap !== "queue" && overlap !== "skip") {
    return { ok: false, status: 400, error: `overlap must be "queue" or "skip"` };
  }
  if (notify !== undefined && !isNotify(notify)) return { ok: false, status: 400, error: NOTIFY_ERROR };
  if (maxRuns != null && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_RUNS_MAX)) {
    return { ok: false, status: 400, error: `maxRuns must be a whole number from 1 to ${MAX_RUNS_MAX}` };
  }
  if (endsAt != null && !isIsoInstant(endsAt)) {
    return { ok: false, status: 400, error: "endsAt must be an ISO 8601 time with a zone, e.g. 2026-10-14T17:00:00Z" };
  }

  let error: { status: 400; error: string } | undefined;
  let verb: "pause" | "resume" | "update" = "update";
  let droppedPending: string | undefined;
  const refuse = (message: string): false => {
    error = { status: 400, error: message };
    return false;
  };
  // Edits the freshly read schedule; a refusal returns false, so nothing is saved.
  const updated = updateSchedule(id, (s) => {
    const resuming = enabled === true && !s.enabled;
    const pausing = enabled === false && (s.enabled || !!s.pending);
    // Ended already: disabled, not by a pause.
    const wasEnded = !s.enabled && !s.pausedReason;
    if ((when || resuming) && !isRunnable({ when: when ?? s.when, target: s.target })) {
      return refuse(`this schedule (${(when ?? s.when)?.kind} on ${s.target?.kind}) is not supported by this build`);
    }

    if (name !== undefined) s.name = name.trim();
    if (prompt !== undefined) s.prompt = prompt;
    if (overlap !== undefined) s.overlap = overlap;
    if (notify !== undefined) s.notify = notify;
    if (when) {
      s.when = when;
      // A once runs one time: whatever ending the old times had goes.
      if (when.kind === "once") {
        delete s.maxRuns;
        delete s.endsAt;
      }
      // A due fire still waiting was one of the old times: it goes. A run
      // now the user queued is not, and still runs when the thread is free.
      if (s.pending && !s.pending.manual) {
        droppedPending = s.pending.dueAt;
        delete s.pending;
      }
    }
    if (s.when.kind === "once" && (maxRuns != null || endsAt != null)) {
      return refuse("maxRuns and endsAt are for cron and interval schedules: a once runs one time");
    }
    if (maxRuns === null) delete s.maxRuns;
    else if (maxRuns !== undefined) s.maxRuns = maxRuns;
    if (endsAt === null) delete s.endsAt;
    else if (endsAt !== undefined) s.endsAt = endsAt;

    if (pausing) {
      droppedPending = pauseSchedule(s, s.pausedReason ?? PAUSED_BY_USER) ?? droppedPending;
      // One that had ended and only held a fire (a once, or its last run, on
      // a busy thread) loses that fire and stays ended: no reason, since
      // there is nothing to resume. Paused only if dropping the fire freed a
      // run it can still use (a maxRuns).
      if (wasEnded && hasEnded(s, at)) delete s.pausedReason;
      verb = "pause";
      return;
    }
    if (resuming) {
      if (hasEnded(s, at)) return refuse("this schedule has ended");
      s.enabled = true;
      delete s.pausedReason;
      s.consecutiveFailures = 0;
      verb = "resume";
    }
    if (!s.enabled) return;

    // Enabled: its next run, from the new times (or after a resume, from now).
    if (when || resuming) {
      const next = nextOccurrence(s.when, at);
      if (next == null) return refuse("when never comes due");
      // A once keeps `at` exactly as sent, as on create.
      s.nextRunAt = s.when.kind === "once" ? s.when.at : iso(next);
    }
    if (s.nextRunAt && s.endsAt && Date.parse(s.endsAt) <= Date.parse(s.nextRunAt)) {
      return refuse(`endsAt must be after the next run (${s.nextRunAt})`);
    }
    if (s.maxRuns && runsLeft(s) <= 0) {
      return refuse(`maxRuns must be more than the runs used so far (${s.runCount}${s.pending ? ", and one waiting" : ""})`);
    }
  });
  if (!updated) return { ok: false, status: 404, error: "Schedule not found" };
  if (error) return { ok: false, ...error };
  return { ok: true, schedule: updated, verb, ...(droppedPending ? { droppedPending } : {}) };
}

/**
 * The schedule's next `n` run times (ISO), as they stand: from `nextRunAt`,
 * before `endsAt`, and no more than maxRuns allows. Empty once it has ended.
 */
export function nextRunsOf(s: Schedule, n = 3): string[] {
  if (!s.enabled || !s.nextRunAt || !isUsableWhen(s.when)) return [];
  return upcomingRuns(s.when, Date.parse(s.nextRunAt), n, {
    endsAt: s.endsAt ? Date.parse(s.endsAt) : undefined,
    runsLeft: runsLeft(s),
  }).map(iso);
}

// --- Validation and creation ---

export type NewScheduleResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

/** Why a name can't be used, or null. It rides in the agent's tag, so no quotes or <>. */
export function nameError(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return "name is required";
  if (name.length > NAME_MAX) return `name must be at most ${NAME_MAX} characters`;
  if (/["'<>]/.test(name)) return `name must not contain quotes or < >`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "name must be one line of plain text";
  return null;
}

const NOTIFY_VALUES: readonly Notify[] = ["always", "on-failure", "never"];
const NOTIFY_ERROR = `notify must be "always", "on-failure" or "never"`;

export function isNotify(value: unknown): value is Notify {
  return NOTIFY_VALUES.includes(value as Notify);
}

/**
 * The `notify` a new schedule gets when none is given: `always` when its
 * runs are at least NOTIFY_ALWAYS_GAP_MINUTES apart (a once counts as an
 * endless gap), else `on-failure`, so a schedule every minute does not push,
 * and leave an unread dot, sixty times an hour (M6). The gap is the closest
 * two runs come from `at` on (minGapMinutes).
 */
export function defaultNotify(when: When, at: number): Notify {
  return minGapMinutes(when, at) >= NOTIFY_ALWAYS_GAP_MINUTES ? "always" : "on-failure";
}

/** Why a prompt can't be used, or null. */
export function promptError(prompt: unknown): string | null {
  if (typeof prompt !== "string" || !prompt.trim()) return "prompt is required";
  if (prompt.length > PROMPT_MAX) return `prompt must be at most ${PROMPT_MAX} characters`;
  return null;
}

/**
 * Checks a new schedule from a request body and stores it. Only what this
 * build runs is accepted: a once, cron or interval on an existing thread.
 * Anything else is refused, not stored half-understood.
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

  const parsed = parseWhen(when, at);
  if (!parsed.ok) return parsed;
  const first = nextOccurrence(parsed.when, at);
  if (first == null) return { ok: false, error: "when never comes due" };

  // How it ends: for a cron or interval only (a once ends after its run).
  const { maxRuns, endsAt } = body;
  if (parsed.when.kind === "once" && (maxRuns !== undefined || endsAt !== undefined)) {
    return { ok: false, error: "maxRuns and endsAt are for cron and interval schedules: a once runs one time" };
  }
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_RUNS_MAX)) {
    return { ok: false, error: `maxRuns must be a whole number from 1 to ${MAX_RUNS_MAX}` };
  }
  if (endsAt !== undefined) {
    if (!isIsoInstant(endsAt)) return { ok: false, error: "endsAt must be an ISO 8601 time with a zone, e.g. 2026-10-14T17:00:00Z" };
    if (Date.parse(endsAt) <= first) return { ok: false, error: `endsAt must be after the first run (${iso(first)})` };
  }

  const { overlap, notify } = body;
  if (overlap !== undefined && overlap !== "queue" && overlap !== "skip") {
    return { ok: false, error: `overlap must be "queue" or "skip"` };
  }
  if (notify !== undefined && !isNotify(notify)) return { ok: false, error: NOTIFY_ERROR };

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
    when: parsed.when,
    target: { kind: "thread", threadId: thread.id },
    createdBy,
    enabled: true,
    overlap: overlap ?? "queue",
    notify: notify ?? defaultNotify(parsed.when, at),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
    runCount: 0,
    consecutiveFailures: 0,
    // A once keeps `at` exactly as sent; a cron or interval its first run.
    nextRunAt: parsed.when.kind === "once" ? parsed.when.at : iso(first),
    history: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  writeCollection(file(), [...all, schedule]);
  return { ok: true, schedule };
}
