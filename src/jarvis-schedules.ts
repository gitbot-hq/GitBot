import { BOT_AGENTS, botOrAgent, getBot, getThread, isJarvisBot } from "./bot-store";
import { findProject, projectNames } from "./project-index";
import {
  createSchedule,
  deleteSchedule,
  describeSchedule,
  editSchedule,
  getSchedule,
  listSchedules,
  nextRunsOf,
  scheduleInProject,
  targetThreadId,
  type Notify,
  type Schedule,
  type ScheduleRun,
} from "./schedules";
import { rearmScheduler, runScheduleNow, scheduleChanged, schedulerClock } from "./scheduler";
import {
  canonicalTimeZone,
  defaultTimeZone,
  isLocalTime,
  localIso,
  minGapMinutes,
  zonedTimeToIso,
} from "./schedule-time";

// Jarvis's schedule tools: create_schedule, list_schedules, update_schedule,
// delete_schedule and run_schedule_now. Each one turns its arguments into the
// body the /schedules routes take and goes through the same functions
// (createSchedule, editSchedule, …), so every check, limit and error message
// is the route's own; only the shape of `when` and the reading of times
// without a zone are Jarvis's. Results give times in a named zone, with the
// server's current time, so Jarvis can say "at 17:00 your time" correctly.
// Plain functions, so they can be tested without the SDK (jarvis.ts wires
// them up).

/** Under this many minutes between runs, create_schedule warns about token cost. */
export const COST_WARNING_GAP_MINUTES = 5;
/** Runs list_schedules shows per schedule, newest last. */
export const LIST_RUNS_MAX = 5;
const LIST_PROMPT_CHARS = 300;

/** A `when` as Jarvis gives it: exactly one of these. */
export interface JarvisWhen {
  /** An ISO time; one without an offset is read in `tz` (else the server's zone). */
  once_at?: string;
  /** A once, this many minutes from now. */
  in_minutes?: number;
  /** A 5-field cron pattern, in `tz` (else the server's zone). */
  cron?: string;
  every_minutes?: number;
}

/**
 * "this_thread", an existing thread, or a fresh thread for every run with a
 * bot or a plain agent in a project (resolved as start_thread resolves them).
 */
export type JarvisTarget = "this_thread" | { threadId: string } | { bot?: string; agent?: string; project: string };

export interface CreateScheduleArgs {
  name: string;
  prompt: string;
  when: JarvisWhen;
  target: JarvisTarget;
  tz?: string;
  overlap?: "queue" | "skip";
  notify?: Notify;
  maxRuns?: number;
  endsAt?: string;
}

export interface UpdateScheduleArgs {
  id: string;
  enabled?: boolean;
  name?: string;
  prompt?: string;
  when?: JarvisWhen;
  tz?: string;
  overlap?: "queue" | "skip";
  notify?: Notify;
  maxRuns?: number | null;
  endsAt?: string | null;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const WHEN_KEYS = ["once_at", "in_minutes", "cron", "every_minutes"] as const;

/** The zone times are read and shown in: `tz` when given, else the server's. */
function zoneFor(tz: string | undefined): { ok: true; tz: string } | { ok: false; error: string } {
  return tz === undefined ? defaultTimeZone() : canonicalTimeZone(tz);
}

/** An ISO time, or a wall time with no zone read in `zone`; anything else as given, for the route to refuse. */
function instantIn(text: unknown, zone: string): { ok: true; at: unknown } | { ok: false; error: string } {
  if (!isLocalTime(text)) return { ok: true, at: text };
  const read = zonedTimeToIso(text, zone);
  return read.ok ? { ok: true, at: read.at } : read;
}

/**
 * Jarvis's `when` as the route's (`{ kind: "once" | "cron" | "interval", … }`).
 * A cron gets `tz` as given, so the route checks it; with none, `keepTz`
 * (the schedule's own zone, on an edit) or the route's default.
 */
function routeWhen(when: JarvisWhen, tz: string | undefined, zone: string, at: number, keepTz?: string): Result<{ when: unknown }> {
  if (!when || typeof when !== "object") return { ok: false, error: "when is required" };
  const given = WHEN_KEYS.filter((k) => when[k] !== undefined);
  if (given.length !== 1) return { ok: false, error: `when takes exactly one of ${WHEN_KEYS.join(", ")}` };
  if (when.once_at !== undefined) {
    const read = instantIn(when.once_at, zone);
    return read.ok ? { ok: true, when: { kind: "once", at: read.at } } : read;
  }
  if (when.in_minutes !== undefined) {
    const minutes = when.in_minutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, error: "when.in_minutes must be a number of minutes above 0" };
    }
    return { ok: true, when: { kind: "once", at: new Date(at + minutes * 60_000).toISOString() } };
  }
  if (when.cron !== undefined) {
    const cronTz = tz ?? keepTz;
    return { ok: true, when: { kind: "cron", expr: when.cron, ...(cronTz !== undefined ? { tz: cronTz } : {}) } };
  }
  return { ok: true, when: { kind: "interval", everyMinutes: when.every_minutes } };
}

