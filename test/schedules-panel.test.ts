import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import type { Schedule, ThreadFull } from "../ui/app/lib/gitbot";
import {
  createdByText,
  durationText,
  fullTime,
  lastRuns,
  NOTIFY_OPTIONS,
  panelLabel,
  runText,
  scheduleActions,
  scheduleState,
  shortTime,
  statusText,
  targetText,
  threadBadge,
} from "../ui/app/lib/schedules";

// The schedules panel (schedules-panel.tsx) and the thread row's clock badge
// draw what these say. Times are read in a fixed zone, so the words are the
// same on any machine.

const TZ = "Europe/London";
// Fri 16 Oct 2026, 10:00 in London (BST, UTC+1).
const NOW = Date.parse("2026-10-16T09:00:00Z");

function schedule(extra: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Morning",
    prompt: "Check the build",
    when: { kind: "cron", expr: "0 9 * * *", tz: TZ },
    target: { kind: "thread", threadId: "w" },
    createdBy: { kind: "user", remote: "::ffff:127.0.0.1" },
    enabled: true,
    overlap: "queue",
    notify: "always",
    runCount: 0,
    consecutiveFailures: 0,
    nextRunAt: "2026-10-17T08:00:00.000Z",
    history: [],
    createdAt: "2026-10-16T08:00:00Z",
    updatedAt: "2026-10-16T08:00:00Z",
    describe: `every day at 09:00 ${TZ}`,
    ...extra,
  };
}

test("schedules panel renders runs, pause/resume, run now, delete and notify", () => {
  // Active: next run, who made it, and every action but Resume.
  const s = schedule();
  assert.equal(scheduleState(s), "active");
  assert.equal(statusText(s, NOW, TZ), "Next run Sat 09:00");
  assert.equal(createdByText(s), "created by you (127.0.0.1)");
  assert.deepEqual(scheduleActions(s), { pause: true, resume: false, runNow: true, notify: true, delete: true });
  assert.deepEqual(NOTIFY_OPTIONS.map((o) => o.value), ["always", "on-failure", "never"]);
  assert.equal(targetText(s, "w"), null, "runs here: nothing to say");
  assert.equal(panelLabel(1), "1 schedule");
  assert.equal(panelLabel(3), "3 schedules");

  // Paused: the reason, Resume instead of Pause.
  const paused = schedule({ enabled: false, nextRunAt: null, pausedReason: "paused after 3 failed runs: no such folder" });
  assert.equal(scheduleState(paused), "paused");
  assert.equal(statusText(paused, NOW, TZ), "Paused: paused after 3 failed runs: no such folder");
  assert.deepEqual(scheduleActions(paused), { pause: false, resume: true, runNow: true, notify: true, delete: true });

  // Ended: only Delete.
  const ended = schedule({ enabled: false, nextRunAt: null });
  assert.equal(scheduleState(ended), "ended");
  assert.equal(statusText(ended, NOW, TZ), "Ended");
  assert.deepEqual(scheduleActions(ended), { pause: false, resume: false, runNow: false, notify: false, delete: true });

  // A pending fire waits for the thread.
  const waiting = schedule({ pending: { dueAt: "2026-10-16T08:59:00Z", manual: true } });
  assert.equal(statusText(waiting, NOW, TZ), "Next run Sat 09:00 · a run is waiting for the thread");
  assert.equal(statusText({ ...waiting, enabled: false, nextRunAt: null }, NOW, TZ), "Ended · a run is waiting for the thread");

  // Runs: newest first, with outcome, lateness and missed counts.
  const runs = schedule({
    history: [
      { at: "2026-10-15T08:00:00Z", outcome: "missed", missedCount: 3 },
      { at: "2026-10-15T09:00:00Z", outcome: "started", threadId: "t1", turnOutcome: "done", delayedMs: 125_000 },
      { at: "2026-10-16T08:00:00Z", outcome: "skipped-busy", threadId: "w" },
      { at: "2026-10-16T08:30:00Z", outcome: "failed-to-start", error: "thread not found" },
      { at: "2026-10-16T08:55:00Z", outcome: "started", threadId: "t2" },
    ],
  });
  assert.deepEqual(lastRuns(runs).map(runText), [
    "started · running",
    "failed to start: thread not found",
    "skipped: thread busy",
    "started · done · 2m late",
    "missed 3 runs",
  ]);
  assert.equal(lastRuns(runs, 2).length, 2);
  assert.equal(runText({ at: "x", outcome: "missed" }), "missed 1 run");
  assert.equal(runText({ at: "x", outcome: "started", turnOutcome: "failed", delayedMs: 400 }), "started · failed", "under a second isn't late");
  assert.equal(durationText(45_000), "45s");
  assert.equal(durationText(3_725_000), "1h 2m");

  // On a Jarvis thread: its schedules elsewhere say where they run.
  const fresh = schedule({ target: { kind: "new-thread", botId: "builtin-claude-code", projectId: "p-1" }, createdBy: { kind: "jarvis", threadId: "j" }, notesTo: "j", notesHere: true });
  assert.equal(targetText(fresh, "j"), "a new thread each run");
  assert.equal(targetText(schedule({ notesHere: true }), "j"), "runs on another thread");
  assert.equal(createdByText(fresh), "created by Jarvis");
  assert.equal(createdByText(schedule({ createdBy: { kind: "user" } })), "created by you");

  // Times: today, this week, later, and in full.
  assert.equal(shortTime("2026-10-16T13:30:00Z", NOW, TZ), "14:30");
  assert.equal(shortTime("2026-10-19T08:00:00Z", NOW, TZ), "Mon 09:00");
  assert.equal(shortTime("2026-11-02T09:00:00Z", NOW, TZ), "2 Nov 09:00");
  assert.equal(shortTime("2027-01-05T09:00:00Z", NOW, TZ), "5 Jan 2027 09:00");
  assert.equal(fullTime("2026-10-17T08:00:00Z", TZ), "Sat 17 Oct 2026, 09:00");
});

