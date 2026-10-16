// What the schedules panel and the thread row's clock badge show, as plain
// functions of the server's data (GET /schedules, GET /threads), so the words
// are tested without a browser. No model or effort anywhere: a schedule has
// none, and a run's thread shows its own.

import type { Schedule, ScheduleNotify, ScheduleRun, ScheduleView, ThreadFull } from "./gitbot";

/** Runs the panel lists per schedule, newest first. */
export const PANEL_RUNS = 5;

export const NOTIFY_OPTIONS: { value: ScheduleNotify; label: string }[] = [
  { value: "always", label: "always" },
  { value: "on-failure", label: "on failure" },
  { value: "never", label: "never" },
];

/**
 * `active`: it fires (or holds a fire). `paused`: stopped, with a reason, and
 * can be resumed. `ended`: it will never fire again (a once that ran, used-up
 * maxRuns, past endsAt): only Delete is left.
 */
export type ScheduleState = "active" | "paused" | "ended";

export function scheduleState(s: Pick<Schedule, "enabled" | "pausedReason"> & { state?: ScheduleState }): ScheduleState {
  // The server's own word, when it gave one: a paused schedule that can no
  // longer fire is "ended" there.
  if (s.state) return s.state;
  if (s.enabled) return "active";
  return s.pausedReason ? "paused" : "ended";
}

function parts(at: number, timeZone?: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(new Date(at))) p[type] = value;
  return p as { year: string; month: string; day: string; weekday: string; hour: string; minute: string };
}

/**
 * A time, short, in the viewer's zone: "09:00" today, "Thu 09:00" within the
 * next six days, else "17 Oct 09:00" (with the year when it isn't this one).
 */
export function shortTime(iso: string, now: number = Date.now(), timeZone?: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const t = parts(at, timeZone);
  const n = parts(now, timeZone);
  const clock = `${t.hour}:${t.minute}`;
  if (t.year === n.year && t.month === n.month && t.day === n.day) return clock;
  if (at > now && at - now < 6 * 86_400_000) return `${t.weekday} ${clock}`;
  return `${t.day} ${t.month}${t.year === n.year ? "" : ` ${t.year}`} ${clock}`;
}

/** A time in full, for a tooltip: "Thu 17 Oct 2026, 09:00". */
export function fullTime(iso: string, timeZone?: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const t = parts(at, timeZone);
  return `${t.weekday} ${t.day} ${t.month} ${t.year}, ${t.hour}:${t.minute}`;
}

/** The thread row's clock badge: its soonest next run, or null for no badge. */
export function threadBadge(
  t: Pick<ThreadFull, "schedule">,
  now: number = Date.now(),
  timeZone?: string,
): { label: string; title: string } | null {
  const s = t.schedule;
  if (!s || s.count < 1) return null;
  const many = s.count === 1 ? "1 schedule" : `${s.count} schedules`;
  if (!s.nextRunAt) return { label: "", title: `${many}, waiting for this thread` };
  return { label: shortTime(s.nextRunAt, now, timeZone), title: `${many}, next run ${fullTime(s.nextRunAt, timeZone)}` };
}

/** A gap in words: "45s", "3m", "2h 5m". */
export function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** How a run went, in a few words. */
export function runText(r: ScheduleRun): string {
  let text: string;
  switch (r.outcome) {
    case "started":
      text = r.turnOutcome ? `started · ${r.turnOutcome}` : "started · running";
      break;
    case "skipped-busy":
      text = "skipped: thread busy";
      break;
    case "missed": {
      const n = r.missedCount ?? 1;
      text = `missed ${n} run${n === 1 ? "" : "s"}`;
      break;
    }
    case "failed-to-start":
      text = r.error ? `failed to start: ${r.error}` : "failed to start";
      break;
    default:
      text = String(r.outcome);
  }
  if (r.delayedMs && r.delayedMs >= 1000) text += ` · ${durationText(r.delayedMs)} late`;
  return text;
}

/** The last runs, newest first. */
export function lastRuns<R extends ScheduleRun>(s: { history: R[] }, n: number = PANEL_RUNS): R[] {
  return (s.history ?? []).slice(-n).reverse();
}