/** The zone a schedule's times read best in: a cron's own, else `fallback`. */
function shownZone(s: Pick<Schedule, "when">, fallback: string): string {
  return s.when?.kind === "cron" ? s.when.tz : fallback;
}

/** The server's clock, for Jarvis to work out the user's times from. */
function serverClock(at: number) {
  const tz = defaultTimeZone().tz;
  return { now: localIso(at, tz), timeZone: tz };
}

function targetOf(s: Schedule, jarvisThreadId: string) {
  if (s.target?.kind === "new-thread") {
    const bot = getBot(s.target.botId);
    const project = findProject(s.target.projectId);
    return {
      newThread: true as const,
      botId: s.target.botId,
      ...(bot ? { bot: bot.name } : { botGone: true as const }),
      projectId: s.target.projectId,
      ...(project ? { project: projectNames().get(project.id) ?? project.path, folder: project.path } : { projectGone: true as const }),
    };
  }
  const threadId = targetThreadId(s);
  if (!threadId) return { kind: s.target?.kind ?? "unknown" };
  const thread = getThread(threadId);
  return {
    threadId,
    ...(thread ? { title: thread.title } : { threadGone: true as const }),
    ...(threadId === jarvisThreadId ? { thisThread: true as const } : {}),
  };
}

/** active, paused (with pausedReason), or ended. */
function statusOf(s: Schedule): "active" | "paused" | "ended" {
  return s.enabled ? "active" : s.pausedReason ? "paused" : "ended";
}

function logWrite(verb: string, id: string, jarvisThreadId: string): void {
  console.log(`[schedules] ${verb} ${id} from Jarvis thread ${jarvisThreadId}`);
}

// --- create_schedule ---

export type CreateScheduleResult = Result<{
  id: string;
  name: string;
  schedule: string;
  target: ReturnType<typeof targetOf>;
  timeZone: string;
  nextRuns: string[];
  maxRuns?: number;
  /** As stored, in timeZone. */
  endsAt?: string;
  notify: Notify;
  overlap: "queue" | "skip";
  serverTime: { now: string; timeZone: string };
  warning?: string;
  /** A new-thread target: where its results go. */
  note?: string;
}>;

/** What create_schedule says about a new-thread target's runs. */
export const NEW_THREAD_NOTE =
  "Each run starts a fresh thread, owned by the user, that never reports back to you. Its runs share one folder, so a run never starts while the last one is still going: overlap queues it (one waits at most) or skips it. Its results: a push (by notify), its run history in list_schedules with each run's thread id, and read_thread_tail on that thread.";

export function createScheduleForJarvis(
  jarvisThreadId: string,
  args: CreateScheduleArgs,
  at: number = schedulerClock.now(),
  availableAgents?: readonly string[],
): CreateScheduleResult {
  const zone = zoneFor(args.tz);
  if (!zone.ok) return zone;
  const when = routeWhen(args.when, args.tz, zone.tz, at);
  if (!when.ok) return when;
  // A cron with no tz runs in the server's zone, which is zone.tz then too.
  const endsAt = args.endsAt === undefined ? { ok: true as const, at: undefined } : instantIn(args.endsAt, zone.tz);
  if (!endsAt.ok) return endsAt;

  const target = routeTarget(args.target, jarvisThreadId, availableAgents);
  if (!target.ok) return target;

  const created = createSchedule(
    {
      name: args.name,
      prompt: args.prompt,
      when: when.when,
      target: target.target,
      overlap: args.overlap,
      notify: args.notify,
      maxRuns: args.maxRuns,
      endsAt: endsAt.at,
    },
    { kind: "jarvis", threadId: jarvisThreadId },
    at,
    availableAgents,
  );
  if (!created.ok) return created;
  const s = created.schedule;
  logWrite("create", s.id, jarvisThreadId);
  rearmScheduler();

  const tz = shownZone(s, zone.tz);
  const gap = minGapMinutes(s.when, at);
  return {
    ok: true,
    id: s.id,
    name: s.name,
    schedule: describeSchedule(s, tz),
    target: targetOf(s, jarvisThreadId),
    timeZone: tz,
    nextRuns: nextRunsOf(s, 3).map((t) => localIso(Date.parse(t), tz)),
    ...(s.maxRuns ? { maxRuns: s.maxRuns } : {}),
    ...(s.endsAt ? { endsAt: localIso(Date.parse(s.endsAt), tz) } : {}),
    notify: s.notify,
    overlap: s.overlap,
    serverTime: serverClock(at),
    ...(gap < COST_WARNING_GAP_MINUTES
      ? { warning: `Runs ${gap} minute${gap === 1 ? "" : "s"} apart: every run is a full agent turn, so this costs tokens quickly. Tell the user, and offer a longer gap or maxRuns.` }
      : {}),
    ...(s.target.kind === "new-thread" ? { note: NEW_THREAD_NOTE } : {}),
  };
}

