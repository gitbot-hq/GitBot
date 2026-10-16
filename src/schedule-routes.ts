import { EventEmitter } from "events";
import { onThreadDeleted, onThreadSeen } from "./bot-store";
import { jsonError, jsonOk, parseQuery, readBody, type IRequest, type IResponse } from "./server-common";
import { findProject } from "./project-index";
import { checkTarget, createSchedule, deleteSchedule, editSchedule, getSchedule, listSchedules, listSchedulesFor, nextRunsOf, onSchedulesWritten, previewTiming, targetThreadId, viewContext, viewSchedule } from "./schedules";
import { canonicalTimeZone, defaultTimeZone } from "./schedule-time";
import { rearmScheduler, runScheduleNow, scheduleChanged, schedulerClock } from "./scheduler";

// /schedules: list, create, change (pause, resume, edit), delete and run
// now. No access guard yet (anyone who can reach the port can plant a
// schedule that later runs unattended): every route passes
// canWriteSchedules, a hook for that guard, and every write is logged with
// who sent it.

/**
 * Whether this request may change schedules. Always yes for now: the hook
 * for the access guard (docs/issues/jarvis/18-access-guard.md).
 */
export function canWriteSchedules(_req: IRequest): { ok: true } | { ok: false; status: number; message: string } {
  return { ok: true };
}

/**
 * The address a request came from: the socket's peer. Behind a proxy (the
 * exe.dev HTTPS proxy) that is the proxy, not the client; the access guard
 * (issue 18) has to decide whether to trust X-Forwarded-For.
 */
function remoteOf(req: IRequest): string | undefined {
  return req.socket?.remoteAddress || undefined;
}

function logWrite(verb: string, id: string, req: IRequest): void {
  // The forwarded chain is logged for reading, never trusted or stored.
  const fwd = req.headers["x-forwarded-for"];
  const via = fwd ? ` (x-forwarded-for: ${String(fwd).slice(0, 200)})` : "";
  console.log(`[schedules] ${verb} ${id} from ${remoteOf(req) ?? "unknown"}${via}`);
}

/** How many of the listed schedules need attention: GET /schedules and the live event agree. */
function attentionCountOf(views: { attention?: unknown }[]): number {
  return views.filter((s) => s.attention).length;
}

/** The whole list's attention count now (the zone only changes `describe`, not attention). */
export function scheduleAttentionCount(): number {
  const ctx = viewContext(defaultTimeZone().tz, schedulerClock.now());
  return attentionCountOf(listSchedulesFor().map((s) => viewSchedule(s, ctx)));
}

// --- Live hint: the `schedules` event on /permissions/events ---
// Every write of schedules.json (and a view of a thread a schedule ran on,
// which can clear a failed run's attention) bumps `version`; one event goes
// out per burst, SCHEDULES_EVENT_DEBOUNCE_MS after its first change. The UI
// re-reads GET /schedules on it: the event carries no schedules.

export const SCHEDULES_EVENT_DEBOUNCE_MS = 250;
export type SchedulesEvent = { version: number; attentionCount: number };
/** Emits "update" with a SchedulesEvent, once per burst. */
export const schedulesEmitter = new EventEmitter();
schedulesEmitter.setMaxListeners(0);
let schedulesVersion = 0;
let schedulesTimer: ReturnType<typeof setTimeout> | null = null;
let unwatchSchedules: (() => void) | null = null;

/** The event as it stands, for a stream that just connected. */
export function currentSchedulesEvent(): SchedulesEvent {
  let attentionCount = 0;
  try {
    attentionCount = scheduleAttentionCount();
  } catch (err: any) {
    console.error(`[schedules] attention count: ${err?.message ?? err}`);
  }
  return { version: schedulesVersion, attentionCount };
}

function bumpSchedules(): void {
  schedulesVersion += 1;
  if (schedulesTimer) return;
  schedulesTimer = setTimeout(() => {
    schedulesTimer = null;
    schedulesEmitter.emit("update", currentSchedulesEvent());
  }, SCHEDULES_EVENT_DEBOUNCE_MS);
  schedulesTimer.unref?.();
}

/** Subscribes once (start, or a test): later calls do nothing. Returns the unsubscribe. */
export function watchScheduleEvents(): () => void {
  if (!unwatchSchedules) {
    const offWrites = onSchedulesWritten(bumpSchedules);
    // A thread a schedule targets or ran on: viewing it can clear a failed
    // run's attention; deleting it unlinks its Recent row even when nothing
    // in schedules.json changes (a new-thread schedule's run thread).
    const touched = (thread: { id: string }) => {
      const touches = listSchedules().some((s) =>
        targetThreadId(s) === thread.id || s.history?.some((run) => run.threadId === thread.id));
      if (touches) bumpSchedules();
    };
    const offSeen = onThreadSeen(touched);
    const offDeleted = onThreadDeleted(touched);
    unwatchSchedules = () => {
      offWrites();
      offSeen();
      offDeleted();
      if (schedulesTimer) clearTimeout(schedulesTimer);
      schedulesTimer = null;
      unwatchSchedules = null;
    };
  }
  return unwatchSchedules;
}

