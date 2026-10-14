import { getThread } from "./bot-store";
import { runningChildOf } from "./child-lock";
import { turnOutcome } from "./attention";
import { isShuttingDown, onTurnEnd, sessions, type EndedTurn } from "./server-common";
import { getSchedule, isRunnable, listSchedules, targetThreadId, updateSchedule, type Schedule, type ScheduleRun } from "./schedules";
import { startTurn } from "./turns";

// The scheduler: one timer, set to the earliest due schedule, that fires it
// as a real turn on its thread through startTurn — the same door every turn
// goes through, so a scheduled turn is streamed, stoppable and in history
// like any other. A fire is claimed (counted and saved) before its turn
// starts: a crash in between loses at most that run, and never fires twice.

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

/** Schedules of a kind this build cannot run, already logged once. */
const warnedUnrunnable = new Set<string>();

/**
 * Missed at startup, but the record of it could not be saved: never fired
 * late by this process, whatever the file still says.
 */
const missedUnsaved = new Set<string>();

/**
 * The schedules this build can run: enabled, with a due time, and of a kind
 * it knows (a `once` on a thread). Others (a cron or interval a later build
 * wrote, a hand edit) are left exactly as they are, and logged once.
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
 * Starts the scheduler: records `once` schedules whose time passed while
 * gitbot was down as missed (they never fire late), watches scheduled turns'
 * ends, and arms the timer. Never throws: a broken schedules.json or data
 * directory is logged, and gitbot boots without schedules.
 */
export function startScheduler(availableAgents: readonly string[]): () => void {
  stopScheduler();
  // Running first: whatever the startup pass below hits, schedules created
  // from here on still arm the timer and fire.
  running = { availableAgents, cancelTimer: () => {}, unlisten: () => {} };
  try {
    running.unlisten = watchScheduledTurns();
  } catch (err: any) {
    console.error(`[scheduler] could not watch turn ends: ${err?.message ?? err}`);
  }
  try {
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
    if (earliest === Infinity) return;
    const delay = Math.max(minDelay, Math.min(TIMER_CAP_MS, earliest - schedulerClock.now()));
    running.cancelTimer = schedulerClock.setTimer(tick, delay);
  } catch (err: any) {
    console.error(`[scheduler] could not arm the timer: ${err?.message ?? err}`);
  }
}

/** The timer went off: fire everything due, then re-arm, never at 0. */
function tick(): void {
  const r = running;
  if (!r) return;
  r.cancelTimer = () => {};
  let failed = false;
  try {
    const now = schedulerClock.now();
    for (const s of runnableSchedules()) {
      if (Date.parse(s.nextRunAt!) <= now) fireSchedule(s.id, r.availableAgents, "due");
    }
  } catch (err: any) {
    failed = true;
    console.error(`[scheduler] tick failed, retrying in ${ERROR_BACKOFF_MS / 1000}s: ${err?.message ?? err}`);
  } finally {
    if (running === r) rearmScheduler(failed ? ERROR_BACKOFF_MS : MIN_REARM_MS);
  }
}

/**
 * Fires a schedule now, from POST /schedules/:id/run. It counts as a run and
 * leaves the next due time be — unless that time has already come, in which
 * case this is that fire, so the timer does not fire it a second time.
 */
export function runScheduleNow(
  id: string,
  availableAgents: readonly string[],
): { schedule: Schedule; run: ScheduleRun } | { refused: string } | undefined {
  const s = getSchedule(id);
  if (!s) return undefined;
  if (!isRunnable(s)) return { refused: `this schedule (${s.when?.kind} on ${s.target?.kind}) is not supported by this build` };
  const due = s.enabled && !!s.nextRunAt && Date.parse(s.nextRunAt) <= schedulerClock.now();
  const fired = fireSchedule(id, availableAgents, due ? "due" : "manual");
  rearmScheduler();
  return fired;
}

/**
 * One fire: claim it, then start its turn. `due`: the timer's fire, which
 * advances the schedule (a `once` is done after it). `manual`: a run now,
 * which counts as a run and moves nothing.
 */