test("schedules panel renders nothing with no schedules, and never a model or effort", () => {
  const src = readFileSync(join(__dirname, "..", "ui", "app", "components", "schedules-panel.tsx"), "utf-8");
  // The component bails out before drawing anything when the list is empty.
  assert.match(src, /if \(schedules\.length === 0\) return null;/);
  // Nothing in it, or in what it draws from, speaks of a model or effort.
  const lib = readFileSync(join(__dirname, "..", "ui", "app", "lib", "schedules.ts"), "utf-8");
  for (const text of [src, lib]) {
    const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /\bmodel\b|\beffort\b/i);
  }
  // The panel mounts for every open thread but the setup one, next to JarvisChildren.
  const shell = readFileSync(join(__dirname, "..", "ui", "app", "components", "app-shell.tsx"), "utf-8");
  assert.match(shell, /\{isJarvis && activeThread && \(\s*<JarvisChildren/);
  assert.match(shell, /\{activeThread && activeThread\.kind !== "setup" && !setupRequired && \(\s*<SchedulesPanel/);
});

test("thread row shows the clock badge with the next run", () => {
  const row = (schedule?: ThreadFull["schedule"]) => ({ schedule });
  assert.equal(threadBadge(row(), NOW, TZ), null, "no schedules, no badge");
  assert.equal(threadBadge(row({ count: 0, nextRunAt: null }), NOW, TZ), null);
  assert.deepEqual(threadBadge(row({ count: 1, nextRunAt: "2026-10-16T16:00:00Z" }), NOW, TZ), {
    label: "17:00",
    title: "1 schedule, next run Fri 16 Oct 2026, 17:00",
  });
  assert.deepEqual(threadBadge(row({ count: 2, nextRunAt: "2026-10-17T08:00:00Z" }), NOW, TZ), {
    label: "Sat 09:00",
    title: "2 schedules, next run Sat 17 Oct 2026, 09:00",
  });
  // Enabled but holding only a waiting fire: the clock, no time.
  assert.deepEqual(threadBadge(row({ count: 1, nextRunAt: null }), NOW, TZ), { label: "", title: "1 schedule, waiting for this thread" });

  // A narrow row (the desktop column) shows the clock alone, so the title
  // keeps its room; the time shows only on a row 260px or wider (the mobile
  // drawer). The full time is always in the tooltip.
  const css = readFileSync(join(__dirname, "..", "ui", "app", "globals.css"), "utf-8");
  assert.match(css, /\.page-body \.threads-list div\.thread-row \{\s*container-type: inline-size;\s*\}/);
  assert.match(css, /\.thread-schedule-badge-time \{\s*display: none;\s*\}/);
  assert.match(css, /@container \(min-width: 260px\) \{\s*\.thread-schedule-badge-time \{\s*display: inline;/);
  const shell = readFileSync(join(__dirname, "..", "ui", "app", "components", "app-shell.tsx"), "utf-8");
  assert.match(shell, /title=\{badge\.title\} aria-label=\{badge\.title\}/);
  assert.match(shell, /<span className="thread-schedule-badge-time">\{badge\.label\}<\/span>/);
});

test("the server's state wins: a paused schedule that can't resume is Ended, with Delete only", () => {
  const dead = { ...schedule({ enabled: false, pausedReason: "paused by the user", nextRunAt: null }), state: "ended" as const, canResume: false };
  assert.equal(scheduleState(dead), "ended");
  assert.equal(statusText(dead, NOW, TZ), "Ended");
  assert.deepEqual(scheduleActions(dead), { pause: false, resume: false, runNow: false, notify: false, delete: true });
});
