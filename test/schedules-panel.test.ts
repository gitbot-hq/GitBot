import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import type { Schedule, ScheduleView, ThreadFull } from "../ui/app/lib/gitbot";
import {
  cardWhere,
  createdByText,
  madeBy,
  nextRunsText,
  OWN_WORDS_HINT,
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

test("card shows nextRuns and a where link", () => {
  const v = (extra: Partial<ScheduleView> = {}): ScheduleView => ({
    ...schedule(),
    state: "active",
    canResume: false,
    where: { kind: "thread", threadId: "w", title: "Fix CI", botId: "builtin-claude-code", botName: "Claude Code", jarvis: false },
    ownWords: false,
    nextRuns: ["2026-10-17T08:00:00.000Z", "2026-10-18T08:00:00.000Z", "2026-10-19T08:00:00.000Z"],
    describe: `every day at 09:00 ${TZ}`,
    ...extra,
  });
  // The next 3 runs, in the viewer's zone; none once it won't fire.
  assert.equal(nextRunsText(v(), NOW, TZ), "Sat 09:00 · Sun 09:00 · Mon 09:00");
  assert.equal(nextRunsText(v({ state: "paused" }), NOW, TZ), null);
  assert.equal(nextRunsText(v({ nextRuns: [] }), NOW, TZ), null);

  // Where: a link to its thread, except in that thread's own panel.
  assert.deepEqual(cardWhere(v()), {
    lead: "runs on",
    title: "Fix CI",
    tail: "Claude Code",
    link: { botId: "builtin-claude-code", threadId: "w" },
  });
  assert.equal(cardWhere(v(), "w"), null);
  assert.deepEqual(cardWhere(v({ where: { kind: "new-thread", botId: "b", botName: "Claude Code", projectId: "p-1", projectName: "demo" } })), {
    lead: "a new thread each run in demo · Claude Code",
  });
  assert.deepEqual(cardWhere(v({ where: { kind: "missing" } })), { lead: "its target is gone" });

  // Made by: Jarvis in a linked thread, in this one, or you.
  const jarvis = v({ createdBy: { kind: "jarvis", threadId: "j" }, createdIn: { threadId: "j", title: "Plans", botId: "builtin-jarvis" } });
  assert.deepEqual(madeBy(jarvis), { lead: "Made by Jarvis in", title: "Plans", link: { botId: "builtin-jarvis", threadId: "j" } });
  assert.deepEqual(madeBy(jarvis, "j"), { lead: "Made by Jarvis in this thread" });
  assert.deepEqual(madeBy(v({ createdBy: { kind: "jarvis", threadId: "gone" } })), { lead: "Made by Jarvis (its thread is gone)" });
  assert.deepEqual(madeBy(v()), { lead: "Made by you (127.0.0.1)" });
  assert.deepEqual(madeBy(v({ createdBy: { kind: "user" } })), { lead: "Made by you" });
  assert.equal(OWN_WORDS_HINT, "Jarvis acts on this as your request");

  // The card is shared: the panel and the view draw it, and neither says model or effort.
  const dir = join(__dirname, "..", "ui", "app", "components");
  const card = readFileSync(join(dir, "schedule-card.tsx"), "utf-8");
  const panel = readFileSync(join(dir, "schedules-panel.tsx"), "utf-8");
  const view = readFileSync(join(dir, "schedules-view.tsx"), "utf-8");
  assert.match(panel, /<ScheduleCard/);
  assert.match(view, /<ScheduleCard/);
  assert.match(card, /schedule\.nextRuns|nextRunsText\(s\)/);
  for (const text of [card, view]) {
    const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /\bmodel\b|\beffort\b/i);
  }
  // Delete asks first, in the card, not with confirm().
  assert.doesNotMatch(card, /\bconfirm\(/);
  assert.match(card, /setConfirming\(true\)/);
});

test("the Schedules view owns Escape over a running chat, and finds its own card", () => {
  const dir = join(__dirname, "..", "ui", "app", "components");
  const view = readFileSync(join(dir, "schedules-view.tsx"), "utf-8");
  const card = readFileSync(join(dir, "schedule-card.tsx"), "utf-8");
  const chat = readFileSync(join(dir, "chat.tsx"), "utf-8");
  const shell = readFileSync(join(dir, "app-shell.tsx"), "utf-8");
  // B1: caught on window in the capture phase and stopped, whatever ran before.
  assert.match(view, /window\.addEventListener\("keydown", escape, true\)/);
  assert.match(view, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(view, /defaultPrevented/);
  // ...and the chat's stop-on-Escape is off while anything covers it.
  assert.match(chat, /if \(!streaming \|\| activeMenu \|\| setup \|\| covered\)/);
  assert.match(shell, /<Chat\s+thread=\{activeThread\}\s+covered=\{chatCovered\}/);
  // B2: no DOM id on a card (the thread's panel draws the same one); the
  // deep link looks the card up inside the view.
  assert.doesNotMatch(card, /\sid=\{/);
  assert.match(card, /data-schedule-id=\{s\.id\}/);
  assert.match(view, /root\?\.querySelector<HTMLElement>\(`\[data-schedule-id=/);
  assert.match(view, /centreCard\(rootRef\.current, s\.id\)/);
  assert.doesNotMatch(view, /document\.getElementById/);
  // The deep link scrolls only the view's own scroller: scrollIntoView also
  // scrolled the tray mid-slide (browser 04), and closing resets the tray.
  assert.doesNotMatch(view, /\.scrollIntoView\(/);
  assert.match(view, /scroller\.scrollTop \+=/);
  assert.match(shell, /tray\.scrollTop = 0/);
});
