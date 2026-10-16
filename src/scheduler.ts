import {
  addFailedRun,
  botNeedsSetup,
  clearFailedRuns,
  createThread,
  deleteThread,
  getBot,
  getThread,
  isJarvisBot,
  onThreadDeleted,
  threadAgent,
  type Thread,
} from "./bot-store";
import { transcriptHasTimes } from "./thread-tools";
import { runningChildOf } from "./child-lock";
import { errorLine, latestLine, turnOutcome } from "./attention";
import { sendSchedulePausedPush } from "./push";
import { findProject } from "./project-index";
import { noteSchedule } from "./schedule-notes";
import { defaultTimeZone, localShort } from "./schedule-time";
import { isShuttingDown, onTurnEnd, sessions, type EndedTurn } from "./server-common";
import {
  claimManualRun,
  dropPending,
  forgetDeletedThread,
  getSchedule,
  isFolder,
  runIsByOther,
  isRunnable,
  JARVIS_THREAD_GONE,
  listSchedules,
  pauseSchedule,
  PAUSE_AFTER_FAILURES,
  queueManualRun,
  settleDue,
  targetThreadId,
  updateSchedule,
  type NewThreadTarget,
  type Schedule,
  type ScheduleRun,
  type SettledDue,
} from "./schedules";
import { threadIsRunning } from "./send-to-thread";
import { startTurn } from "./turns";

// The scheduler: one timer, set to the earliest due schedule, that fires it
// as a real turn on its thread through startTurn — the same door every turn
// goes through, so a scheduled turn is streamed, stoppable and in history
// like any other. A new-thread target starts a fresh thread for each run
// instead (startNewThreadRun); it is busy while one of its own runs is still
// going. A fire is claimed (counted, its next run set, and saved) before its
// turn starts: a crash in between loses at most that run, and never fires
// twice. At most RATE_CAP_STARTS scheduled turns start in any rolling minute; a fire over the cap waits, unclaimed, and is never dropped.
//
// A fire whose thread is busy (its own turn running, or a Jarvis thread
// waiting on its child) never gets in the user's way. With `overlap: "queue"`
// it waits as the schedule's one `pending` fire, and the deferred-turn drain
// (deferred-turns.ts) starts it once the thread's turn has ended, after any
// queued report; with `overlap: "skip"` it is recorded `skipped-busy`. A
// new-thread schedule is busy the same way while one of its runs is going,
// and its pending fire starts when that run's turn ends.
//
// When does a queued fire count as claimed? When it starts (or is given up):
// its runCount and its "run N" are taken then, as for any start. Its time
// still passes at fire time, as usual: nextRunAt moves on (or the schedule
// ends) when it comes due, and the pending fire holds its run meanwhile
// (schedules.ts, runsLeft), so maxRuns is never overrun. A newer fire always
// replaces a waiting one, which is recorded `skipped-busy`: one pending at
// most, so a 1-minute schedule on a slow thread runs back to back, never
// piling up. A restart records a pending fire missed: never fired late.
//
// A schedule that keeps failing pauses itself (H4). A run that fails counts
// toward it: a turn that started and ended `failed` (counted at its turn end,
// from the ended turn's own snapshot), or a `failed-to-start`. A `done` turn
// resets the count; a turn the user stopped, a busy skip, a queued fire or a
// missed run change nothing. At PAUSE_AFTER_FAILURES in a row it is paused
// (`pausedReason`), and one `failed` push says so. A start that can never
// work (its thread or bot is gone; a new-thread target's bot or project)
// pauses it at once. Only the user resumes it (PATCH /schedules/:id).
//
// A schedule a Jarvis thread made (notesTo) keeps one status line there
// (schedule-notes.ts) for its runs on other threads, its missed runs and its
// pause, which Jarvis gets with the user's next message. A deleted thread
// takes its schedules with it, and pauses the new-thread ones it made
// (threadDeleted).

/**
 * Time and timers, as the scheduler sees them. A seam: tests set `now` and
 * run the armed callback by hand instead of waiting.
 */
export const schedulerClock = {
  now: (): number => Date.now(),
  /** Runs fn after ms; returns a cancel. */
  setTimer: (fn: () => void, ms: number): (() => void) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};

/** The longest the timer sleeps: due times are re-read at least this often. */
export const TIMER_CAP_MS = 60_000;

/**
 * The shortest sleep after a tick. Whatever is due fires in the tick itself;
 * a schedule still due after it (one whose claim did not take) must never
 * re-arm at 0 and spin.
 */
export const MIN_REARM_MS = 1_000;

/** The sleep after a tick that threw (a full disk, a read-only data dir). */
export const ERROR_BACKOFF_MS = 10_000;

/** At most this many scheduled turns start in any RATE_WINDOW_MS, across gitbot. */
export const RATE_CAP_STARTS = 5;
export const RATE_WINDOW_MS = 60_000;
/** The longest the timer sleeps while a due fire waits for the rate cap. */
export const RATE_RETRY_MS = 10_000;

/**
 * How late a due fire may still run. The timer wakes at least every
 * TIMER_CAP_MS, so later than this (and not held by the rate cap) means the
 * process was suspended or stalled, or the clock jumped forward: from the
 * user's side that is gitbot being down, so the run is missed, never fired
 * late (decision 3), as at startup.
 */
export const LATE_GRACE_MS = TIMER_CAP_MS + RATE_RETRY_MS;

/**
 * When the last scheduled turns started, for the rate cap. It counts turns
 * that started, not fires: a fire that was skipped (busy) or failed to start
 * used no slot, since it put no load on anything. A run now counts too (it
 * is a start), though it is never held: the user asked for it.
 */
let recentStarts: number[] = [];

/** Due fires the rate cap is holding, unclaimed. Their start records delayedMs. */
const heldByCap = new Set<string>();

