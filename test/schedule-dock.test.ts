import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import type { ScheduleView } from "../ui/app/lib/gitbot";
import { nextSchedulesHint } from "../ui/app/lib/use-thread-sessions";
import {
  attentionCounts,
  attentionKeys,
  attentionLabel,
  dockGroups,
  newAttentionIds,
  recentText,
  rowMenuItems,
  rowTarget,
  rowText,
  runGlyph,
  scheduleAttentionText,
  scheduleLinkOf,
  endedText,
  UP_NEXT_MAX,
  viewGroups,
} from "../ui/app/lib/schedule-dock";

// The Scheduled dock (scheduled-dock.tsx) draws what these say.

const TZ = "Europe/London";
const NOW = Date.parse("2026-10-16T09:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

let n = 0;
function view(extra: Partial<ScheduleView> = {}): ScheduleView {
  n += 1;
  return {
    id: `s${n}`,
    name: `S${n}`,
    prompt: "x",
    when: { kind: "interval", everyMinutes: 60, anchor: at(0) },
    target: { kind: "thread", threadId: "w" },
    createdBy: { kind: "user" },
    enabled: true,
    overlap: "queue",
    notify: "always",
    runCount: 0,
    consecutiveFailures: 0,
    nextRunAt: at(3_600_000),
    history: [],
    createdAt: at(-86_400_000),
    updatedAt: at(-86_400_000),
    describe: "every hour",
    state: "active",
    canResume: false,
    where: { kind: "thread", threadId: "w", title: "Fix CI", botId: "builtin-claude-code", botName: "Claude Code", jarvis: false },
    ownWords: false,
    nextRuns: [],
    ...extra,
  };
}

test("dockGroups sorts attention, up next (pending first) and recent", () => {
  const late = view({ name: "Late", nextRunAt: at(7_200_000) });
  const soon = view({ name: "Soon", nextRunAt: at(600_000) });
  const waiting = view({ name: "Waiting", nextRunAt: at(9_000_000), pending: { dueAt: at(-60_000) } });
  const oldBad = view({ name: "OldBad", attention: { kind: "failed", text: "Last run failed", at: at(-7_200_000) } });
  const newBad = view({
    name: "NewBad",
    enabled: false,
    state: "paused",
    pausedReason: "paused after 3 failed runs",
    attention: { kind: "paused", text: "Paused: paused after 3 failed runs", at: at(-60_000) },
  });
  const ran = view({
    name: "Ran",
    history: [
      { at: at(-2 * 86_400_000), outcome: "started", threadId: "a", turnOutcome: "done", botId: "b1" },
      { at: at(-3_600_000), outcome: "started", threadId: "a", turnOutcome: "done", botId: "b1" },
      { at: at(-60_000), outcome: "started", threadId: "c", turnOutcome: "failed", botId: "b2" },
    ],
  });
  const g = dockGroups([late, soon, oldBad, waiting, newBad, ran], NOW);
  assert.deepEqual(g.attention.map((s) => s.name), ["NewBad", "OldBad"]);
  assert.deepEqual(g.upNext.map((s) => s.name), ["Waiting", "Soon", "Ran", "Late"]);
  assert.deepEqual(g.recent.map((r) => r.run.threadId), ["c", "a"], "newest first, last 24 h only");
  assert.equal(recentText(g.recent[0], NOW, TZ).time, "1m");
  assert.equal(runGlyph(g.recent[0].run).glyph, "✕");
  assert.equal(runGlyph(g.recent[1].run).glyph, "✓");

  assert.equal(rowText(soon, NOW, TZ).time, "10:10");
  assert.equal(rowText(soon, NOW, TZ).line, "Fix CI · Claude Code");
  assert.equal(rowText(waiting, NOW, TZ).time, "waiting");
  assert.equal(rowText(oldBad, NOW, TZ).line, "Last run failed · 08:00");
  assert.equal(rowText(newBad, NOW, TZ).line, "Paused: paused after 3 failed runs");
  assert.match(rowText(soon, NOW, TZ).tooltip, /every hour/);
});

test("up next caps at 5 with a more count; paused and ended are counted, not listed", () => {
  const active = Array.from({ length: UP_NEXT_MAX + 2 }, (_, i) => view({ nextRunAt: at((i + 1) * 60_000) }));
  const paused = view({ enabled: false, state: "paused", pausedReason: "paused by the user", canResume: true, nextRunAt: null });
  const ended = view({ enabled: false, state: "ended", nextRunAt: null });
  const g = dockGroups([...active, paused, ended], NOW);
  assert.equal(g.upNext.length, UP_NEXT_MAX);
  assert.equal(g.more, 2);
  assert.equal(g.pausedCount, 1);
  assert.equal(g.endedCount, 1);
  assert.ok(!g.upNext.includes(paused) && !g.upNext.includes(ended));
  assert.deepEqual(dockGroups([], NOW), { attention: [], upNext: [], more: 0, recent: [], pausedCount: 0, endedCount: 0 });
});

test("rowTarget: thread target, run thread, none for an unrun new-thread schedule", () => {
  assert.deepEqual(rowTarget(view()), { botId: "builtin-claude-code", threadId: "w" });
  const fresh = { kind: "new-thread" as const, botId: "b", botName: "Bot", projectId: "p", projectName: "demo" };
  assert.equal(rowTarget(view({ target: { kind: "new-thread", botId: "b", projectId: "p" }, where: fresh })), null);
  const ran = view({
    target: { kind: "new-thread", botId: "b", projectId: "p" },
    where: fresh,
    history: [
      { at: at(-7_200_000), outcome: "started", threadId: "t1", botId: "b" },
      { at: at(-3_600_000), outcome: "started", threadId: "t2", botId: "b" },
      { at: at(-60_000), outcome: "missed" },
    ],
  });
  assert.deepEqual(rowTarget(ran), { botId: "b", threadId: "t2" });
  assert.equal(rowText(ran, NOW, TZ).line, "new thread in demo · Bot");
});

test("dock has no model or effort words", () => {
  const ui = join(__dirname, "..", "ui", "app");
  for (const file of [join(ui, "components", "scheduled-dock.tsx"), join(ui, "lib", "schedule-dock.ts")]) {
    const code = readFileSync(file, "utf-8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /\bmodel\b|\beffort\b/i, file);
  }
  // Mounted in the bots rail, after its scroll region.
  const shell = readFileSync(join(ui, "components", "app-shell.tsx"), "utf-8");
  assert.match(shell, /side-scroll-edge-bottom[\s\S]*?<ScheduledDock[\s\S]*?className="side-handle"/);
});

test("schedules hint: the first event on a connection records, a new version or a reconnect bumps", () => {
  let r = nextSchedulesHint(null, null, { version: 7, attentionCount: 1 });
  assert.deepEqual(r, { hint: { version: 0, attentionCount: 1 }, seen: 7 });
  r = nextSchedulesHint(r.hint, r.seen, { version: 7, attentionCount: 1 });
  assert.equal(r.hint.version, 0, "same server version: no bump");
  r = nextSchedulesHint(r.hint, r.seen, { version: 9, attentionCount: 0 });
  assert.deepEqual(r.hint, { version: 1, attentionCount: 0 });
  // The server restarts (its version resets): the reconnect bumps, its connect event records.
  r = nextSchedulesHint(r.hint, r.seen, null);
  assert.deepEqual(r, { hint: { version: 2, attentionCount: 0 }, seen: null });
  r = nextSchedulesHint(r.hint, r.seen, { version: 0, attentionCount: 0 });
  assert.equal(r.hint.version, 2);
});

test("attentionLabel combines paused and failed counts", () => {
  assert.equal(attentionLabel({ paused: 0, failed: 0 }), null);
  assert.deepEqual(attentionLabel({ paused: 1, failed: 0 }), { count: 1, tone: "honey", text: "1 schedule needs attention" });
  assert.deepEqual(attentionLabel({ paused: 2, failed: 1 }), { count: 3, tone: "danger", text: "3 schedules need attention" });
  const list = [
    view({ attention: { kind: "paused", text: "Paused: x", at: at(0) } }),
    view({ attention: { kind: "failed", text: "Last run failed", at: at(0) } }),
    view(),
  ];
  assert.deepEqual(attentionCounts(list), { paused: 1, failed: 1 });
  assert.equal(scheduleAttentionText(0), null);
});

test("newAttentionIds reports only ids not seen before", () => {
  const a = view({ attention: { kind: "paused", text: "Paused: x", at: at(0) } });
  const b = view({ attention: { kind: "failed", text: "Last run failed", at: at(0) } });
  const keys = attentionKeys([a, b, view()]);
  assert.equal(keys.length, 2);
  assert.deepEqual(newAttentionIds(keys, new Set()), keys);
  assert.deepEqual(newAttentionIds(keys, new Set([keys[0]])), [keys[1]]);
  assert.deepEqual(newAttentionIds(keys, new Set(keys)), []);
  // The same schedule needing attention again later is a new item.
  const again = attentionKeys([{ ...a, attention: { ...a.attention!, at: at(60_000) } }]);
  assert.deepEqual(newAttentionIds(again, new Set(keys)), again);
});

test("row menu items: once shows keeps-time label, ended shows no resume", () => {
  const actions = (s: ScheduleView) => rowMenuItems(s, TZ, NOW).map((i) => i.action);
  assert.deepEqual(actions(view()), ["run", "pause", "open"]);
  const once = view({ when: { kind: "once", at: at(3_600_000) } });
  assert.equal(rowMenuItems(once, TZ, NOW)[0].label, "Run now (keeps 11:00)");
  assert.deepEqual(actions(view({ enabled: false, state: "paused", canResume: true })), ["run", "resume", "open"]);
  assert.deepEqual(actions(view({ enabled: false, state: "ended", canResume: false })), ["open"]);
  // An unrun new-thread schedule has no thread to open.
  const fresh = view({ target: { kind: "new-thread", botId: "b", projectId: "p" } as any, where: { kind: "new-thread", botId: "b", botName: "B", projectId: "p", projectName: "P" } });
  assert.deepEqual(actions(fresh), ["run", "pause"]);
});

test("view groups: attention, active, paused, ended with counts", () => {
  // Every schedule lands in exactly one group, each sorted as in the dock;
  // the active one is uncapped.
  const active = Array.from({ length: UP_NEXT_MAX + 2 }, (_, i) => view({ nextRunAt: at((UP_NEXT_MAX + 2 - i) * 60_000) }));
  const waiting = view({ pending: { dueAt: at(-60_000) } });
  const broken = view({
    enabled: false, state: "paused", pausedReason: "paused after 3 failed runs: gone", canResume: true, nextRunAt: null,
    attention: { kind: "paused", text: "Paused: paused after 3 failed runs: gone", at: at(-600_000) },
  });
  const failed = view({ attention: { kind: "failed", text: "Last run failed", at: at(-60_000) } });
  const oldPause = view({ enabled: false, state: "paused", pausedReason: "paused by the user", canResume: true, nextRunAt: null, updatedAt: at(-7_200_000) });
  const newPause = view({ enabled: false, state: "paused", pausedReason: "paused by the user", canResume: true, nextRunAt: null, updatedAt: at(-60_000) });
  const ended = view({ enabled: false, state: "ended", nextRunAt: null });
  const g = viewGroups([...active, waiting, broken, failed, oldPause, newPause, ended]);
  assert.deepEqual(g.attention, [failed, broken], "newest attention first");
  assert.equal(g.active.length, UP_NEXT_MAX + 3, "uncapped");
  assert.equal(g.active[0], waiting, "a waiting fire first");
  assert.deepEqual(g.active.slice(1), [...active].reverse(), "then the soonest next run");
  assert.deepEqual(g.paused, [newPause, oldPause], "most recently paused first");
  assert.deepEqual(g.ended, [ended]);
  assert.equal(endedText(g.ended.length), "1 ended");
  const total = g.attention.length + g.active.length + g.paused.length + g.ended.length;
  assert.equal(total, active.length + 6);
  assert.deepEqual(viewGroups([]), { attention: [], active: [], paused: [], ended: [] });
});

test("deep links: ?schedules opens the view, ?schedule=<id> one card", () => {
  assert.deepEqual(scheduleLinkOf("?schedules"), {});
  assert.deepEqual(scheduleLinkOf("?schedule=s-abc"), { scheduleId: "s-abc" });
  assert.deepEqual(scheduleLinkOf("?schedule="), {}, "an empty id still opens the view");
  assert.equal(scheduleLinkOf("?thread=t1&bot=b"), null);
  assert.equal(scheduleLinkOf(""), null);
});

test("the dock links paused, more and unrun new-thread rows to the Schedules view", () => {
  const src = readFileSync(join(__dirname, "..", "ui", "app", "components", "scheduled-dock.tsx"), "utf-8");
  assert.match(src, /target \? go\(target\) : onShowAll\(s\.id\)/);
  assert.match(src, /See all schedules →/);
  assert.match(src, /\{groups\.pausedCount\} paused/);
});
