import { randomUUID } from "crypto";
import { statSync } from "fs";
import { join } from "path";
import { dataDir, quarantineCorrupt, readCollection, writeCollection } from "./json-store";
import { BOT_AGENTS, botSetupError, getBot, getThread, isJarvisBot, listBots, listThreads, threadAgent, type Bot, type Thread, type TurnOutcome } from "./bot-store";
import { findProject, projectId, projectIdForFolder, projectNames } from "./project-index";
import {
  countOccurrences,
  describeWhen,
  isIsoInstant,
  isUsableWhen,
  localHuman,
  minGapMinutes,
  nextOccurrence,
  parseWhen,
  upcomingRuns,
  type When,
} from "./schedule-time";

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
  /**
   * `thread`: every run is a turn on that thread. `new-thread`: every run
   * starts a fresh thread of its own, with that bot (a plain agent is its
   * built-in bot) in that project's folder, owned by the user: it reports to
   * nobody (scheduler.ts, startNewThreadRun).
   */
  target: ThreadTarget | NewThreadTarget;
  /** The Jarvis thread that gets the schedule note (its creator). */
  notesTo?: string;
  createdBy: { kind: "jarvis"; threadId: string } | { kind: "user"; remote?: string };
  /**
   * Set for good once anyone but the Jarvis thread that made it (a route,
   * another Jarvis thread) changed its words or re-armed it: its prompt,
   * name, times, maxRuns, endsAt (markChangedBy; a resume is not one). Such a schedule
   * is no longer that Jarvis's own words: its turns never carry by="you"
   * (scheduler.ts, madeByThisJarvis). A run now by someone else does not set
   * it: only that one run is data (`byOther` on the run, and on `pending`).
   */
  changedByOther?: true;
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
   * `when` keeps it (a due fire of the old times is dropped). `byOther`: a
   * run now on a Jarvis-made schedule by anyone but the Jarvis thread that
   * made it, so that run, when it starts, is data (no by="you").
   */
  pending?: { dueAt: string; manual?: true; byOther?: true };
  /** The last HISTORY_MAX runs, oldest first (see trimHistory). */
  history: ScheduleRun[];
  createdAt: string;
  updatedAt: string;
}

export type Notify = "always" | "on-failure" | "never";

export interface ThreadTarget {
  kind: "thread";
  threadId: string;
}

/**
 * No permission mode, model or effort: a run auto-approves, as every
 * scheduled turn does, and its thread gets the bot's model and effort (or
 * the default), as one the user opens would.
 */
export interface NewThreadTarget {
  kind: "new-thread";
  botId: string;
  projectId: string;
}

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

// --- Write hook ---
// The server tells open UIs that schedules changed (an SSE hint) by
// registering here, so this module never imports the server.

type SchedulesWrittenListener = () => void;
const schedulesWrittenListeners = new Set<SchedulesWrittenListener>();

/** Calls the listener after every write of schedules.json. Returns the unsubscribe. */
export function onSchedulesWritten(listener: SchedulesWrittenListener): () => void {
  schedulesWrittenListeners.add(listener);
  return () => { schedulesWrittenListeners.delete(listener); };
}

/** The one write of schedules.json; then the listeners, none of which can throw into the writer. */
function saveAll(all: Schedule[]): void {
  writeCollection(file(), all);
  for (const listener of [...schedulesWrittenListeners]) {
    try {
      listener();
    } catch (err: any) {
      console.error(`[schedules] write listener: ${err?.message ?? err}`);
    }
  }
}

/** Every schedule, or those targeting one thread. */
export function listSchedules(filter: { threadId?: string } = {}): Schedule[] {
  const all = readCollection<Schedule>(file(), "schedules");
  return filter.threadId ? all.filter((s) => targetThreadId(s) === filter.threadId) : all;
}

/**
 * True when the schedule works in that project: a new-thread target there,
 * or a thread target whose thread's folder is that project's.
 */
export function scheduleInProject(s: Schedule, project: string): boolean {
  if (s.target?.kind === "new-thread") return s.target.projectId === project;
  const thread = getThread(targetThreadId(s) ?? "");
  return !!thread && (projectIdForFolder(thread.repoPath) ?? projectId(thread.repoPath)) === project;
}

/** A schedule as GET /schedules?threadId= lists it: `notesHere` when it is there for its notes only. */
export type ListedSchedule = Schedule & { notesHere?: true };