/** When the cap next has room: `now` if it has room now. */
function rateRoomAt(now: number): number {
  recentStarts = recentStarts.filter((t) => now - t < RATE_WINDOW_MS);
  if (recentStarts.length < RATE_CAP_STARTS) return now;
  return recentStarts[recentStarts.length - RATE_CAP_STARTS] + RATE_WINDOW_MS;
}

/** Schedules of a kind this build cannot run, already logged once. */
const warnedUnrunnable = new Set<string>();

/**
 * Missed at startup (or found too late), but the record of it could not be
 * saved. Never fired late, whatever the file still says: each tick tries to
 * record it again (retryUnsavedMissed), and once that saves, a recurring
 * schedule runs on from its next run.
 */
const missedUnsaved = new Map<string, number>();

/**
 * Queued fires a restart found, whose missed record could not be saved: their
 * `dueAt`. Their schedules are in missedUnsaved too, so nothing fires or
 * drains them until the record saves (retryUnsavedMissed).
 */
const stalePendingUnsaved = new Map<string, string>();

/** How often a missed record that still can't be saved is logged again. */
const UNSAVED_LOG_MS = 60_000;

/**
 * The schedules this build can run: enabled, with a due time, and of a kind
 * it knows (a once, cron or interval on a thread or a new thread, whose
 * times it can work out). Others (a target kind a later build wrote, a bad
 * pattern written by hand) are left exactly as they are, and logged once.
 */
function runnableSchedules(): Schedule[] {
  const out: Schedule[] = [];
  for (const s of listSchedules()) {
    if (!s.enabled || !s.nextRunAt || missedUnsaved.has(s.id)) continue;
    if (!isRunnable(s)) {
      if (!warnedUnrunnable.has(s.id)) {
        warnedUnrunnable.add(s.id);
        console.warn(`[scheduler] schedule ${s.id} (${s.when?.kind ?? "?"} on ${s.target?.kind ?? "?"}) is not supported by this build: left alone`);
      }
      continue;
    }
    out.push(s);
  }
  return out;
}

interface Running {
  availableAgents: readonly string[];
  cancelTimer: () => void;
  unlisten: () => void;
  unlistenDeletes: () => void;
}

let running: Running | null = null;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Starts the scheduler: records runs that came due while gitbot was down as
 * missed (they never fire late), watches scheduled turns' ends, and arms the
 * timer. Never throws: a broken schedules.json or data directory is logged,
 * and gitbot boots without schedules.
 */
export function startScheduler(availableAgents: readonly string[]): () => void {
  stopScheduler();
  heldByCap.clear();
  // The missed pass below works these out afresh.
  missedUnsaved.clear();
  stalePendingUnsaved.clear();
  recentStarts = recentStartsFromHistory(schedulerClock.now());
  // Running first: whatever the startup pass below hits, schedules created
  // from here on still arm the timer and fire.
  running = { availableAgents, cancelTimer: () => {}, unlisten: () => {}, unlistenDeletes: () => {} };
  try {
    running.unlisten = watchScheduledTurns();
  } catch (err: any) {
    console.error(`[scheduler] could not watch turn ends: ${err?.message ?? err}`);
  }
  running.unlistenDeletes = onThreadDeleted(threadDeleted);
  try {
    recordStalePending(schedulerClock.now());
    recordMissed(schedulerClock.now());
  } catch (err: any) {
    console.error(`[scheduler] missed-run check failed: ${err?.message ?? err}`);
  }
  rearmScheduler();
  try {
    const enabled = runnableSchedules().length;
    if (enabled) console.log(`  schedules: ${enabled} enabled`);
  } catch {
    // Only a log line.
  }
  return stopScheduler;
}

/** Stops the timer and the turn-end listener. */
export function stopScheduler(): void {
  if (!running) return;
  running.cancelTimer();
  running.unlisten();
  running.unlistenDeletes();
  running = null;
}

/**
 * Sets the one timer to the earliest due time (at most TIMER_CAP_MS away,
 * and at least `minDelay`). Called after every change to the schedules:
 * create, delete, fire, run now. A no-op while the scheduler is not running.
 */
export function rearmScheduler(minDelay = 0): void {
  if (!running) return;
  running.cancelTimer();
  running.cancelTimer = () => {};
  try {
    let earliest = Infinity;
    for (const s of runnableSchedules()) {
      const due = Date.parse(s.nextRunAt!);
      if (due < earliest) earliest = due;
    }
    // Missed records still to save: try again after the back-off.
    if (missedUnsaved.size) earliest = Math.min(earliest, schedulerClock.now() + ERROR_BACKOFF_MS);
    if (earliest === Infinity) return;
    const delay = Math.max(minDelay, Math.min(TIMER_CAP_MS, earliest - schedulerClock.now()));
    running.cancelTimer = schedulerClock.setTimer(tick, delay);
  } catch (err: any) {
    console.error(`[scheduler] could not arm the timer: ${err?.message ?? err}`);
  }
}

/**
 * A schedule was edited or deleted (PATCH, DELETE): a rate-cap hold on its
 * old due time is forgotten, so a later fire is never taken for a held one,
 * and the timer is re-armed for its new times.
 */
export function scheduleChanged(id: string): void {
  heldByCap.delete(id);
  rearmScheduler();
}

/**
 * The timer went off: fire everything due, earliest first, then re-arm,
 * never at 0. A due fire the rate cap has no room for is left unclaimed
 * (its runCount and nextRunAt untouched) and tried again when the cap has
 * room, at most RATE_RETRY_MS later.
 */