const TARGET_SHAPES = `target must be "this_thread", { threadId }, or { bot or agent, project } for a fresh thread each run`;

/**
 * Jarvis's target as the route's. A bot or plain agent is resolved as
 * start_thread resolves it (botOrAgent); the route checks the rest (the
 * bot's setup, the project), with its own messages.
 */
function routeTarget(target: JarvisTarget, jarvisThreadId: string, availableAgents?: readonly string[]): Result<{ target: unknown }> {
  if (target === "this_thread") return { ok: true, target: { kind: "thread", threadId: jarvisThreadId } };
  if (!target || typeof target !== "object") return { ok: false, error: TARGET_SHAPES };
  if ("threadId" in target && typeof target.threadId === "string") return { ok: true, target: { kind: "thread", threadId: target.threadId } };
  if (!("project" in target) || typeof target.project !== "string") return { ok: false, error: TARGET_SHAPES };
  // Without the installed agents (a test), any agent is taken as installed.
  const resolved = botOrAgent(target, availableAgents ?? BOT_AGENTS);
  if (!resolved.ok) return resolved;
  if (isJarvisBot(resolved.bot)) return { ok: false, error: "a new-thread schedule cannot start a Jarvis thread: use this_thread" };
  return { ok: true, target: { kind: "new-thread", botId: resolved.bot.id, projectId: target.project } };
}

// --- list_schedules ---

export interface ScheduleListing {
  id: string;
  name: string;
  status: "active" | "paused" | "ended";
  pausedReason?: string;
  schedule: string;
  prompt: string;
  target: ReturnType<typeof targetOf>;
  timeZone: string;
  nextRunAt: string | null;
  /** A fire waiting for its busy thread: since when. */
  waitingSince?: string;
  runCount: number;
  maxRuns?: number;
  endsAt?: string;
  notify: Notify;
  overlap: "queue" | "skip";
  createdBy: string;
  /** Someone else (the API, another Jarvis thread) changed or re-armed it: its runs are data to its maker. */
  changedByOther?: true;
  lastRuns: (Omit<ScheduleRun, "at" | "dueAt"> & { at: string })[];
}

export type ListSchedulesResult = Result<{ schedules: ScheduleListing[]; serverTime: { now: string; timeZone: string } }>;

function listing(s: Schedule, jarvisThreadId: string, serverZone: string): ScheduleListing {
  const tz = shownZone(s, serverZone);
  const local = (t: string) => localIso(Date.parse(t), tz);
  const by = s.createdBy?.kind === "jarvis"
    ? (s.createdBy.threadId === jarvisThreadId ? "you, in this thread" : `Jarvis thread ${s.createdBy.threadId}`)
    : "the user";
  return {
    id: s.id,
    name: s.name,
    status: statusOf(s),
    ...(s.pausedReason ? { pausedReason: s.pausedReason } : {}),
    schedule: describeSchedule(s, tz),
    prompt: s.prompt.length > LIST_PROMPT_CHARS ? `${s.prompt.slice(0, LIST_PROMPT_CHARS)}…` : s.prompt,
    target: targetOf(s, jarvisThreadId),
    timeZone: tz,
    nextRunAt: s.nextRunAt ? local(s.nextRunAt) : null,
    ...(s.pending ? { waitingSince: local(s.pending.dueAt) } : {}),
    runCount: s.runCount,
    ...(s.maxRuns ? { maxRuns: s.maxRuns } : {}),
    ...(s.endsAt ? { endsAt: local(s.endsAt) } : {}),
    notify: s.notify,
    overlap: s.overlap,
    createdBy: by,
    ...(s.changedByOther ? { changedByOther: true as const } : {}),
    lastRuns: (s.history ?? []).slice(-LIST_RUNS_MAX).map(({ dueAt: _dueAt, ...run }) => ({ ...run, at: local(run.at) })),
  };
}

