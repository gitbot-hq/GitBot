import { jsonError, jsonOk, parseQuery, readBody, type IRequest, type IResponse } from "./server-common";
import { createSchedule, deleteSchedule, editSchedule, getSchedule, listSchedules, nextRunsOf } from "./schedules";
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

  // GET /schedules?threadId=
  if (method === "GET" && path === "/schedules") {
    const { threadId } = parseQuery(url);
    jsonOk(res, {
      schedules: listSchedules(threadId ? { threadId } : {}),
      // Fixed for now: one gitbot per data dir runs every schedule.
      owner: { pid: process.pid, thisProcess: true },
    });
    return true;
  }

  // POST /schedules
  if (method === "POST" && path === "/schedules") {
    const body = await readBody(req);
    const created = createSchedule(body, { kind: "user", remote: remoteOf(req) }, schedulerClock.now());
    if (!created.ok) { jsonError(res, 400, created.error); return true; }
    logWrite("create", created.schedule.id, req);
    rearmScheduler();
    // The next 3 run times, to check the maths against.
    jsonOk(res, { ...created.schedule, nextRuns: nextRunsOf(created.schedule, 3) });
    return true;
  }

  const rest = path.slice("/schedules/".length);
  const [id, action, ...extra] = rest.split("/");
  if (!id || extra.length) return false;

  // PATCH /schedules/:id: pause, resume, edit
  if (method === "PATCH" && action === undefined) {
    if (!getSchedule(id)) { jsonError(res, 404, "Schedule not found"); return true; }
    const body = await readBody(req);
    const edited = editSchedule(id, body, schedulerClock.now());
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
    const fired = runScheduleNow(id, availableAgents);
    if (!fired) { jsonError(res, 404, "Schedule not found"); return true; }
    if ("refused" in fired) { logWrite("run-refused", id, req); jsonError(res, 400, fired.refused); return true; }
    logWrite("run", id, req);
    jsonOk(res, fired);
    return true;
  }

  return false;
}