function tick(): void {
  const r = running;
  if (!r) return;
  r.cancelTimer = () => {};
  // Shutdown exits in the signal's own tick, so this cannot run then; a
  // backstop, so that nothing ever fires a turn from a stopping gitbot.
  if (isShuttingDown()) return;
  let failed = false;
  let roomAt: number | null = null;
  const now = schedulerClock.now();
  retryUnsavedMissed(now);
  try {
    const due = runnableSchedules()
      .filter((s) => Date.parse(s.nextRunAt!) <= now)
      .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));
    for (const s of due) {
      const room = rateRoomAt(now);
      if (room > now) {
        roomAt = room;
        if (!heldByCap.has(s.id)) {
          heldByCap.add(s.id);
          console.log(`[scheduler] rate cap: ${RATE_CAP_STARTS} scheduled starts in the last minute; ${s.id} (due ${s.nextRunAt}) waits`);
        }
        continue;
      }
      fireSchedule(s.id, r.availableAgents, "due");
    }
  } catch (err: any) {
    failed = true;
    console.error(`[scheduler] tick failed, retrying in ${ERROR_BACKOFF_MS / 1000}s: ${err?.message ?? err}`);
  } finally {
    if (running === r) {
      const floor = failed
        ? ERROR_BACKOFF_MS
        : roomAt != null
          ? Math.min(RATE_RETRY_MS, Math.max(MIN_REARM_MS, roomAt - now))
          : MIN_REARM_MS;
      rearmScheduler(floor);
    }
  }
}

/**
 * Fires a schedule now, from POST /schedules/:id/run. It counts as a run and
 * leaves the next due time be — unless that time has already come, in which
 * case this is that fire, so the timer does not fire it a second time. Never
 * held by the rate cap: the user asked for it. A busy thread queues it, like
 * any fire (`queued`, and the schedule's `pending` says since when).
 */
export function runScheduleNow(
  id: string,
  availableAgents: readonly string[],
  by: Schedule["createdBy"] = { kind: "user" },
): { schedule: Schedule; run?: ScheduleRun; queued?: true } | { refused: string } | undefined {
  const s = getSchedule(id);
  if (!s) return undefined;
  if (!isRunnable(s)) return { refused: `this schedule (${s.when?.kind} on ${s.target?.kind}) is not supported by this build` };
  // A run at a time someone else chose is not the creating Jarvis's own:
  // that one run is data (no by="you"). The schedule is not marked, so its
  // own times, and the creator's own run nows, still are (madeByThisJarvis).
  const byOther = runIsByOther(s, by);
  const due = s.enabled && !!s.nextRunAt && Date.parse(s.nextRunAt) <= schedulerClock.now();
  // A fire already due is the schedule's own time, whoever pressed the button.
  let fired = due ? fireSchedule(id, availableAgents, "due") : undefined;
  // A due fire that may no longer run (past endsAt) ended the schedule
  // instead; the user still asked for a run.
  if (!fired?.run && !fired?.queued) fired = fireSchedule(id, availableAgents, "manual", { byOther });
  rearmScheduler();
  if (fired?.queued) return { schedule: fired.schedule, queued: true };
  return fired?.run ? { schedule: fired.schedule, run: fired.run } : undefined;
}

/**
 * One fire: claim it, then start its turn. `due`: the timer's fire, which
 * advances the schedule to its next run (or ends it), and records the runs
 * that passed meanwhile as missed; it starts nothing when the schedule may no
 * longer run (past endsAt), and `run` is then absent. `manual`: a run now,
 * which counts as a run and moves nothing. Either one, on a busy thread with
 * `overlap: "queue"`, becomes the schedule's pending fire instead (`queued`),
 * replacing any older one; it is claimed when the drain starts it.
 * `byOther`: a manual run someone other than a Jarvis-made schedule's
 * creator asked for. That run is data (no by="you"), queued or not.
 */
