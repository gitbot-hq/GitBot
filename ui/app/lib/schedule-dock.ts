// What the Scheduled dock at the bottom of the bots rail shows, as plain
// functions of GET /schedules (its view fields), so the groups, order and
// words are tested without a browser. No model or effort: a schedule has none.

import type { ScheduleRun, ScheduleView } from "./gitbot";
import { fullTime, runText, shortTime } from "./schedules";

/** Up next rows in the rail; the rest are a "+N more". */
export const UP_NEXT_MAX = 5;
/** Recent runs in the rail. */
export const RECENT_MAX = 5;
/** How far back Recent looks. */
export const RECENT_WINDOW_MS = 24 * 3_600_000;

export type RecentRun = { schedule: ScheduleView; run: ScheduleRun & { botId?: string } };

export type DockGroups = {
  /** System-paused, or a failed last run still unread: newest first. */
  attention: ScheduleView[];
  /** Active: a waiting fire first, then the soonest next run. At most UP_NEXT_MAX. */
  upNext: ScheduleView[];
  /** Active ones past UP_NEXT_MAX. */
  more: number;
  /** Runs in the last 24 h across all schedules, newest first. */
  recent: RecentRun[];
  /** Paused by the user: counted, not listed. */
  pausedCount: number;
  endedCount: number;
};

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export function dockGroups(list: readonly ScheduleView[], now: number = Date.now()): DockGroups {
  const attention = list.filter((s) => s.attention).sort((a, b) => time(b.attention!.at) - time(a.attention!.at));
  const active = list
    .filter((s) => s.state === "active" && !s.attention)
    .sort((a, b) => {
      if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
      if (a.pending && b.pending) return time(a.pending.dueAt) - time(b.pending.dueAt);
      const an = time(a.nextRunAt);
      const bn = time(b.nextRunAt);
      if (Number.isNaN(an) !== Number.isNaN(bn)) return Number.isNaN(an) ? 1 : -1;
      return (an || 0) - (bn || 0);
    });
  const recent: RecentRun[] = [];
  for (const s of list) {
    for (const run of s.history ?? []) {
      const at = time(run.at);
      if (now - at <= RECENT_WINDOW_MS && at <= now + 60_000) recent.push({ schedule: s, run });
    }
  }
  recent.sort((a, b) => time(b.run.at) - time(a.run.at));
  return {
    attention,
    upNext: active.slice(0, UP_NEXT_MAX),
    more: Math.max(0, active.length - UP_NEXT_MAX),
    recent: recent.slice(0, RECENT_MAX),
    pausedCount: list.filter((s) => s.state === "paused" && !s.attention).length,
    endedCount: list.filter((s) => s.state === "ended" && !s.attention).length,
  };
}

/** Where it runs, in a few words. */
export function whereText(s: Pick<ScheduleView, "where">): string {
  const w = s.where;
  if (w.kind === "thread") return `${w.title} · ${w.botName}`;
  if (w.kind === "new-thread") return `new thread in ${w.projectName} · ${w.botName}`;
  return "its thread is gone";
}

/** A row: its name, the time on the right, a second line, and the tooltip (and aria-label). */
export function rowText(
  s: ScheduleView,
  now: number = Date.now(),
  timeZone?: string,
): { title: string; time: string; line: string; tooltip: string } {
  let at = "";
  let line = whereText(s);
  if (s.attention) {
    at = shortTime(s.attention.at, now, timeZone);
    line = s.attention.kind === "failed" ? `${s.attention.text} · ${at}` : s.attention.text;
  } else if (s.pending) {
    at = "waiting";
  } else if (s.nextRunAt) {
    at = shortTime(s.nextRunAt, now, timeZone);
  }
  const next = s.state === "active" && s.nextRunAt ? `, next ${fullTime(s.nextRunAt, timeZone)}` : "";
  const waiting = s.pending ? ", a run is waiting for the thread" : "";
  return { title: s.name, time: at, line, tooltip: `${s.name}: ${s.describe}${next}${waiting} (${whereText(s)})` };
}

export type RowTarget = { botId: string; threadId: string } | null;

/** The thread a row opens: its target thread, else its latest run's, else none. */
export function rowTarget(s: Pick<ScheduleView, "where" | "history">): RowTarget {
  if (s.where.kind === "thread") return { botId: s.where.botId, threadId: s.where.threadId };
  const runs = s.history ?? [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.threadId && r.botId) return { botId: r.botId, threadId: r.threadId };
  }
  return null;
}

/** The thread a recent run opens. */
export function runTarget(run: RecentRun["run"]): RowTarget {
  return run.threadId && run.botId ? { botId: run.botId, threadId: run.threadId } : null;
}

/** A run's glyph: ✓ done, ✕ failed, ■ stopped, ↷ skipped, ⌀ missed, … running. */
export function runGlyph(run: ScheduleRun): { glyph: string; kind: "ok" | "failed" | "muted" | "running" } {
  switch (run.outcome) {
    case "started":
      if (!run.turnOutcome) return { glyph: "…", kind: "running" };
      if (run.turnOutcome === "done") return { glyph: "✓", kind: "ok" };
      if (run.turnOutcome === "failed") return { glyph: "✕", kind: "failed" };
      return { glyph: "■", kind: "muted" };
    case "failed-to-start":
      return { glyph: "✕", kind: "failed" };
    case "skipped-busy":
      return { glyph: "↷", kind: "muted" };
    default:
      return { glyph: "⌀", kind: "muted" };
  }
}

/** How long ago: "now", "5m", "2h". */
export function agoText(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** A recent run's row. */
export function recentText(r: RecentRun, now: number = Date.now(), timeZone?: string): { title: string; time: string; tooltip: string } {
  return {
    title: r.schedule.name,
    time: agoText(r.run.at, now),
    tooltip: `${r.schedule.name}: ${runText(r.run)}, ${fullTime(r.run.at, timeZone)}`,
  };
}

/** The empty dock's words. */
export const DOCK_EMPTY = "No schedules yet.";
export const DOCK_HINT = 'Or ask Jarvis: "every weekday at 9, check my open PRs".';
