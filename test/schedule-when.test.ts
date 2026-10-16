import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { askJarvisDraft, fromWhen, pickerGroups, suggestName, tomorrowAt, toWhen, zonedToIso } from "../ui/app/lib/schedule-when";

const NOW = Date.UTC(2026, 9, 16, 12, 0); // Fri 16 Oct 2026, 12:00Z

test("toWhen: in, once, daily, weekdays, weekly, monthly, every hours/minutes, cron", () => {
  const tz = "Europe/London";
  assert.deepEqual(toWhen({ preset: "in", minutes: 15 }, tz, NOW), { kind: "once", at: "2026-10-16T12:15:00.000Z" });
  // BST (+01:00) in October.
  assert.deepEqual(toWhen({ preset: "once", localDateTime: "2026-10-20T09:00" }, tz, NOW), { kind: "once", at: "2026-10-20T08:00:00.000Z" });
  assert.deepEqual(toWhen({ preset: "daily", time: "09:00" }, tz, NOW), { kind: "cron", expr: "0 9 * * *", tz });
  assert.deepEqual(toWhen({ preset: "weekdays", time: "09:30" }, tz, NOW), { kind: "cron", expr: "30 9 * * 1-5", tz });
  assert.deepEqual(toWhen({ preset: "weekly", days: [5, 1, 1], time: "18:05" }, tz, NOW), { kind: "cron", expr: "5 18 * * 1,5", tz });
  assert.equal(toWhen({ preset: "weekly", days: [], time: "18:05" }, tz, NOW), null);
  assert.deepEqual(toWhen({ preset: "monthly", day: 1, time: "00:00" }, tz, NOW), { kind: "cron", expr: "0 0 1 * *", tz });
  assert.deepEqual(toWhen({ preset: "every", amount: 2, unit: "hours" }, tz, NOW), { kind: "interval", everyMinutes: 120 });
  assert.deepEqual(toWhen({ preset: "every", amount: 1, unit: "minutes" }, tz, NOW), { kind: "interval", everyMinutes: 1 });
  assert.deepEqual(toWhen({ preset: "cron", expr: " 0 9 * * * * " }, tz, NOW), { kind: "cron", expr: "0 9 * * * *", tz });
  assert.equal(toWhen({ preset: "cron", expr: "  " }, tz, NOW), null);
  assert.equal(toWhen({ preset: "daily", time: "" }, tz, NOW), null);
  assert.equal(tomorrowAt("09:00", tz, NOW), "2026-10-17T09:00");
  // Late evening in New York is already tomorrow in UTC.
  assert.equal(tomorrowAt("09:00", "America/New_York", Date.UTC(2026, 9, 17, 2, 0)), "2026-10-17T09:00");
});

test("toWhen once uses the given zone (DST day)", () => {
  // New York springs forward at 02:00 on 8 Mar 2026: -05:00 before, -04:00 after.
  const ny = "America/New_York";
  assert.deepEqual(toWhen({ preset: "once", localDateTime: "2026-03-08T01:30" }, ny, NOW), { kind: "once", at: "2026-03-08T06:30:00.000Z" });
  assert.deepEqual(toWhen({ preset: "once", localDateTime: "2026-03-08T09:00" }, ny, NOW), { kind: "once", at: "2026-03-08T13:00:00.000Z" });
  assert.equal(toWhen({ preset: "once", localDateTime: "2026-03-08T02:30" }, ny, NOW), null, "skipped by the clocks");
  // The same wall time in another zone is another instant.
  assert.deepEqual(toWhen({ preset: "once", localDateTime: "2026-03-08T09:00" }, "Asia/Kolkata", NOW), { kind: "once", at: "2026-03-08T03:30:00.000Z" });
  // London falls back at 02:00 BST on 25 Oct 2026: 01:30 happens twice, the first is BST.
  assert.equal(zonedToIso("2026-10-25T01:30", "Europe/London"), "2026-10-25T00:30:00.000Z");
  assert.equal(zonedToIso("2026-02-30T10:00", "UTC"), null);
  assert.equal(zonedToIso("soon", "UTC"), null);
});