/**
 * What GET /schedules lists. `threadId`: the schedules that run on that
 * thread, then those whose notes go there (`notesTo`: a Jarvis thread's own,
 * on other threads or making new ones), flagged `notesHere`, so one call
 * gives a thread's schedules panel everything it shows. `projectId`: only
 * those in that project (scheduleInProject).
 */
export function listSchedulesFor(filter: { threadId?: string; projectId?: string } = {}): ListedSchedule[] {
  let all: ListedSchedule[] = listSchedules();
  if (filter.threadId) {
    const id = filter.threadId;
    const on = all.filter((s) => targetThreadId(s) === id);
    const notes = all.filter((s) => targetThreadId(s) !== id && s.notesTo === id).map((s) => ({ ...s, notesHere: true as const }));
    all = [...on, ...notes];
  }
  if (filter.projectId) all = all.filter((s) => scheduleInProject(s, filter.projectId!));
  return all;
}

/**
 * Per thread, its enabled schedules: how many, and the soonest next run
 * (null when none has one). Read fresh for GET /threads, never stored.
 */
export function threadScheduleSummaries(): Map<string, { count: number; nextRunAt: string | null }> {
  const out = new Map<string, { count: number; nextRunAt: string | null }>();
  for (const s of listSchedules()) {
    if (!s.enabled) continue;
    const id = targetThreadId(s);
    if (!id) continue;
    const cur = out.get(id) ?? { count: 0, nextRunAt: null };
    cur.count += 1;
    if (s.nextRunAt && (!cur.nextRunAt || Date.parse(s.nextRunAt) < Date.parse(cur.nextRunAt))) cur.nextRunAt = s.nextRunAt;
    out.set(id, cur);
  }
  return out;
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
 * it can work out) on a thread, or starting a new thread. Not a target kind
 * it doesn't know, nor a `when` it can't read (a bad pattern written by hand).
 */