/** Every schedule, or those on one thread ("this_thread" is the caller's), or on threads in one project. */
export function listSchedulesForJarvis(
  jarvisThreadId: string,
  filter: { threadId?: string; project?: string },
  at: number = schedulerClock.now(),
): ListSchedulesResult {
  const thisThread = filter.threadId === "this_thread";
  const threadId = thisThread ? jarvisThreadId : filter.threadId;
  if (filter.project && !findProject(filter.project)) return { ok: false, error: `no project with id "${filter.project}": use list_projects` };
  let all = listSchedules(threadId ? { threadId } : {});
  // "this_thread" also lists the fresh-thread schedules this thread made:
  // they target no thread, but they are its own.
  if (thisThread) {
    const made = listSchedules().filter((s) => s.target?.kind === "new-thread" && (s.notesTo === jarvisThreadId || (s.createdBy?.kind === "jarvis" && s.createdBy.threadId === jarvisThreadId)));
    all = [...all, ...made];
  }
  if (filter.project) {
    all = all.filter((s) => scheduleInProject(s, filter.project!));
  }
  const serverZone = defaultTimeZone().tz;
  return { ok: true, schedules: all.map((s) => listing(s, jarvisThreadId, serverZone)), serverTime: serverClock(at) };
}

// --- update_schedule ---

export type UpdateScheduleResult = Result<{
  id: string;
  name: string;
  done: "pause" | "resume" | "update";
  status: "active" | "paused" | "ended";
  pausedReason?: string;
  schedule: string;
  timeZone: string;
  nextRuns: string[];
  maxRuns?: number;
  /** As stored, in timeZone. */
  endsAt?: string;
  notify: Notify;
  overlap: "queue" | "skip";
  serverTime: { now: string; timeZone: string };
}>;

const EDIT_KEYS = ["enabled", "name", "prompt", "overlap", "notify", "maxRuns"] as const;
/** Everything update_schedule changes, but tz: the test for "tz alone". */
const UPDATE_KEYS = [...EDIT_KEYS, "when", "endsAt"] as const;

export function updateScheduleForJarvis(jarvisThreadId: string, args: UpdateScheduleArgs, at: number = schedulerClock.now()): UpdateScheduleResult {
  const s = getSchedule(args.id);
  if (!s) return { ok: false, error: "Schedule not found" };
  const zone = zoneFor(args.tz);
  if (!zone.ok) return zone;
  // A new cron pattern without a tz keeps the schedule's own zone. A tz with
  // other changes only says how to read their times; a tz alone moves a cron
  // schedule to that zone.
  const ownCronTz = s.when?.kind === "cron" ? s.when.tz : undefined;
  const tzAlone = args.tz !== undefined && !UPDATE_KEYS.some((k) => args[k] !== undefined);
  let whenArg = args.when;
  if (whenArg === undefined && tzAlone && s.when?.kind === "cron") whenArg = { cron: s.when.expr };

  const body: Record<string, unknown> = {};
  for (const k of EDIT_KEYS) if (args[k] !== undefined) body[k] = args[k];
  if (whenArg !== undefined) {
    const when = routeWhen(whenArg, args.tz, zone.tz, at, ownCronTz);
    if (!when.ok) return when;
    // The same times are no new `when`: one would drop a fire waiting for a busy thread.
    if (!sameWhen(s.when, when.when, zone.tz)) body.when = when.when;
  }
  // Like a once_at: in tz, else the server's zone, whatever the cron's own.
  if (args.endsAt !== undefined) {
    if (args.endsAt === null) body.endsAt = null;
    else {
      const read = instantIn(args.endsAt, zone.tz);
      if (!read.ok) return read;
      body.endsAt = read.at;
    }
  }
  // Nothing left to change (a zone or times it already has): it stands as it is.
  if (!Object.keys(body).length && whenArg !== undefined) return updateResult(s, "update", zone.tz, at);

  const edited = editSchedule(args.id, body, at, { kind: "jarvis", threadId: jarvisThreadId });
  if (!edited.ok) return edited;
  logWrite(edited.verb, args.id, jarvisThreadId);
  if (edited.droppedPending) console.log(`[schedules] ${args.id}: the fire queued since ${edited.droppedPending} is dropped (${edited.verb})`);
  scheduleChanged(args.id);

  return updateResult(edited.schedule, edited.verb, zone.tz, at);
}