export function fireSchedule(
  id: string,
  availableAgents: readonly string[],
  kind: "due" | "manual",
  opts: { byOther?: boolean } = {},
): { schedule: Schedule; run?: ScheduleRun; queued?: true } | undefined {
  const nowMs = schedulerClock.now();
  const at = iso(nowMs);
  const wasHeld = heldByCap.delete(id);
  const byOther = kind === "manual" && !!opts.byOther;

  // Claim first, and persist it, before anything can start.
  let runNumber: number | undefined;
  let settled: SettledDue = {};
  let delayedMs: number | undefined;
  let dueAt: string | null = null;
  let tooLate = false;
  let queuedSince: string | undefined;
  let replaced: ScheduleRun | undefined;
  let lastRunBefore: string | undefined;
  const claimed = updateSchedule(id, (s) => {
    // No longer due (changed since the tick read it): nothing to do.
    if (kind === "due" && (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > nowMs)) return false;
    // Busy now: read in the same synchronous step as the start below, so
    // nothing can change in between. (startTurn's own 409 is handled too.)
    const queue = s.overlap !== "skip" && targetIsBusy(s);
    // A newer fire always replaces a waiting one: it is given up, as
    // skipped-busy. One pending at most, and never two runs from one fire.
    replaced = dropPending(s, nowMs, "skipped-busy");
    lastRunBefore = s.lastRunAt;
    if (kind === "manual") {
      if (queue) {
        queueManualRun(s, nowMs, byOther);
        queuedSince = s.pending?.dueAt;
      } else {
        runNumber = claimManualRun(s, nowMs);
      }
      return;
    }
    dueAt = s.nextRunAt;
    const lateBy = nowMs - Date.parse(s.nextRunAt!);
    if (wasHeld) delayedMs = lateBy;
    // Far later than any timer sleeps, and not because the rate cap held it:
    // the process was suspended or the clock jumped. Missed, as if down.
    tooLate = !wasHeld && lateBy > LATE_GRACE_MS;
    settled = settleDue(s, nowMs, tooLate ? false : queue ? "queue" : true);
    runNumber = settled.run;
    if (settled.queued) queuedSince = s.pending?.dueAt;
    // A run that fires gets its "started" entry first, then the missed ones
    // after it (they came due after it): pushed with it, below.
    if (settled.missed && runNumber === undefined) s.history.push(settled.missed);
  });
  if (!claimed) return undefined;
  if (replaced) console.log(`[schedules] ${id}: the fire queued since ${replaced.dueAt} is replaced by a newer one (skipped-busy)`);
  if (settled.missed) {
    const about = settled.estimated ? "about " : "";
    const why = tooLate ? "came due while gitbot was suspended or the clock jumped" : "passed while it waited";
    console.log(`[schedules] missed ${id}: ${about}${settled.missed.missedCount} run(s) from ${settled.missed.at} ${why}`);
    // Suspended or stalled is gitbot being down, from the user's side.
    if (tooLate) noteSchedule(claimed, { kind: "missed", count: settled.missed.missedCount ?? 0 });
  }
  if (queuedSince) {
    const busy = claimed.target?.kind === "new-thread" ? "its last run is still going" : `thread ${targetThreadId(claimed)} is busy`;
    console.log(`[schedules] fire ${id}: ${busy}; queued (due ${queuedSince})`);
    return { schedule: claimed, queued: true };
  }
  if (runNumber === undefined) {
    if (dueAt) console.log(`[schedules] ${id} due ${dueAt} did not fire: ${tooLate ? "too late" : claimed.enabled ? "it may not run now" : "it has ended"}`);
    return { schedule: claimed };
  }

  let run = startScheduledTurn(claimed, runNumber, availableAgents, at, byOther);
  const missed = settled.missed;
  if (run.outcome === "skipped-busy" && claimed.overlap !== "skip") {
    // startTurn found a turn in the way the busy check did not (a 409): the
    // run is handed back and waits as the pending fire, like any busy fire.
    const pendingAt = dueAt ?? at;
    const back = updateSchedule(id, (s) => {
      unclaim(s, lastRunBefore);
      s.pending = kind === "manual" ? { dueAt: pendingAt, manual: true, ...(byOther ? { byOther: true as const } : {}) } : { dueAt: pendingAt };
      if (missed) s.history.push(missed);
    }) ?? claimed;
    console.log(`[schedules] fire ${id}: thread ${run.threadId} is busy (409); queued (due ${pendingAt})`);
    return { schedule: back, queued: true };
  }
  if (delayedMs !== undefined && delayedMs > 0) run = { ...run, delayedMs };
  // The rate cap counts starts only.
  if (run.outcome === "started") recentStarts.push(nowMs);
  let paused: Paused | undefined;
  const schedule = updateSchedule(id, (s) => {
    s.history.push(run);
    if (missed) s.history.push(missed);
    paused = countStartFailure(s, run);
  }) ?? claimed;
  const where = run.threadId ? ` on thread ${run.threadId}` : "";
  const why = run.error ? ` (${run.error})` : "";
  const late = run.delayedMs ? ` ${Math.round(run.delayedMs / 1000)}s late (rate cap)` : "";
  const end = schedule.enabled || paused ? "" : schedule.pausedReason ? "; the schedule is paused" : "; the schedule has ended";
  console.log(`[schedules] fire ${id} run ${runNumber}: ${run.outcome}${where}${late}${why}${end}`);
  noteFailedStart(schedule, run);
  if (paused) announcePause(schedule, paused, run.threadId);
  return { schedule, run };
}

/**
 * Busy: a turn of the thread's own running (the scan send_to_thread makes),
 * or a Jarvis thread waiting on its child. A scheduled run is never
 * reportable, so it is never that child itself.
 */
function threadBusy(thread: Thread): boolean {
  return threadIsRunning(thread) || !!runningChildOf(thread.id);
}

/**
 * The schedule's target is busy. A thread that is gone is not: its start
 * says why. A new-thread target is busy while one of its own runs is still
 * going (newThreadRunBusy).
 */
function targetIsBusy(s: Schedule): boolean {
  if (s.target?.kind === "new-thread") return newThreadRunBusy(s.id);
  const threadId = targetThreadId(s);
  const thread = threadId ? getThread(threadId) : undefined;
  return !!thread && threadBusy(thread);
}

/**
 * A new-thread schedule's run is still going: a session whose turn this
 * schedule started is running. Its runs share one folder, so a run never
 * starts beside another (overlap queues or skips it, as on a busy thread).
 * A thread the user has since taken over is no longer the schedule's: its
 * turns are not scheduled.
 */
function newThreadRunBusy(scheduleId: string): boolean {
  return [...sessions.values()].some((x) => x.scheduled?.id === scheduleId && x.status === "running");
}

/** Hands a claimed run back (its start found the thread busy after all). */
function unclaim(s: Schedule, lastRunBefore: string | undefined): void {
  s.runCount -= 1;
  if (lastRunBefore) s.lastRunAt = lastRunBefore;
  else delete s.lastRunAt;
}

/**
 * Starts the oldest pending fire on a thread, if the thread is free. The
 * deferred-turn drain calls it once no queued report is waiting there
 * (reports go first). The fire is claimed now, and its `started` entry has
 * `delayedMs`, how long it waited. A start that finds the thread busy after
 * all (the user's message got in first) hands the claim back and leaves the
 * fire pending, for that turn's end. A fire that fails to start is used up,
 * and the next one is tried. Not held by the rate cap (one per turn end on
 * its thread is load enough), though it counts toward it. True when a turn
 * started.
 */
export function deliverPendingSchedule(threadId: string, availableAgents: readonly string[]): boolean {
  for (;;) {
    if (isShuttingDown()) return false;
    const thread = getThread(threadId);
    if (!thread) return false;
    const waiting = listSchedules({ threadId })
      .filter((s) => s.pending && isRunnable(s) && !missedUnsaved.has(s.id))
      .sort((a, b) => Date.parse(a.pending!.dueAt) - Date.parse(b.pending!.dueAt));
    if (!waiting.length) return false;
    // Right before the start: never a second turn on the thread.
    if (threadBusy(thread)) return false;
    const started = startPendingFire(waiting[0].id, availableAgents, `thread ${threadId}`);
    if (started === "busy") return false;
    if (started === "started") return true;
  }
}

/**
 * Starts a new-thread schedule's pending fire once its last run has ended:
 * the deferred-turn drain calls it when a turn that schedule started ends.
 * As deliverPendingSchedule: claimed now, with `delayedMs`; not held by the
 * rate cap, though it counts toward it. True when a run started.
 */