/** Who made it: a Jarvis thread (the panel links it), or the user and from where. */
export function createdByText(s: Pick<Schedule, "createdBy">): string {
  const by = s.createdBy;
  if (by?.kind === "jarvis") return "created by Jarvis";
  return by?.remote ? `created by you (${by.remote.replace(/^::ffff:/, "")})` : "created by you";
}

/** The status line: next run, waiting, paused (why), or ended. */
export function statusText(s: Schedule & { state?: ScheduleState }, now: number = Date.now(), timeZone?: string): string {
  const state = scheduleState(s);
  const waiting = s.pending ? " · a run is waiting for the thread" : "";
  if (state === "paused") return `Paused: ${s.pausedReason}${waiting}`;
  if (state === "ended") return `Ended${waiting}`;
  if (!s.nextRunAt) return s.pending ? "A run is waiting for the thread" : "No next run";
  return `Next run ${shortTime(s.nextRunAt, now, timeZone)}${waiting}`;
}

/** Where its runs go, when it isn't this thread: a fresh thread each run, or another thread. */
export function targetText(s: Schedule, threadId: string): string | null {
  if (s.target.kind === "new-thread") return "a new thread each run";
  if (s.target.threadId !== threadId) return "runs on another thread";
  return null;
}

/** What the panel offers: Pause or Resume, Run now, Notify, Delete. An ended one only Delete. */
export function scheduleActions(s: Pick<Schedule, "enabled" | "pausedReason"> & { state?: ScheduleState; canResume?: boolean }): {
  pause: boolean;
  resume: boolean;
  runNow: boolean;
  notify: boolean;
  delete: true;
} {
  const state = scheduleState(s);
  return {
    pause: state === "active",
    resume: state === "paused" && s.canResume !== false,
    runNow: state !== "ended",
    notify: state !== "ended",
    delete: true,
  };
}

export function panelLabel(count: number): string {
  return count === 1 ? "1 schedule" : `${count} schedules`;
}

/** The card's next runs (the server's 3), in the viewer's zone; null when it won't fire. */
export function nextRunsText(
  s: Pick<ScheduleView, "nextRuns" | "state">,
  now: number = Date.now(),
  timeZone?: string,
): string | null {
  if (s.state !== "active" || !s.nextRuns?.length) return null;
  return s.nextRuns.map((at) => shortTime(at, now, timeZone)).join(" · ");
}

export type CardLink = { botId: string; threadId: string };

/**
 * Where the card says it runs. `threadId`: the thread whose panel shows the
 * card; a schedule running there says nothing.
 */
export function cardWhere(
  s: Pick<ScheduleView, "where">,
  threadId?: string,
): { lead: string; title?: string; tail?: string; link?: CardLink } | null {
  const w = s.where;
  if (w.kind === "thread") {
    if (w.threadId === threadId) return null;
    return { lead: "runs on", title: w.title, tail: w.botName, link: { botId: w.botId, threadId: w.threadId } };
  }
  if (w.kind === "new-thread") return { lead: `a new thread each run in ${w.projectName} · ${w.botName}` };
  return { lead: "its target is gone" };
}

/** Who made it: "Made by Jarvis in <thread>" (linked), "Made by you". */
export function madeBy(
  s: Pick<ScheduleView, "createdBy" | "createdIn">,
  threadId?: string,
): { lead: string; title?: string; link?: CardLink } {
  const by = s.createdBy;
  if (by?.kind === "jarvis") {
    if (by.threadId === threadId) return { lead: "Made by Jarvis in this thread" };
    const t = s.createdIn;
    if (!t) return { lead: "Made by Jarvis (its thread is gone)" };
    return { lead: "Made by Jarvis in", title: t.title, link: { botId: t.botId, threadId: t.threadId } };
  }
  return { lead: by?.remote ? `Made by you (${by.remote.replace(/^::ffff:/, "")})` : "Made by you" };
}

/** On a card Jarvis acts on as the user's own words (ownWords). */
export const OWN_WORDS_HINT = "Jarvis acts on this as your request";