export async function handleScheduleRoutes(
  req: IRequest,
  res: IResponse,
  availableAgents: readonly string[],
): Promise<boolean> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const path = url.split("?")[0];
  if (path !== "/schedules" && !path.startsWith("/schedules/")) return false;

  const allowed = canWriteSchedules(req);
  if (!allowed.ok) { jsonError(res, allowed.status, allowed.message); return true; }

  // GET /schedules?threadId=&projectId=&tz=
  if (method === "GET" && path === "/schedules") {
    const { threadId, projectId, tz } = parseQuery(url);
    if (projectId && !findProject(projectId)) { jsonError(res, 400, `no project with id "${projectId}"`); return true; }
    // `tz`: the viewer's zone, for a once's `describe`; a bad one is ignored.
    const zone = tz ? canonicalTimeZone(tz) : null;
    const now = schedulerClock.now();
    // Threads, bots and project names read once, for the whole list.
    const ctx = viewContext(zone?.ok ? zone.tz : defaultTimeZone().tz, now);
    const schedules = listSchedulesFor({ threadId: threadId || undefined, projectId: projectId || undefined })
      .map((s) => viewSchedule(s, ctx));
    jsonOk(res, {
      schedules,
      attentionCount: attentionCountOf(schedules),
      now: new Date(now).toISOString(),
      // Fixed for now: one gitbot per data dir runs every schedule.
      owner: { pid: process.pid, thisProcess: true },
    });
    return true;
  }

  // POST /schedules
  if (method === "POST" && path === "/schedules") {
    const body = await readBody(req);
    const created = createSchedule(body, { kind: "user", remote: remoteOf(req) }, schedulerClock.now(), availableAgents);
    if (!created.ok) { jsonError(res, 400, created.error); return true; }
    logWrite("create", created.schedule.id, req);
    rearmScheduler();
    // The next 3 run times, to check the maths against.
    jsonOk(res, { ...created.schedule, nextRuns: nextRunsOf(created.schedule, 3) });
    return true;
  }

  // POST /schedules/preview {when, maxRuns?, endsAt?, tz, target?}: the
  // times a new schedule would get, or the 400 POST /schedules would give.
  // A `target`, when sent, is checked too (a thread gone or in setup; a
  // new-thread bot that is Jarvis, needs setup or runs on an agent not
  // installed here; a project gone), after the times. Writes nothing, so it
  // is not logged.
  if (method === "POST" && path === "/schedules/preview") {
    const body = await readBody(req);
    const zone = body?.tz === undefined ? defaultTimeZone() : canonicalTimeZone(body.tz);
    if (!zone.ok) { jsonError(res, 400, zone.error); return true; }
    const preview = previewTiming(body, zone.tz, schedulerClock.now());
    if (!preview.ok) { jsonError(res, 400, preview.error); return true; }
    if (body?.target !== undefined) {
      const target = checkTarget(body.target, availableAgents);
      if (!target.ok) { jsonError(res, 400, target.error); return true; }
    }
    jsonOk(res, preview.preview);
    return true;
  }

  const rest = path.slice("/schedules/".length);
  const [id, action, ...extra] = rest.split("/");
  if (!id || extra.length) return false;

  // PATCH /schedules/:id: pause, resume, edit
  if (method === "PATCH" && action === undefined) {
    if (!getSchedule(id)) { jsonError(res, 404, "Schedule not found"); return true; }
    const body = await readBody(req);
    const edited = editSchedule(id, body, schedulerClock.now(), { kind: "user", remote: remoteOf(req) });
    if (!edited.ok) { jsonError(res, edited.status, edited.error); return true; }
    logWrite(edited.verb, id, req);
    if (edited.droppedPending) console.log(`[schedules] ${id}: the fire queued since ${edited.droppedPending} is dropped (${edited.verb})`);
    scheduleChanged(id);
    jsonOk(res, { ...edited.schedule, nextRuns: nextRunsOf(edited.schedule, 3) });
    return true;
  }

  // DELETE /schedules/:id
  if (method === "DELETE" && action === undefined) {
    if (!deleteSchedule(id)) { jsonError(res, 404, "Schedule not found"); return true; }
    logWrite("delete", id, req);
    scheduleChanged(id);
    jsonOk(res, { ok: true });
    return true;
  }

  // POST /schedules/:id/run
  if (method === "POST" && action === "run") {
    if (!getSchedule(id)) { jsonError(res, 404, "Schedule not found"); return true; }
    const fired = runScheduleNow(id, availableAgents, { kind: "user", remote: remoteOf(req) });
    if (!fired) { jsonError(res, 404, "Schedule not found"); return true; }
    if ("refused" in fired) { logWrite("run-refused", id, req); jsonError(res, 400, fired.refused); return true; }
    logWrite("run", id, req);
    jsonOk(res, fired);
    return true;
  }

  return false;
}