export function deliverPendingNewThreadRun(scheduleId: string, availableAgents: readonly string[]): boolean {
  if (isShuttingDown()) return false;
  const s = getSchedule(scheduleId);
  if (!s?.pending || s.target?.kind !== "new-thread" || !isRunnable(s) || missedUnsaved.has(s.id)) return false;
  // Right before the start: never two of its runs at once.
  if (newThreadRunBusy(s.id)) return false;
  return startPendingFire(s.id, availableAgents, "a new thread") === "started";
}

/**
 * Claims a schedule's pending fire and starts it. "busy": the start found
 * its target busy after all, so the claim is handed back and the fire stays
 * pending. "none": there was no pending fire to claim. Else the run's outcome,
 * recorded and counted toward the pause.
 */
function startPendingFire(id: string, availableAgents: readonly string[], where: string): ScheduleRun["outcome"] | "busy" | "none" {
  const nowMs = schedulerClock.now();
  const at = iso(nowMs);
  let runNumber: number | undefined;
  let dueAt = at;
  let manual = false;
  let byOther = false;
  let lastRunBefore: string | undefined;
  // Claimed, and off the queue, before the start: never both pending and started.
  const claimed = updateSchedule(id, (s) => {
    if (!s.pending) return false;
    dueAt = s.pending.dueAt;
    manual = !!s.pending.manual;
    byOther = !!s.pending.byOther;
    lastRunBefore = s.lastRunAt;
    delete s.pending;
    s.runCount += 1;
    runNumber = s.runCount;
    s.lastRunAt = at;
  });
  if (!claimed || runNumber === undefined) return "none";
  let run = startScheduledTurn(claimed, runNumber, availableAgents, at, byOther);
  if (run.outcome === "skipped-busy") {
    const pendingAt = dueAt;
    updateSchedule(id, (s) => {
      unclaim(s, lastRunBefore);
      s.pending = manual ? { dueAt: pendingAt, manual: true, ...(byOther ? { byOther: true as const } : {}) } : { dueAt: pendingAt };
    });
    console.log(`[schedules] ${id}: ${where} is busy again; still queued (due ${pendingAt})`);
    return "busy";
  }
  const waited = nowMs - Date.parse(dueAt);
  if (waited > 0) run = { ...run, delayedMs: waited };
  if (run.outcome === "started") recentStarts.push(nowMs);
  let paused: Paused | undefined;
  const after = updateSchedule(id, (s) => {
    s.history.push(run);
    paused = countStartFailure(s, run);
  });
  const why = run.error ? ` (${run.error})` : "";
  const on = run.threadId ? `thread ${run.threadId}` : where;
  console.log(`[schedules] fire ${id} run ${runNumber}: ${run.outcome} on ${on}, queued since ${dueAt}${why}`);
  if (after) noteFailedStart(after, run);
  if (paused && after) announcePause(after, paused, run.threadId);
  return run.outcome;
}

/** A new-thread run's start errors for a bot or project that is gone. */
const NEW_THREAD_BOT_GONE = "bot not found";
const NEW_THREAD_PROJECT_GONE = "project not found";

/**
 * Start errors that no retry can fix: what is gone stays gone. The schedule
 * pauses at once, with the reason. Keyed by the run's `error`.
 */
const GONE: Record<string, string> = {
  "thread not found": "its thread was deleted",
  "Thread not found": "its thread was deleted",
  "Bot not found": "its thread's bot was deleted",
  // A new-thread target's (startNewThreadRun). The project index drops a
  // folder that is gone, so a removed folder reads as no project.
  [NEW_THREAD_BOT_GONE]: "its bot was deleted",
  [NEW_THREAD_PROJECT_GONE]: "its project is gone (its folder was removed or moved)",
};

/** Unattended: always auto-approve, never plan-only (see startScheduledTurn). */
const SCHEDULED_PERMISSION = { permissionMode: "yolo", mode: "build" } as const;

/**
 * Starts a claimed fire's turn, or says why not. `byOther`: a run now that
 * someone other than the creating Jarvis thread asked for, so never by="you".
 */
function startScheduledTurn(s: Schedule, run: number, availableAgents: readonly string[], at: string, byOther = false): ScheduleRun {
  if (s.target?.kind === "new-thread") return startNewThreadRun(s, s.target, run, availableAgents, at);
  const threadId = targetThreadId(s);
  if (!threadId) return { at, outcome: "failed-to-start", error: `target "${s.target?.kind}" is not supported` };
  const thread = getThread(threadId);
  if (!thread) return { at, outcome: "failed-to-start", threadId, error: "thread not found" };
  // Busy (with `overlap: "skip"`, or the drain racing a new turn): nothing
  // starts. The callers queue it, or record it.
  if (threadBusy(thread)) return { at, outcome: "skipped-busy", threadId };
  try {
    const started = startTurn(
      {
        threadId,
        prompt: s.prompt,
        scheduled: { id: s.id, name: s.name, run, ...(!byOther && madeByThisJarvis(s, threadId) ? { createdHere: true as const } : {}) },
        // Unattended, so always auto-approve and never plan-only, whatever the
        // bot's default or the thread's pick in a browser: nobody is there to
        // answer an approval. (Jarvis is auto-approve anyway.) Documented in
        // docs/API.md, and the chat never adopts this as the thread's pick.
        ...SCHEDULED_PERMISSION,
      },
      availableAgents,
    );
    if (started.ok) return { at, outcome: "started", threadId };
    // Only a turn in the way is busy. A 409 for setup (the bot still needs
    // to set up this machine) is a start that cannot happen: say why.
    if (started.status === 409 && !started.extra?.setupRequired) return { at, outcome: "skipped-busy", threadId };
    // A 404 is the thread or its bot gone (GONE). Kept as startTurn words it.
    return { at, outcome: "failed-to-start", threadId, error: started.message };
  } catch (err: any) {
    return { at, outcome: "failed-to-start", threadId, error: err?.message ?? "failed to start" };
  }
}