function updateResult(s: Schedule, done: "pause" | "resume" | "update", fallbackZone: string, at: number): UpdateScheduleResult {
  const tz = shownZone(s, fallbackZone);
  return {
    ok: true,
    id: s.id,
    name: s.name,
    done,
    status: statusOf(s),
    ...(s.pausedReason ? { pausedReason: s.pausedReason } : {}),
    schedule: describeSchedule(s, tz),
    timeZone: tz,
    nextRuns: nextRunsOf(s, 3).map((t) => localIso(Date.parse(t), tz)),
    ...(s.maxRuns ? { maxRuns: s.maxRuns } : {}),
    ...(s.endsAt ? { endsAt: localIso(Date.parse(s.endsAt), tz) } : {}),
    notify: s.notify,
    overlap: s.overlap,
    serverTime: serverClock(at),
  };
}

/**
 * True when a route `when` from routeWhen is the schedule's own times: the
 * same cron pattern (as parseWhen tidies it) in the same zone, or the same
 * once. An interval never is: its anchor is now.
 */
function sameWhen(own: Schedule["when"], next: any, defaultZone: string): boolean {
  if (!own || !next) return false;
  if (own.kind === "cron" && next.kind === "cron") {
    const expr = typeof next.expr === "string" ? next.expr.trim().replace(/\s+/g, " ") : null;
    const tz = next.tz === undefined ? { ok: true as const, tz: defaultZone } : canonicalTimeZone(next.tz);
    return expr === own.expr && tz.ok && tz.tz === own.tz;
  }
  if (own.kind === "once" && next.kind === "once") {
    return typeof next.at === "string" && Date.parse(next.at) === Date.parse(own.at);
  }
  return false;
}

// --- delete_schedule ---

export function deleteScheduleForJarvis(jarvisThreadId: string, id: string): Result<{ deleted: string; name: string }> {
  const s = getSchedule(id);
  if (!s || !deleteSchedule(id)) return { ok: false, error: "Schedule not found" };
  logWrite("delete", id, jarvisThreadId);
  scheduleChanged(id);
  return { ok: true, deleted: id, name: s.name };
}

// --- run_schedule_now ---

export type RunScheduleNowResult = Result<{
  id: string;
  name: string;
  /** Its thread was busy: it waits, and runs once that thread's turn ends. */
  queued?: true;
  run?: { outcome: ScheduleRun["outcome"]; threadId?: string; error?: string };
  note: string;
}>;

export function runScheduleNowForJarvis(
  jarvisThreadId: string,
  id: string,
  availableAgents: readonly string[],
): RunScheduleNowResult {
  if (!getSchedule(id)) return { ok: false, error: "Schedule not found" };
  const fired = runScheduleNow(id, availableAgents, { kind: "jarvis", threadId: jarvisThreadId });
  if (!fired) return { ok: false, error: "Schedule not found" };
  if ("refused" in fired) {
    logWrite("run-refused", id, jarvisThreadId);
    return { ok: false, error: fired.refused };
  }
  logWrite("run", id, jarvisThreadId);
  const s = fired.schedule;
  const onThisThread = targetThreadId(s) === jarvisThreadId;
  if (fired.queued) {
    return {
      ok: true,
      id: s.id,
      name: s.name,
      queued: true,
      note: onThisThread
        ? "This thread is busy with this very turn: the run starts as soon as your turn ends."
        : "Its thread is busy: the run starts as soon as that thread's turn ends.",
    };
  }
  const run = fired.run!;
  return {
    ok: true,
    id: s.id,
    name: s.name,
    run: { outcome: run.outcome, ...(run.threadId ? { threadId: run.threadId } : {}), ...(run.error ? { error: run.error } : {}) },
    note: run.outcome === "started"
      ? "It is running now. It does not report back to you; its result is in its thread."
      : `It did not start (${run.outcome}).`,
  };
}