export function fireSchedule(
  id: string,
  availableAgents: readonly string[],
  kind: "due" | "manual",
): { schedule: Schedule; run: ScheduleRun } | undefined {
  const at = iso(schedulerClock.now());

  // Claim first, and persist it, before anything can start.
  let runNumber = 0;
  const claimed = updateSchedule(id, (s) => {
    s.runCount += 1;
    runNumber = s.runCount;
    s.lastRunAt = at;
    if (kind === "due" && s.when.kind === "once") {
      s.nextRunAt = null;
      s.enabled = false;
    }
  });
  if (!claimed) return undefined;

  const run = startScheduledTurn(claimed, runNumber, availableAgents, at);
  const schedule = updateSchedule(id, (s) => { s.history.push(run); }) ?? claimed;
  const where = run.threadId ? ` on thread ${run.threadId}` : "";
  const why = run.error ? ` (${run.error})` : "";
  console.log(`[schedules] fire ${id} run ${runNumber}: ${run.outcome}${where}${why}`);
  return { schedule, run };
}

/** True while the thread has a running turn: the same scan as send-to-thread's. */
function threadIsRunning(threadId: string, sdkSessionId: string | null): boolean {
  if (sdkSessionId && sessions.get(sdkSessionId)?.status === "running") return true;
  return [...sessions.values()].some((s) => s.threadId === threadId && s.status === "running");
}

/** Starts a claimed fire's turn, or says why not. */
function startScheduledTurn(s: Schedule, run: number, availableAgents: readonly string[], at: string): ScheduleRun {
  const threadId = targetThreadId(s);
  if (!threadId) return { at, outcome: "failed-to-start", error: `target "${s.target.kind}" is not supported yet` };
  const thread = getThread(threadId);
  if (!thread) return { at, outcome: "failed-to-start", threadId, error: "thread not found" };
  // Busy: a turn of the thread's own running, or a Jarvis thread waiting on
  // its child. Skipped for now, whatever `overlap` says.
  if (threadIsRunning(thread.id, thread.sdkSessionId) || runningChildOf(thread.id)) {
    return { at, outcome: "skipped-busy", threadId };
  }
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
    return { at, outcome: "failed-to-start", threadId, error: started.message };
  } catch (err: any) {
    return { at, outcome: "failed-to-start", threadId, error: err?.message ?? "failed to start" };
  }
}

/**
 * At startup: a `once` whose time passed while gitbot was down is missed. It
 * gets one "missed" entry and is disabled; it never fires late.
 */
function recordMissed(now: number): void {
  for (const s of runnableSchedules()) {
    if (Date.parse(s.nextRunAt!) > now) continue;
    const dueAt = s.nextRunAt!;
    // One at a time: a schedule that cannot be saved does not stop the rest.
    try {
      updateSchedule(s.id, (x) => {
        x.history.push({ at: dueAt, outcome: "missed", missedCount: 1 });
        x.enabled = false;
        x.nextRunAt = null;
      });
      console.log(`[schedules] missed ${s.id}: due ${dueAt} while gitbot was down`);
    } catch (err: any) {
      missedUnsaved.add(s.id);
      console.error(`[scheduler] could not record ${s.id} as missed (it will not fire): ${err?.message ?? err}`);
    }
  }
}

/**
 * How a scheduled turn ended, onto the run it began: the newest "started"
 * entry for its thread still without an outcome. Never throws into the
 * turn-end loop.
 */
export function noteScheduledTurnEnd(turn: EndedTurn): void {
  const scheduled = turn.scheduled;
  if (!scheduled || isShuttingDown()) return;
  const outcome = turnOutcome(turn);
  updateSchedule(scheduled.id, (s) => {
    const entry = [...s.history].reverse().find((h) => h.outcome === "started" && h.threadId === turn.threadId && !h.turnOutcome);
    if (!entry) return false;
    entry.turnOutcome = outcome;
  });
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