/**
 * A new-thread run: a fresh thread with the target's bot, in its project's
 * folder, titled "<name> · <run time>", then its first turn. The thread is
 * the user's: no reportTo, so the run is never a Jarvis child (no report, no
 * lock, not in any Jarvis thread's list), and its result is its own thread,
 * its push and the run history. It gets no model or effort: the bot's, or
 * the default, as a thread the user opens would. Its runs share one folder,
 * so one never starts while another is still going (newThreadRunBusy):
 * `overlap` queues it, as the schedule's one pending fire that the drain
 * starts when that run ends, or skips it.
 *
 * Everything that can be checked is checked before the thread is made, so a
 * start that can't work leaves no thread: a bot or project that is gone
 * (GONE: it pauses at once), an agent not installed, a bot that still needs
 * setup. A start that fails anyway deletes the thread it just made, unless a
 * session already holds it.
 */
function startNewThreadRun(
  s: Schedule,
  target: NewThreadTarget,
  run: number,
  availableAgents: readonly string[],
  at: string,
): ScheduleRun {
  const failed = (error: string): ScheduleRun => ({ at, outcome: "failed-to-start", error });
  const bot = getBot(target.botId);
  if (!bot || isJarvisBot(bot)) return failed(NEW_THREAD_BOT_GONE);
  const project = findProject(target.projectId);
  if (!project || !isFolder(project.path)) return failed(NEW_THREAD_PROJECT_GONE);
  const agent = threadAgent({}, bot);
  if (!availableAgents.includes(agent)) return failed(`${bot.name} runs on ${agent}, which is not installed on this machine`);
  if (botNeedsSetup(bot)) return failed(`${bot.name} still needs to set up this machine`);
  // Its last run still going (overlap "skip", or a race with the drain):
  // nothing starts. The callers queue it, or record it.
  if (newThreadRunBusy(s.id)) return { at, outcome: "skipped-busy" };

  let thread: Thread | undefined;
  let error: string;
  try {
    // Inside the try: a threads.json that can't be written is a failed
    // start, recorded and counted, not a claimed run that vanishes.
    thread = createThread(bot.id, project.path, newThreadTitle(s, Date.parse(at)), "chat", agent);
    const started = startTurn(
      { threadId: thread.id, prompt: s.prompt, scheduled: { id: s.id, name: s.name, run }, ...SCHEDULED_PERMISSION },
      availableAgents,
    );
    if (started.ok) return { at, outcome: "started", threadId: thread.id };
    error = started.message;
  } catch (err: any) {
    error = err?.message ?? "failed to start";
  }
  // A thread that never ran is noise in the bot's list. One a session holds
  // did start something (its turn ends, and is kept, as any other): left be.
  if (!thread) return failed(error);
  const made = thread;
  if ([...sessions.values()].some((x) => x.threadId === made.id)) return { at, outcome: "failed-to-start", threadId: made.id, error };
  try {
    deleteThread(made.id);
  } catch (err: any) {
    console.error(`[scheduler] schedule ${s.id}: could not delete the empty thread ${made.id}: ${err?.message ?? err}`);
  }
  return failed(error);
}

/** A new-thread run's title: "<name> · 14 Oct 09:00", in a cron's zone, else the server's. */
export function newThreadTitle(s: Pick<Schedule, "name" | "when">, at: number): string {
  const tz = s.when?.kind === "cron" ? s.when.tz : defaultTimeZone().tz;
  return `${s.name} · ${localShort(at, tz)}`;
}

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
function madeByThisJarvis(s: Schedule, threadId: string): boolean {
  return s.createdBy?.kind === "jarvis" && s.createdBy.threadId === threadId && !s.changedByOther;
}

/**
 * The rate window as the last process left it: scheduled starts in the last
 * minute, read from the history, so a restart doesn't open a fresh window of
 * five on top of the five that just started.
 */