test("fromWhen maps simple crons back and falls back to cron", () => {
  const tz = "Europe/London";
  for (const choice of [
    { preset: "daily", time: "09:00" },
    { preset: "weekdays", time: "07:05" },
    { preset: "weekly", days: [0, 3], time: "18:00" },
    { preset: "monthly", day: 15, time: "23:59" },
    { preset: "every", amount: 3, unit: "hours" },
    { preset: "every", amount: 90, unit: "minutes" },
    { preset: "once", localDateTime: "2026-10-20T09:00" },
  ] as const) {
    const when = toWhen(choice as any, tz, NOW);
    assert.ok(when);
    assert.deepEqual(fromWhen(when, tz), choice);
  }
  assert.deepEqual(fromWhen({ kind: "cron", expr: "0 9 * * 7", tz }, tz), { preset: "weekly", days: [0], time: "09:00" });
  for (const expr of ["*/5 * * * *", "0 9 * 1 *", "0 9-17 * * *", "@daily", "0 9 1 * 1"]) {
    assert.deepEqual(fromWhen({ kind: "cron", expr, tz }, tz), { preset: "cron", expr });
  }
});

test("suggestName trims to 60 and strips quotes and angle brackets", () => {
  assert.equal(suggestName("check open PRs and summarise"), "check open PRs and summarise");
  assert.equal(suggestName("  Reply:   scheduled\nok  "), "Reply: scheduled ok");
  assert.equal(suggestName(`say "hi" to <b>Bob</b> it's fine, really now`), "say hi to bBob/b its fine,");
  assert.equal(suggestName("one two three four five six seven eight"), "one two three four five six");
  const long = suggestName("supercalifragilistic expialidocious antidisestablishmentarianism floccinaucinihilipilification x y");
  assert.ok(long.length <= 60, long);
  assert.equal(long, "supercalifragilistic expialidocious");
  assert.equal(suggestName("x".repeat(80)).length, 60);
  assert.equal(suggestName(""), "");
  assert.equal(askJarvisDraft("check PRs ", "every weekday at 09:00 UTC"), "Schedule this: check PRs, every weekday at 09:00 UTC");
});

test("the target picker groups by bot, newest first, and never offers a setup thread", () => {
  const threads = [
    { id: "a", botId: "b1", title: "Old", updatedAt: "2026-10-01T00:00:00Z" },
    { id: "s", botId: "b1", title: "Setup", kind: "setup", updatedAt: "2026-10-16T00:00:00Z" },
    { id: "j", botId: "builtin-jarvis", title: "Plans", lastActivityAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
    { id: "c", botId: "b1", title: "Fix CI", lastActivityAt: "2026-10-14T00:00:00Z" },
  ];
  const bots = [{ id: "b1", name: "Claude Code" }, { id: "builtin-jarvis", name: "Jarvis" }];
  const groups = pickerGroups(threads, bots, "", "builtin-jarvis");
  assert.deepEqual(groups.map((g) => [g.botName, g.jarvis, g.threads.map((t) => t.threadId)]), [
    ["Jarvis", true, ["j"]],
    ["Claude Code", false, ["c", "a"]],
  ]);
  assert.deepEqual(pickerGroups(threads, bots, "ci", "builtin-jarvis").map((g) => g.threads.map((t) => t.title)), [["Fix CI"]]);
  assert.deepEqual(pickerGroups(threads, bots, "claude", "builtin-jarvis")[0].threads.length, 2);
});

test("Enter in a form field never saves: only the Save button does", () => {
  const read = (f: string) => readFileSync(join(__dirname, "../ui/app/components", f), "utf8");
  const form = read("schedule-form.tsx");
  assert.ok(!form.includes('type="submit"'), "no submit button: Enter in Name, a time or the search can't submit");
  assert.match(form, /onSubmit=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(form, /<button type="button" className="btn-primary"[^>]*onClick=\{\(\) => ready && !saving && save\(\)\}/);
  const picker = read("thread-picker.tsx");
  assert.match(picker, /if \(e\.key !== "Enter"\) return;\s*e\.preventDefault\(\);/);
});
