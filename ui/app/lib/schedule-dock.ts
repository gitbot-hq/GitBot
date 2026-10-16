// What the Scheduled dock at the bottom of the bots rail shows, as plain
// functions of GET /schedules (its view fields), so the groups, order and
// words are tested without a browser. No model or effort: a schedule has none.

import type { ScheduleRun, ScheduleView } from "./gitbot";
import { fullTime, runText, scheduleActions, shortTime } from "./schedules";
import { isReadableWhen } from "./schedule-when";

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

/** Newest attention first. */
function attentionOf(list: readonly ScheduleView[]): ScheduleView[] {
  return list.filter((s) => s.attention).sort((a, b) => time(b.attention!.at) - time(a.attention!.at));
}

/** Active and not needing attention: a waiting fire first, then the soonest next run. */
function activeOf(list: readonly ScheduleView[]): ScheduleView[] {
  return list
    .filter((s) => s.state === "active" && !s.attention)
    .sort((a, b) => {
      if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
      if (a.pending && b.pending) return time(a.pending.dueAt) - time(b.pending.dueAt);
      const an = time(a.nextRunAt);
      const bn = time(b.nextRunAt);
      if (Number.isNaN(an) !== Number.isNaN(bn)) return Number.isNaN(an) ? 1 : -1;
      return (an || 0) - (bn || 0);
    });
}

export function dockGroups(list: readonly ScheduleView[], now: number = Date.now()): DockGroups {
  const attention = attentionOf(list);
  const active = activeOf(list);
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

/** "1 schedule needs attention", "3 schedules need attention"; null for none. */
export function scheduleAttentionText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 schedule needs attention" : `${count} schedules need attention`;
}

/** The dock header's chip: the count, danger if any failed, else honey. */
export function attentionLabel(counts: { paused: number; failed: number }): { count: number; tone: "danger" | "honey"; text: string } | null {
  const count = counts.paused + counts.failed;
  if (count <= 0) return null;
  return { count, tone: counts.failed > 0 ? "danger" : "honey", text: scheduleAttentionText(count)! };
}

export function attentionCounts(list: readonly Pick<ScheduleView, "attention">[]): { paused: number; failed: number } {
  let paused = 0;
  let failed = 0;
  for (const s of list) {
    if (s.attention?.kind === "failed") failed++;
    else if (s.attention) paused++;
  }
  return { paused, failed };
}

/**
 * One attention item: the schedule, what kind and since when. A schedule that
 * needs attention again later (paused anew, another failed run) is a new one.
 */
export function attentionKeys(list: readonly Pick<ScheduleView, "id" | "attention">[]): string[] {
  return list.filter((s) => s.attention).map((s) => `${s.id}:${s.attention!.kind}:${s.attention!.at}`);
}

/** The keys in `current` not in `seen`. */
export function newAttentionIds(current: readonly string[], seen: ReadonlySet<string>): string[] {
  return current.filter((k) => !seen.has(k));
}

export type RowMenuItem = { action: "run" | "pause" | "resume" | "edit" | "open"; label: string };

/** A dock row's ⋯ menu. A once's Run now runs it now and keeps its own time. */
export function rowMenuItems(s: ScheduleView, timeZone?: string, now: number = Date.now()): RowMenuItem[] {
  const can = scheduleActions(s);
  const items: RowMenuItem[] = [];
  if (can.runNow) {
    const at = s.when.kind === "once" ? shortTime(s.when.at, now, timeZone) : "";
    items.push({ action: "run", label: at ? `Run now (keeps ${at})` : "Run now" });
  }
  if (can.pause) items.push({ action: "pause", label: "Pause" });
  if (can.resume) items.push({ action: "resume", label: "Resume" });
  if (s.state !== "ended" && isReadableWhen(s.when)) items.push({ action: "edit", label: "Edit" });
  if (rowTarget(s)) items.push({ action: "open", label: "Open thread" });
  return items;
}

/** The Schedules view's groups: every schedule, in exactly one. */
export type ViewGroups = {
  /** As the dock's Needs attention: newest first. */
  attention: ScheduleView[];
  /** As the dock's Up next, uncapped. */
  active: ScheduleView[];
  /** Paused by the user: most recently changed first. */
  paused: ScheduleView[];
  /** Will never fire again: most recently changed first. Shown collapsed. */
  ended: ScheduleView[];
};

export function viewGroups(list: readonly ScheduleView[]): ViewGroups {
  const recentFirst = (a: ScheduleView, b: ScheduleView) => time(b.updatedAt) - time(a.updatedAt);
  return {
    attention: attentionOf(list),
    active: activeOf(list),
    paused: list.filter((s) => s.state === "paused" && !s.attention).sort(recentFirst),
    ended: list.filter((s) => s.state === "ended" && !s.attention).sort(recentFirst),
  };
}

/** The collapsed Ended group's toggle. */
export function endedText(count: number): string {
  return `${count} ended`;
}

/** What a deep link asks for: `?schedules` (the view) or `?schedule=<id>` (one card in it). */
export type ScheduleLink = { scheduleId?: string };

/** The Schedules view a URL's query opens, or null. */
export function scheduleLinkOf(search: string): ScheduleLink | null {
  const params = new URLSearchParams(search);
  const id = params.get("schedule");
  if (id) return { scheduleId: id };
  if (params.has("schedules") || params.has("schedule")) return {};
  return null;
}

/** The toast for a deep link to a schedule that is not in the list. */
export const SCHEDULE_GONE = "That schedule no longer exists";