function recentStartsFromHistory(now: number): number[] {
  try {
    const out: number[] = [];
    for (const s of listSchedules()) {
      for (const h of s.history ?? []) {
        const t = Date.parse(h.at);
        if (h.outcome === "started" && t <= now && now - t < RATE_WINDOW_MS) out.push(t);
      }
    }
    return out.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Missed runs whose record could not be saved (at startup, a full disk):
 * tried again on every tick, each on its own, until they save. Until then
 * the schedule never fires, so nothing missed runs late; after, a recurring
 * schedule runs on from its next run.
 */
function retryUnsavedMissed(now: number): void {
  for (const [id, loggedAt] of [...missedUnsaved]) {
    try {
      let settled: SettledDue = {};
      const staleDueAt = stalePendingUnsaved.get(id);
      const after = updateSchedule(id, (x) => {
        const stale = !!staleDueAt && x.pending?.dueAt === staleDueAt && !!dropPending(x, now, "missed");
        if (!x.enabled || !x.nextRunAt || Date.parse(x.nextRunAt) > now) return stale ? undefined : false;
        settled = settleDue(x, now, false);
        if (settled.missed) x.history.push(settled.missed);
      });
      missedUnsaved.delete(id);
      let missedCount = 0;
      if (staleDueAt) {
        stalePendingUnsaved.delete(id);
        console.log(`[schedules] missed ${id}: the fire queued since ${staleDueAt}, saved on retry`);
        missedCount += 1;
      }
      if (settled.missed) {
        const next = after?.nextRunAt ? `next run ${after.nextRunAt}` : "it has ended";
        console.log(`[schedules] missed ${id}: ${settled.estimated ? "about " : ""}${settled.missed.missedCount} run(s) from ${settled.missed.at}, saved on retry; ${next}`);
        missedCount += settled.missed.missedCount ?? 0;
      }
      if (after) noteSchedule(after, { kind: "missed", count: missedCount });
    } catch (err: any) {
      // Still can't save: the next tick tries again. Said again once a minute,
      // so a disk that stays full is visible after boot too.
      if (now - loggedAt >= UNSAVED_LOG_MS) {
        missedUnsaved.set(id, now);
        console.error(`[scheduler] still can't record ${id} as missed (it will not fire until it can): ${err?.message ?? err}`);
      }
    }
  }
}

/**
 * At startup: a fire still queued when gitbot stopped is missed, never fired
 * late (decision 3): one `missed` entry at its due time, and `pending` is
 * cleared. Its run counts, as any missed run does. A record that can't be
 * saved keeps the schedule from firing or draining until it is.
 */
function recordStalePending(now: number): void {
  for (const s of listSchedules()) {
    if (!s.pending) continue;
    const dueAt = s.pending.dueAt;
    try {
      let dropped = false;
      const after = updateSchedule(s.id, (x) => {
        if (!dropPending(x, now, "missed")) return false;
        dropped = true;
      });
      console.log(`[schedules] missed ${s.id}: the fire queued since ${dueAt} was still waiting when gitbot stopped`);
      if (after && dropped) noteSchedule(after, { kind: "missed", count: 1 });
    } catch (err: any) {
      missedUnsaved.set(s.id, now);
      stalePendingUnsaved.set(s.id, dueAt);
      console.error(`[scheduler] could not record ${s.id}'s queued fire as missed (it will not fire): ${err?.message ?? err}`);
    }
  }
}

/**
 * At startup: runs that came due while gitbot was down are missed, never
 * fired late (decision 3). Each such schedule gets one "missed" entry with
 * how many runs passed (they count toward maxRuns), then moves to its next
 * run after now, or ends: a once, a used-up maxRuns, a passed endsAt. A fire
 * the rate cap was holding when gitbot stopped is caught here too.
 */
function recordMissed(now: number): void {
  for (const s of runnableSchedules()) {
    if (Date.parse(s.nextRunAt!) > now) continue;
    const dueAt = s.nextRunAt!;
    // One at a time: a schedule that cannot be saved does not stop the rest.
    try {
      let settled: SettledDue = {};
      const after = updateSchedule(s.id, (x) => {
        if (!x.enabled || !x.nextRunAt) return false;
        settled = settleDue(x, now, false);
        if (settled.missed) x.history.push(settled.missed);
      });
      const count = settled.missed?.missedCount ?? 0;
      const about = settled.estimated ? "about " : "";
      const next = after?.nextRunAt ? `next run ${after.nextRunAt}` : "it has ended";
      console.log(`[schedules] missed ${s.id}: ${about}${count} run(s) from ${dueAt} while gitbot was down; ${next}`);
      if (after) noteSchedule(after, { kind: "missed", count });
    } catch (err: any) {
      missedUnsaved.set(s.id, now);
      console.error(`[scheduler] could not record ${s.id} as missed (it will not fire): ${err?.message ?? err}`);
    }
  }
}

/**
 * Why a schedule just paused itself: the reason stored, the push's words,
 * and its note's (gitbot's own words only: never the run's error text).
 */
interface Paused {
  reason: string;
  body: string;
  note?: string;
}

/**
 * Counts a run's result toward the pause, on the schedule being saved:
 * `done` resets the count, `failed` adds one. Pauses it at
 * PAUSE_AFTER_FAILURES in a row, or at once for a start that can never work
 * (`gone`). Only a schedule still enabled pauses: one paused, or ended (its
 * last run), keeps the count and stays as it is. Returns the pause, if this
 * made one.
 */
function countResult(s: Schedule, result: "done" | "failed", error: string, gone?: string): Paused | undefined {
  if (result === "done") {
    s.consecutiveFailures = 0;
    return undefined;
  }
  s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
  if (!s.enabled) return undefined;
  let paused: Paused;
  if (gone) {
    paused = { reason: gone, body: `⏰ ${s.name} paused: ${gone}`, note: `paused: ${gone}` };
  } else if (s.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
    const runs = `paused after ${PAUSE_AFTER_FAILURES} failed runs`;
    const line = clipAtWord(latestLine(error, Infinity), PAUSED_LINE_MAX);
    paused = { reason: line ? `${runs}: ${line}` : runs, body: `⏰ ${s.name} ${runs}`, note: runs };
  } else {
    return undefined;
  }
  pauseSchedule(s, paused.reason);
  return paused;
}

/** How much of the last error a pausedReason keeps. */
const PAUSED_LINE_MAX = 160;

/** `text` cut to at most `max` characters at a word boundary, with "…" when cut. */
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  // A single long word (a path) is cut where it is.
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A run that failed to start goes on the schedule's note; a busy skip does not. */
function noteFailedStart(s: Schedule, run: ScheduleRun): void {
  if (run.outcome === "failed-to-start") noteSchedule(s, { kind: "run", outcome: "failed to start", threadId: run.threadId });
}

/** A run that failed to start counts as a failure; a busy skip does not. */
function countStartFailure(s: Schedule, run: ScheduleRun): Paused | undefined {
  if (run.outcome !== "failed-to-start") return undefined;
  return countResult(s, "failed", run.error ?? "", run.error ? GONE[run.error] : undefined);
}

/**
 * Logs a pause, sends its one push, and puts it on the schedule's note.
 * Never throws. `runThreadId`: the thread of the run that paused it, which
 * the push opens when the schedule has no thread of its own (a new-thread
 * target); none when no thread ran.
 */
function announcePause(s: Schedule, paused: Paused, runThreadId?: string): void {
  if (paused.note) noteSchedule(s, { kind: "paused", words: paused.note });
  try {
    console.log(`[schedules] ${s.id} paused: ${paused.reason}`);
    sendSchedulePausedPush({ id: s.id, name: s.name, threadId: targetThreadId(s) ?? runThreadId, body: paused.body });
  } catch (err: any) {
    console.error(`[scheduler] schedule ${s.id}: could not announce the pause: ${err?.message ?? err}`);
  }
}

/**
 * How a scheduled turn ended: onto the run it began (the newest "started"
 * entry for its thread still without an outcome; the history trim keeps that
 * one), and toward the pause. Read from the ended turn's snapshot, never the
 * live store, which may be on its next turn already. The count does not need
 * the entry: a run whose entry is gone (written by hand, or by an older
 * build) still counts. A turn our own shutdown killed counts for nothing.
 * When this turn paused the schedule, the turn is marked so (`schedulePaused`)
 * and the pause push stands in for its own failed push. Never throws into
 * the turn-end loop.
 */
export function noteScheduledTurnEnd(turn: EndedTurn): void {
  const scheduled = turn.scheduled;
  if (!scheduled || isShuttingDown()) return;
  const outcome = turnOutcome(turn);
  if (outcome === "failed") {
    try {
      keepFailedStart(turn, scheduled);
    } catch (err: any) {
      console.error(`[scheduler] thread ${turn.threadId}: could not keep a failed run: ${err?.message ?? err}`);
    }
  }
  let paused: Paused | undefined;
  const after = updateSchedule(scheduled.id, (s) => {
    const entry = [...s.history].reverse().find((h) => h.outcome === "started" && h.threadId === turn.threadId && !h.turnOutcome);
    if (entry) entry.turnOutcome = outcome;
    if (outcome === "stopped") return entry ? undefined : false;
    paused = countResult(s, outcome, errorLine(turn, Infinity));
  });
  if (after) noteSchedule(after, { kind: "run", outcome, threadId: turn.threadId });
  if (paused && after) {
    turn.schedulePaused = true;
    announcePause(after, paused, turn.threadId);
  }
}

/** How much of a failed run's error is kept. */
const FAILED_RUN_ERROR_MAX = 2000;

/**
 * A scheduled turn that failed before its agent started (its folder is gone,
 * the agent would not launch): kept on the thread (Thread.failedRuns), since
 * its prompt never reaches the transcript. Without it, history shows only the
 * newest such prompt (the one still in memory), and never the error.
 */
function keepFailedStart(turn: EndedTurn, scheduled: NonNullable<EndedTurn["scheduled"]>): void {
  if (!turn.threadId) return;
  let i = turn.events.length - 1;
  while (i >= 0 && turn.events[i].type !== "user_prompt") i--;
  if (i < 0) return;
  const sent = turn.events[i] as { at?: unknown; prompt?: unknown };
  const after = turn.events.slice(i + 1);
  // Decided by promptDelivered alone, which each runner sets once the agent
  // has the prompt. Never by event types: gitbot sends some of the agent's
  // (OpenCode's system/init on a new session) before the prompt goes out.
  if (typeof sent.at !== "string" || turn.promptDelivered) return;
  // What the turn said went wrong: its error, else what the agent's runner reported.
  const said = (type: string) => {
    for (let j = after.length - 1; j >= 0; j--) {
      const e = after[j] as { type: string; message?: unknown };
      if (e.type === type && typeof e.message === "string" && e.message.trim()) return e.message.trim();
    }
    return "";
  };
  let error = said("error") || said("agent_error");
  error ||= errorLine(turn) || "The run failed before the agent started";
  addFailedRun(turn.threadId, {
    at: sent.at,
    endedAt: new Date().toISOString(),
    prompt: typeof sent.prompt === "string" ? sent.prompt : "",
    scheduled: { id: scheduled.id, name: scheduled.name, run: scheduled.run },
    error: error.length > FAILED_RUN_ERROR_MAX ? `${error.slice(0, FAILED_RUN_ERROR_MAX - 1)}…` : error,
  });
}

/**
 * A turn that reached its agent, on a thread whose transcript has no times
 * (Codex, OpenCode): the failed runs kept before it can't be placed among
 * the transcript's messages any more, so they go. Until then they are the
 * newest thing on the thread, and history shows them last. (Claude Code
 * transcripts carry times: theirs stay, merged in by time.)
 */
export function dropSupersededFailedRuns(turn: EndedTurn): void {
  if (!turn.threadId || !turn.promptDelivered) return;
  const thread = getThread(turn.threadId);
  if (!thread?.failedRuns?.length || transcriptHasTimes(thread)) return;
  clearFailedRuns(thread.id);
}

/**
 * A thread was deleted (bot-store's onThreadDeleted): the schedules that ran
 * on it go, and those it made are detached, or paused with a push when they
 * start a new thread each run (schedules.ts, forgetDeletedThread). Never
 * throws into the delete.
 */
function threadDeleted(thread: Thread): void {
  try {
    const changed = forgetDeletedThread(thread.id, schedulerClock.now());
    for (const s of changed.deleted) {
      heldByCap.delete(s.id);
      console.log(`[schedules] ${s.id} deleted: its thread ${thread.id} was deleted`);
    }
    for (const s of changed.detached) console.log(`[schedules] ${s.id}: its Jarvis thread ${thread.id} was deleted; it runs on, with no notes`);
    for (const s of changed.paused) {
      heldByCap.delete(s.id);
      announcePause(s, { reason: JARVIS_THREAD_GONE, body: `⏰ ${s.name} paused: ${JARVIS_THREAD_GONE}` });
    }
    if (changed.deleted.length || changed.paused.length) rearmScheduler();
  } catch (err: any) {
    console.error(`[scheduler] thread ${thread.id} was deleted, but its schedules could not be updated: ${err?.message ?? err}`);
  }
}

function watchScheduledTurns(): () => void {
  return onTurnEnd((_store, turn) => {
    try {
      dropSupersededFailedRuns(turn);
    } catch (err: any) {
      console.error(`[scheduler] thread ${turn.threadId}: ${err?.message ?? err}`);
    }
    try {
      noteScheduledTurnEnd(turn);
    } catch (err: any) {
      console.error(`[scheduler] schedule ${turn.scheduled?.id}: ${err?.message ?? err}`);
    }
  });
}