export function isRunnable(s: Pick<Schedule, "when" | "target">): boolean {
  if (!isUsableWhen(s.when)) return false;
  const target = s.target;
  if (target?.kind === "thread") return typeof target.threadId === "string";
  if (target?.kind === "new-thread") return typeof target.botId === "string" && typeof target.projectId === "string";
  return false;
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
  saveAll(all);
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
  saveAll(remaining);
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
export function queueManualRun(s: Schedule, now: number, byOther = false): void {
  s.pending = { dueAt: iso(now), manual: true, ...(byOther ? { byOther: true as const } : {}) };
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

// --- Deleted threads ---

/** The pausedReason of a new-thread schedule whose Jarvis thread (notesTo) was deleted. */
export const JARVIS_THREAD_GONE = "its Jarvis thread was deleted";

export interface DeletedThreadChanges {
  /** Schedules that ran on the thread: deleted with it. */
  deleted: Schedule[];
  /** New-thread schedules it made: paused (JARVIS_THREAD_GONE). */
  paused: Schedule[];
  /** Other schedules it made: they run on, with no notesTo. */
  detached: Schedule[];
}

/**
 * A thread was deleted (bot-store's onThreadDeleted; the scheduler listens).
 * Its thread-target schedules are deleted: they have nothing left to run on.
 * The schedules whose notes it took lose their notesTo; those that start a
 * new thread each run are paused too, since nobody would hear about their
 * runs but a push (an ended one stays ended, a paused one keeps its reason),
 * while those on another thread keep running there. One write, nothing
 * written when nothing changed.
 */
export function forgetDeletedThread(threadId: string, at: number = Date.now()): DeletedThreadChanges {
  const out: DeletedThreadChanges = { deleted: [], paused: [], detached: [] };
  const all = listSchedules();
  if (!all.some((s) => targetThreadId(s) === threadId || s.notesTo === threadId)) return out;
  const kept: Schedule[] = [];
  for (const s of listForWrite()) {
    if (targetThreadId(s) === threadId) {
      out.deleted.push(s);
      continue;
    }
    kept.push(s);
    if (s.notesTo !== threadId) continue;
    delete s.notesTo;
    s.updatedAt = now();
    if (s.target?.kind === "new-thread" && (s.enabled || s.pending)) {
      const wasEnded = !s.enabled && !s.pausedReason;
      pauseSchedule(s, s.pausedReason ?? JARVIS_THREAD_GONE);
      // One that had ended and only held a fire stays ended (as editSchedule).
      if (wasEnded && hasEnded(s, at)) delete s.pausedReason;
      if (s.pausedReason === JARVIS_THREAD_GONE) {
        out.paused.push(s);
        continue;
      }
    }
    out.detached.push(s);
  }
  saveAll(kept);
  return out;
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

/**
 * True when a run now by `by` would take a Jarvis-made schedule's prompt out
 * of its creator's hands: the schedule was made by a Jarvis thread, and `by`
 * is anyone else (a route, another Jarvis thread). Only that run is data
 * (scheduler.ts, runScheduleNow); the schedule itself is not marked.
 */
export function runIsByOther(s: Pick<Schedule, "createdBy">, by: Schedule["createdBy"]): boolean {
  return s.createdBy?.kind === "jarvis" && !isCreator(s, by);
}

/** True when `by` is the Jarvis thread that made the schedule. */
function isCreator(s: Pick<Schedule, "createdBy">, by: Schedule["createdBy"]): boolean {
  return by.kind === "jarvis" && s.createdBy?.kind === "jarvis" && s.createdBy.threadId === by.threadId;
}

/**
 * The edits that change a schedule's words or re-arm it: new times, prompt,
 * name, or more runs. A resume or pause (`enabled`), notify and overlap
 * change neither: a resume only lets the same words run again.
 */
const REARMING_FIELDS = ["name", "prompt", "when", "maxRuns", "endsAt"] as const;

/**
 * Someone changed the schedule's words or re-armed it: unless that is the
 * Jarvis thread that made it, it is marked changedByOther, for good.
 */
export function markChangedBy(s: Schedule, by: Schedule["createdBy"]): void {
  if (!isCreator(s, by)) s.changedByOther = true;
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
export function editSchedule(
  id: string,
  body: any,
  at: number = Date.now(),
  editor: Schedule["createdBy"] = { kind: "user" },
): EditScheduleResult {
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
    // Saved only if the edit is (a refusal below writes nothing).
    if (REARMING_FIELDS.some((k) => body[k] !== undefined)) markChangedBy(s, editor);
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

/**
 * The schedule in words, for Jarvis to repeat: its times (describeWhen; a
 * once read in `tz`) and how it ends, e.g. "every 2 minutes, at most 2 runs".
 */
export function describeSchedule(s: Pick<Schedule, "when" | "maxRuns" | "endsAt">, tz: string): string {
  if (!isUsableWhen(s.when)) return "a schedule this build cannot read";
  const zone = s.when.kind === "cron" ? s.when.tz : tz;
  const ends = [
    s.maxRuns ? `at most ${s.maxRuns} run${s.maxRuns === 1 ? "" : "s"}` : "",
    s.endsAt ? `until ${localHuman(Date.parse(s.endsAt), zone)} ${zone}` : "",
  ].filter(Boolean);
  return [describeWhen(s.when, tz), ...ends].join(", ");
}

// --- The view GET /schedules lists ---

/**
 * True when the schedule runs on the Jarvis thread that made it with its own
 * create_schedule tool, and nobody else has changed its words or re-armed it
 * since (changedByOther): the only kind whose prompt that Jarvis takes as
 * the user's own request (the tag's by="you"). POST /schedules always
 * records createdBy user. A PATCH of its words or times (or a resume), or
 * another Jarvis thread's update, marks a Jarvis-made one changedByOther for
 * good, so its turns lose by="you" too. A run now by anyone but its creator
 * (the route, the schedules panel, another Jarvis thread) is data for that
 * one run only: startScheduledTurn's `byOther`.
 */
export function madeByThisJarvis(s: Schedule, threadId: string): boolean {
  return s.createdBy?.kind === "jarvis" && s.createdBy.threadId === threadId && !s.changedByOther;
}

export type ScheduleWhere =
  | { kind: "thread"; threadId: string; title: string; botId: string; botName: string; jarvis: boolean }
  | { kind: "new-thread"; botId: string; botName: string; projectId: string; projectName: string }
  | { kind: "missing" };

export interface ScheduleAttention {
  kind: "paused" | "failed";
  text: string;
  at: string;
}

/**
 * A schedule as GET /schedules lists it: the stored record plus fields
 * derived on every read, never stored.
 */
export type ScheduleView = ListedSchedule & {
  describe: string;
  state: "active" | "paused" | "ended";
  /** Paused and still able to fire: Resume is offered only then. */
  canResume: boolean;
  where: ScheduleWhere;
  attention?: ScheduleAttention;
  /** madeByThisJarvis on its own target thread. */
  ownWords: boolean;
  /** The Jarvis thread that made it, while that thread exists (the card links it). */
  createdIn?: { threadId: string; title: string; botId: string };
  nextRuns: string[];
  history: (ScheduleRun & { botId?: string })[];
};

/** What viewSchedule reads, once per request. */
export interface ViewContext {
  tz: string;
  now: number;
  threads: Map<string, Thread>;
  bots: Map<string, Bot>;
  projects: Map<string, string>;
}

/** Threads, bots and project names, read once for a whole list. */
export function viewContext(tz: string, now: number): ViewContext {
  return {
    tz,
    now,
    threads: new Map(listThreads().map((t) => [t.id, t])),
    // Every built-in, installed or not, so old threads still name their bot.
    bots: new Map(listBots(BOT_AGENTS).map((b) => [b.id, b])),
    projects: projectNames(),
  };
}

/**
 * The run's thread hasn't been looked at since the run: no thread (a start
 * that made none), or one last seen before it. Tied to the run itself, not
 * the thread's other news: a failed start writes none, and later news must
 * not bring back a failure already seen.
 */
function unseenSince(t: Thread | undefined, at: string): boolean {
  return !t?.lastSeenAt || Date.parse(t.lastSeenAt) < Date.parse(at);
}

/** Its last real run failed, and the thread it failed on hasn't been seen since. */
function failedAttention(s: Schedule, threads: Map<string, Thread>): ScheduleAttention | undefined {
  const runs = s.history ?? [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.outcome === "failed-to-start") {
      const t = r.threadId ? threads.get(r.threadId) : undefined;
      return unseenSince(t, r.at) ? { kind: "failed", text: "Last run failed to start", at: r.at } : undefined;
    }
    if (r.outcome === "started") {
      if (r.turnOutcome !== "failed") return undefined;
      const t = r.threadId ? threads.get(r.threadId) : undefined;
      return unseenSince(t, r.at) ? { kind: "failed", text: "Last run failed", at: r.at } : undefined;
    }
  }
  return undefined;
}

/** The schedule with its derived fields (reads only). */
export function viewSchedule(s: ListedSchedule, ctx: ViewContext): ScheduleView {
  let state: ScheduleView["state"] = s.enabled ? "active" : s.pausedReason ? "paused" : "ended";
  // An unreadable `when` (hand-edited, or a later build's) can never fire
  // here: ended, and never handed to hasEnded, which would throw.
  if (state === "paused" && (!isUsableWhen(s.when) || hasEnded(s, ctx.now))) state = "ended";

  let where: ScheduleWhere = { kind: "missing" };
  if (s.target?.kind === "thread") {
    const t = ctx.threads.get(s.target.threadId);
    const bot = t && ctx.bots.get(t.botId);
    if (t) {
      where = { kind: "thread", threadId: t.id, title: t.title, botId: t.botId, botName: bot?.name ?? t.botId, jarvis: isJarvisBot(bot) };
    }
  } else if (s.target?.kind === "new-thread") {
    const bot = ctx.bots.get(s.target.botId);
    const projectName = ctx.projects.get(s.target.projectId);
    if (bot && projectName) {
      where = { kind: "new-thread", botId: bot.id, botName: bot.name, projectId: s.target.projectId, projectName };
    }
  }

  let attention: ScheduleAttention | undefined;
  if (state === "paused" && s.pausedReason !== PAUSED_BY_USER) {
    attention = { kind: "paused", text: `Paused: ${s.pausedReason}`, at: s.updatedAt };
  } else if (state !== "ended") {
    attention = failedAttention(s, ctx.threads);
  }

  const threadId = targetThreadId(s);
  const maker = s.createdBy?.kind === "jarvis" ? ctx.threads.get(s.createdBy.threadId) : undefined;
  return {
    ...s,
    describe: describeSchedule(s, ctx.tz),
    state,
    canResume: state === "paused",
    where,
    ...(attention ? { attention } : {}),
    ownWords: !!threadId && madeByThisJarvis(s, threadId),
    ...(maker ? { createdIn: { threadId: maker.id, title: maker.title, botId: maker.botId } } : {}),
    nextRuns: nextRunsOf(s, 3),
    history: (s.history ?? []).map((r) => {
      // Only from a run thread that still exists: a deleted one's link must not open some other thread.
      const botId = r.threadId ? ctx.threads.get(r.threadId)?.botId : undefined;
      return botId ? { ...r, botId } : r;
    }),
  };
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

/** What a new-thread target may say; anything else is refused. */
const NEW_THREAD_KEYS = ["kind", "botId", "projectId"];

/**
 * A new-thread target, checked: its bot exists, is not Jarvis, runs on an
 * agent installed here (when `availableAgents` is given) and is set up; its
 * project is known and its folder is there. A permission mode, model or
 * effort is refused: runs always auto-approve, and their threads run what
 * the bot gives, as one the user opens would.
 */
export function checkNewThreadTarget(
  target: any,
  availableAgents?: readonly string[],
): { ok: true; target: NewThreadTarget } | { ok: false; error: string } {
  if (target.permissionMode !== undefined) {
    return { ok: false, error: "target.permissionMode is not supported: scheduled runs always auto-approve" };
  }
  const extra = Object.keys(target).find((k) => !NEW_THREAD_KEYS.includes(k));
  if (extra) {
    return { ok: false, error: `target.${extra} is not supported: a new-thread target takes botId and projectId (its thread runs the bot's own model and effort)` };
  }
  if (typeof target.botId !== "string" || !target.botId) return { ok: false, error: "target.botId is required" };
  if (typeof target.projectId !== "string" || !target.projectId) return { ok: false, error: "target.projectId is required" };
  const bot = getBot(target.botId);
  if (!bot) return { ok: false, error: `no bot with id "${target.botId}"` };
  if (isJarvisBot(bot)) return { ok: false, error: "a new-thread schedule cannot start a Jarvis thread: target a Jarvis thread by its threadId instead" };
  const agent = threadAgent({}, bot);
  if (availableAgents && !availableAgents.includes(agent)) {
    return { ok: false, error: `${bot.name} runs on ${agent}, which is not installed on this machine` };
  }
  const notSetUp = botSetupError(bot);
  if (notSetUp) return { ok: false, error: `${notSetUp}: finish its setup from the bot in gitbot first` };
  const project = findProject(target.projectId);
  if (!project) return { ok: false, error: `no project with id "${target.projectId}"` };
  if (!isFolder(project.path)) return { ok: false, error: `the project's folder ${project.path} is not there` };
  return { ok: true, target: { kind: "new-thread", botId: bot.id, projectId: project.id } };
}

/** True when `path` is a folder that exists now. */
export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type TimingResult =
  | { ok: true; when: When; first: number; maxRuns?: number; endsAt?: string }
  | { ok: false; error: string };

/**
 * A new schedule's times from a body ({when, maxRuns?, endsAt?}), checked
 * as of `at`: the `when` parsed, its first run, and how it ends. Shared by
 * createSchedule and POST /schedules/preview, so their messages agree.
 */
export function checkTiming(body: any, at: number): TimingResult {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const parsed = parseWhen(body.when, at);
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
  return {
    ok: true,
    when: parsed.when,
    first,
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
  };
}

/** Runs closer together than this get the preview's token warning. */
export const PREVIEW_WARN_GAP_MINUTES = 5;
export const PREVIEW_WARNING = "Runs more often than every 5 minutes: each run is a full agent turn and uses tokens";

export interface SchedulePreview {
  describe: string;
  nextRuns: string[];
  defaultNotify: Notify;
  /** null when there is no second run (a once): JSON has no Infinity. */
  minGapMinutes: number | null;
  warning?: string;
}

/**
 * What a new schedule's times would be (POST /schedules/preview): in words
 * (a once read in `tz`), its first 5 runs, the notify it would default to,
 * and a warning under PREVIEW_WARN_GAP_MINUTES. Writes nothing.
 */
export function previewTiming(body: any, tz: string, at: number): { ok: true; preview: SchedulePreview } | { ok: false; error: string } {
  const timing = checkTiming(body, at);
  if (!timing.ok) return timing;
  const shape = { when: timing.when, maxRuns: timing.maxRuns, endsAt: timing.endsAt };
  const gap = minGapMinutes(timing.when, at);
  // Runs that would follow the first, as nextRunsOf counts them.
  const runs = upcomingRuns(timing.when, timing.first, 5, {
    endsAt: timing.endsAt ? Date.parse(timing.endsAt) : undefined,
    runsLeft: timing.maxRuns ?? Infinity,
  });
  return {
    ok: true,
    preview: {
      describe: describeSchedule(shape, tz),
      nextRuns: runs.map(iso),
      defaultNotify: defaultNotify(timing.when, at),
      minGapMinutes: Number.isFinite(gap) ? gap : null,
      ...(gap < PREVIEW_WARN_GAP_MINUTES ? { warning: PREVIEW_WARNING } : {}),
    },
  };
}

/**
 * Checks a new schedule from a request body and stores it. Only what this
 * build runs is accepted: a once, cron or interval on an existing thread, or
 * starting a new thread. Anything else is refused, not stored
 * half-understood. `availableAgents`, when given, refuses a new-thread
 * target whose bot's agent is not installed here.
 */
export function createSchedule(
  body: any,
  createdBy: Schedule["createdBy"],
  at: number = Date.now(),
  availableAgents?: readonly string[],
): NewScheduleResult {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const { name, prompt, target } = body;

  const badName = nameError(name);
  if (badName) return { ok: false, error: badName };
  const badPrompt = promptError(prompt);
  if (badPrompt) return { ok: false, error: badPrompt };
  if (body.attachments !== undefined) return { ok: false, error: "a schedule's prompt is text only: attachments are not supported" };

  const timing = checkTiming(body, at);
  if (!timing.ok) return timing;
  const { when, first, maxRuns, endsAt } = timing;

  const { overlap, notify } = body;
  if (overlap !== undefined && overlap !== "queue" && overlap !== "skip") {
    return { ok: false, error: `overlap must be "queue" or "skip"` };
  }
  if (notify !== undefined && !isNotify(notify)) return { ok: false, error: NOTIFY_ERROR };

  if (!target || typeof target !== "object") return { ok: false, error: "target is required" };
  let stored: Schedule["target"];
  if (target.kind === "thread") {
    if (typeof target.threadId !== "string" || !target.threadId) return { ok: false, error: "target.threadId is required" };
    const thread = getThread(target.threadId);
    if (!thread) return { ok: false, error: `no thread with id "${target.threadId}"` };
    if (thread.kind === "setup") return { ok: false, error: "a bot's setup thread cannot be scheduled" };
    stored = { kind: "thread", threadId: thread.id };
  } else if (target.kind === "new-thread") {
    const checked = checkNewThreadTarget(target, availableAgents);
    if (!checked.ok) return checked;
    stored = checked.target;
  } else {
    return { ok: false, error: `target.kind "${String(target.kind)}" is not supported: use "thread" or "new-thread"` };
  }

  const all = listForWrite();
  // The total counts every stored schedule (it bounds the file); a thread's
  // 20 counts only those that can still fire, so fired one-shots kept for
  // their history never block a new one. A new-thread target has no thread
  // to count against: only the total holds it.
  if (all.length >= SCHEDULES_MAX) return { ok: false, error: `at most ${SCHEDULES_MAX} schedules: delete one first` };
  const threadId = targetThreadId({ target: stored });
  if (threadId && all.filter((s) => targetThreadId(s) === threadId && canStillFire(s)).length >= SCHEDULES_PER_THREAD_MAX) {
    return { ok: false, error: `at most ${SCHEDULES_PER_THREAD_MAX} active schedules on one thread: delete one first` };
  }

  const stamp = now();
  const schedule: Schedule = {
    id: randomUUID(),
    name: name.trim(),
    prompt,
    when: when,
    target: stored,
    // A schedule Jarvis made reports its notes to that Jarvis thread.
    ...(createdBy.kind === "jarvis" ? { notesTo: createdBy.threadId } : {}),
    createdBy,
    enabled: true,
    overlap: overlap ?? "queue",
    notify: notify ?? defaultNotify(when, at),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
    runCount: 0,
    consecutiveFailures: 0,
    // A once keeps `at` exactly as sent; a cron or interval its first run.
    nextRunAt: when.kind === "once" ? when.at : iso(first),
    history: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  saveAll([...all, schedule]);
  return { ok: true, schedule };
}
