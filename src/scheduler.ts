import { getThread, type Thread } from "./bot-store";
import { runningChildOf } from "./child-lock";
import { errorLine, latestLine, turnOutcome } from "./attention";
import { sendSchedulePausedPush } from "./push";
import { isShuttingDown, onTurnEnd, type EndedTurn } from "./server-common";
import {
  claimManualRun,
  dropPending,
  getSchedule,
  isRunnable,
  listSchedules,
  pauseSchedule,
  PAUSE_AFTER_FAILURES,
  queueManualRun,
  settleDue,
  targetThreadId,
  updateSchedule,
  type Schedule,
  type ScheduleRun,
  type SettledDue,
} from "./schedules";
import { threadIsRunning } from "./send-to-thread";
import { startTurn } from "./turns";

// The scheduler: one timer, set to the earliest due schedule, that fires it
// as a real turn on its thread through startTurn — the same door every turn
// goes through, so a scheduled turn is streamed, stoppable and in history
// like any other. A fire is claimed (counted, its next run set, and saved)
// before its turn starts: a crash in between loses at most that run, and
// never fires twice. At most RATE_CAP_STARTS scheduled turns start in any
// rolling minute; a fire over the cap waits, unclaimed, and is never dropped.
//
// A fire whose thread is busy (its own turn running, or a Jarvis thread
// waiting on its child) never gets in the user's way. With `overlap: "queue"`
// it waits as the schedule's one `pending` fire, and the deferred-turn drain
// (deferred-turns.ts) starts it once the thread's turn has ended, after any
// queued report; with `overlap: "skip"` it is recorded `skipped-busy`.
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
// work (its thread or bot is gone) pauses it at once. Only the user resumes
// it (PATCH /schedules/:id).

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
 * it knows (a once, cron or interval on a thread, whose times it can work
 * out). Others (a new-thread target a later build wrote, a bad pattern
 * written by hand) are left exactly as they are, and logged once.
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
  running = { availableAgents, cancelTimer: () => {}, unlisten: () => {} };
  try {
    running.unlisten = watchScheduledTurns();
  } catch (err: any) {
    console.error(`[scheduler] could not watch turn ends: ${err?.message ?? err}`);
  }
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
): { schedule: Schedule; run?: ScheduleRun; queued?: true } | { refused: string } | undefined {
  const s = getSchedule(id);
  if (!s) return undefined;
  if (!isRunnable(s)) return { refused: `this schedule (${s.when?.kind} on ${s.target?.kind}) is not supported by this build` };
  const due = s.enabled && !!s.nextRunAt && Date.parse(s.nextRunAt) <= schedulerClock.now();
  let fired = due ? fireSchedule(id, availableAgents, "due") : undefined;
  // A due fire that may no longer run (past endsAt) ended the schedule
  // instead; the user still asked for a run.
  if (!fired?.run && !fired?.queued) fired = fireSchedule(id, availableAgents, "manual");
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
 */
export function fireSchedule(
  id: string,
  availableAgents: readonly string[],
  kind: "due" | "manual",
): { schedule: Schedule; run?: ScheduleRun; queued?: true } | undefined {
  const nowMs = schedulerClock.now();
  const at = iso(nowMs);
  const wasHeld = heldByCap.delete(id);

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
        queueManualRun(s, nowMs);
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
  }
  if (queuedSince) {
    console.log(`[schedules] fire ${id}: thread ${targetThreadId(claimed)} is busy; queued (due ${queuedSince})`);
    return { schedule: claimed, queued: true };
  }
  if (runNumber === undefined) {
    if (dueAt) console.log(`[schedules] ${id} due ${dueAt} did not fire: ${tooLate ? "too late" : claimed.enabled ? "it may not run now" : "it has ended"}`);
    return { schedule: claimed };
  }

  let run = startScheduledTurn(claimed, runNumber, availableAgents, at);
  const missed = settled.missed;
  if (run.outcome === "skipped-busy" && claimed.overlap !== "skip") {
    // startTurn found a turn in the way the busy check did not (a 409): the
    // run is handed back and waits as the pending fire, like any busy fire.
    const pendingAt = dueAt ?? at;
    const back = updateSchedule(id, (s) => {
      unclaim(s, lastRunBefore);
      s.pending = kind === "manual" ? { dueAt: pendingAt, manual: true } : { dueAt: pendingAt };
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
  const end = schedule.enabled || paused ? "" : "; the schedule has ended";
  console.log(`[schedules] fire ${id} run ${runNumber}: ${run.outcome}${where}${late}${why}${end}`);
  if (paused) announcePause(schedule, paused);
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

/** The schedule's target thread is busy. A thread that is gone is not: its start says why. */
function targetIsBusy(s: Schedule): boolean {
  const threadId = targetThreadId(s);
  const thread = threadId ? getThread(threadId) : undefined;
  return !!thread && threadBusy(thread);
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
    const id = waiting[0].id;
    const nowMs = schedulerClock.now();
    const at = iso(nowMs);
    let runNumber: number | undefined;
    let dueAt = at;
    let manual = false;
    let lastRunBefore: string | undefined;
    // Claimed, and off the queue, before the start: never both pending and started.
    const claimed = updateSchedule(id, (s) => {
      if (!s.pending) return false;
      dueAt = s.pending.dueAt;
      manual = !!s.pending.manual;
      lastRunBefore = s.lastRunAt;
      delete s.pending;
      s.runCount += 1;
      runNumber = s.runCount;
      s.lastRunAt = at;
    });
    if (!claimed || runNumber === undefined) continue;
    let run = startScheduledTurn(claimed, runNumber, availableAgents, at);
    if (run.outcome === "skipped-busy") {
      const pendingAt = dueAt;
      updateSchedule(id, (s) => {
        unclaim(s, lastRunBefore);
        s.pending = manual ? { dueAt: pendingAt, manual: true } : { dueAt: pendingAt };
      });
      console.log(`[schedules] ${id}: thread ${threadId} is busy again; still queued (due ${pendingAt})`);
      return false;
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
    console.log(`[schedules] fire ${id} run ${runNumber}: ${run.outcome} on thread ${threadId}, queued since ${dueAt}${why}`);
    if (paused && after) announcePause(after, paused);
    if (run.outcome === "started") return true;
  }
}

/**
 * Start errors that no retry can fix: what is gone stays gone. The schedule
 * pauses at once, with the reason. (A new-thread target's project or bot
 * joins these with that target.) Keyed by the run's `error`.
 */
const GONE: Record<string, string> = {
  "thread not found": "its thread was deleted",
  "Thread not found": "its thread was deleted",
  "Bot not found": "its thread's bot was deleted",
};

/** Starts a claimed fire's turn, or says why not. */
function startScheduledTurn(s: Schedule, run: number, availableAgents: readonly string[], at: string): ScheduleRun {
  const threadId = targetThreadId(s);
  if (!threadId) return { at, outcome: "failed-to-start", error: `target "${s.target.kind}" is not supported yet` };
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
        scheduled: { id: s.id, name: s.name, run },
        // Unattended, so always auto-approve and never plan-only, whatever the
        // bot's default or the thread's pick in a browser: nobody is there to
        // answer an approval. (Jarvis is auto-approve anyway.) Documented in
        // docs/API.md, and the chat never adopts this as the thread's pick.
        permissionMode: "yolo",
        mode: "build",
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
      if (staleDueAt) {
        stalePendingUnsaved.delete(id);
        console.log(`[schedules] missed ${id}: the fire queued since ${staleDueAt}, saved on retry`);
      }
      if (settled.missed) {
        const next = after?.nextRunAt ? `next run ${after.nextRunAt}` : "it has ended";
        console.log(`[schedules] missed ${id}: ${settled.estimated ? "about " : ""}${settled.missed.missedCount} run(s) from ${settled.missed.at}, saved on retry; ${next}`);
      }
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
      updateSchedule(s.id, (x) => {
        if (!dropPending(x, now, "missed")) return false;
      });
      console.log(`[schedules] missed ${s.id}: the fire queued since ${dueAt} was still waiting when gitbot stopped`);
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
    } catch (err: any) {
      missedUnsaved.set(s.id, now);
      console.error(`[scheduler] could not record ${s.id} as missed (it will not fire): ${err?.message ?? err}`);
    }
  }
}

/** Why a schedule just paused itself: the reason stored, and the push's words. */
interface Paused {
  reason: string;
  body: string;
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
    paused = { reason: gone, body: `⏰ ${s.name} paused: ${gone}` };
  } else if (s.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
    const runs = `paused after ${PAUSE_AFTER_FAILURES} failed runs`;
    const line = latestLine(error);
    paused = { reason: line ? `${runs}: ${line}` : runs, body: `⏰ ${s.name} ${runs}` };
  } else {
    return undefined;
  }
  pauseSchedule(s, paused.reason);
  return paused;
}

/** A run that failed to start counts as a failure; a busy skip does not. */
function countStartFailure(s: Schedule, run: ScheduleRun): Paused | undefined {
  if (run.outcome !== "failed-to-start") return undefined;
  return countResult(s, "failed", run.error ?? "", run.error ? GONE[run.error] : undefined);
}

/** Logs a pause and sends its one push. Never throws. */
function announcePause(s: Schedule, paused: Paused): void {
  try {
    console.log(`[schedules] ${s.id} paused: ${paused.reason}`);
    sendSchedulePausedPush({ id: s.id, name: s.name, threadId: targetThreadId(s), body: paused.body });
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
  let paused: Paused | undefined;
  const after = updateSchedule(scheduled.id, (s) => {
    const entry = [...s.history].reverse().find((h) => h.outcome === "started" && h.threadId === turn.threadId && !h.turnOutcome);
    if (entry) entry.turnOutcome = outcome;
    if (outcome === "stopped") return entry ? undefined : false;
    paused = countResult(s, outcome, errorLine(turn));
  });
  if (paused && after) {
    turn.schedulePaused = true;
    announcePause(after, paused);
  }
}

function watchScheduledTurns(): () => void {
  return onTurnEnd((_store, turn) => {
    try {
      noteScheduledTurnEnd(turn);
    } catch (err: any) {
      console.error(`[scheduler] schedule ${turn.scheduled?.id}: ${err?.message ?? err}`);
    }
  });
}
