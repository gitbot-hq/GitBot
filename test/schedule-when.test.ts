import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import {
  askJarvisDraft,
  diffSchedule,
  editInit,
  fromWhen,
  isReadableWhen,
  notifySuggestion,
  patchDemotes,
  pickerGroups,
  suggestName,
  tomorrowAt,
  toWhen,
  zonedToIso,
  type WhenChoice,
} from "../ui/app/lib/schedule-when";

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
  // Edit's Save and Save and resume are plain buttons too.
  assert.match(form, /<button type="button" className="btn-primary"[^>]*onClick=\{\(\) => ready && changed && !saving && saveEdit\(false\)\}/);
  assert.match(form, /<button type="button" className="btn-secondary"[^>]*onClick=\{\(\) => ready && !saving && saveEdit\(true\)\}/);
  assert.ok(!read("own-words-confirm.tsx").includes('type="submit"'));
  const picker = read("thread-picker.tsx");
  assert.match(picker, /if \(e\.key !== "Enter"\) return;\s*e\.preventDefault\(\);/);
});

const STORED = {
  name: "Morning",
  prompt: "Reply: ready",
  when: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/London" },
  notify: "always",
  overlap: "queue",
  maxRuns: 5,
  endsAt: "2026-12-01T17:00:30Z",
} as const;

test("diffSchedule sends only changed fields and null for cleared limits", () => {
  const same = { name: "Morning", prompt: "Reply: ready", notify: "always", overlap: "queue", maxRuns: 5, endsAt: STORED.endsAt } as const;
  // Nothing touched: nothing to send (a cron with other spacing is the same times).
  assert.deepEqual(diffSchedule(STORED, same), {});
  assert.deepEqual(diffSchedule(STORED, { ...same, when: { kind: "cron", expr: " 0  9 * * 1-5", tz: "Europe/London" } }), {});
  assert.deepEqual(diffSchedule(STORED, { ...same, prompt: "Reply: edited ok" }), { prompt: "Reply: edited ok" });
  assert.deepEqual(diffSchedule(STORED, { ...same, name: " Morning " }), {}, "the name is trimmed");
  assert.deepEqual(diffSchedule(STORED, { ...same, maxRuns: undefined, endsAt: undefined }), { maxRuns: null, endsAt: null });
  assert.deepEqual(diffSchedule(STORED, { ...same, maxRuns: 3, notify: "on-failure", overlap: "skip" }), { maxRuns: 3, notify: "on-failure", overlap: "skip" });
  // The same zone's cron in another zone is a change.
  assert.deepEqual(diffSchedule(STORED, { ...same, when: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" } }), { when: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" } });
  // Into a once: no limits are sent (the server drops them).
  const once = { kind: "once", at: "2026-10-20T08:00:00.000Z" } as const;
  assert.deepEqual(diffSchedule(STORED, { ...same, when: once, maxRuns: undefined, endsAt: undefined }), { when: once });
  // A once's instant compares by time, not by text.
  assert.deepEqual(diffSchedule({ ...STORED, when: { kind: "once", at: "2026-10-20T08:00:00Z" }, maxRuns: undefined, endsAt: undefined }, { ...same, when: once, maxRuns: undefined, endsAt: undefined }), {});
});

test("diffSchedule flags demoting fields for own-words", () => {
  const same = { name: "Morning", prompt: "Reply: ready", notify: "always", overlap: "queue", maxRuns: 5, endsAt: STORED.endsAt } as const;
  for (const [edit, demotes] of [
    [{ prompt: "x" }, true],
    [{ name: "Evening" }, true],
    [{ when: { kind: "interval", everyMinutes: 1 } }, true],
    [{ maxRuns: undefined }, true],
    [{ endsAt: undefined }, true],
    [{ notify: "never" }, false],
    [{ overlap: "skip" }, false],
    [{ notify: "never", overlap: "skip" }, false],
  ] as const) {
    assert.equal(patchDemotes(diffSchedule(STORED, { ...same, ...edit } as any)), demotes, JSON.stringify(edit));
  }
  // A resume alone doesn't (D3).
  assert.equal(patchDemotes({ enabled: true }), false);
  assert.equal(patchDemotes({}), false);
});

test("fromWhen round-trips every preset toWhen makes", () => {
  const tz = "America/New_York";
  const choices: WhenChoice[] = [
    { preset: "once", localDateTime: "2026-11-01T01:30" },
    { preset: "daily", time: "00:00" },
    { preset: "weekdays", time: "09:00" },
    { preset: "weekly", days: [1, 3, 5], time: "12:30" },
    { preset: "weekly", days: [0, 6], time: "08:15" },
    { preset: "monthly", day: 31, time: "06:45" },
    { preset: "every", amount: 1, unit: "minutes" },
    { preset: "every", amount: 45, unit: "minutes" },
    { preset: "every", amount: 2, unit: "hours" },
    { preset: "cron", expr: "*/7 9-17 * * 1-5" },
  ];
  for (const choice of choices) {
    const when = toWhen(choice, tz, NOW)!;
    assert.deepEqual(fromWhen(when, tz), choice, JSON.stringify(choice));
    assert.deepEqual(toWhen(fromWhen(when, tz), tz, NOW), when);
  }
  // Edit's prefill: a cron in another zone sets the form's zone to the cron's.
  const init = editInit({ when: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/London" }, endsAt: "2026-12-01T17:00:00Z" }, "Asia/Tokyo");
  assert.deepEqual(init, { choice: { preset: "weekdays", time: "09:00" }, tz: "Europe/London", endsLocal: "2026-12-01T17:00" });
  assert.equal(editInit({ when: { kind: "interval", everyMinutes: 60 } }, "Asia/Tokyo").tz, "Asia/Tokyo");
});

test("the notify suggestion shows only when the times changed and the default differs", () => {
  const p = { describe: "every minute", defaultNotify: "on-failure" } as const;
  assert.deepEqual(notifySuggestion(true, p, "always"), { text: "Suggested for every minute: only if it fails", notify: "on-failure" });
  assert.equal(notifySuggestion(true, p, "on-failure"), null);
  assert.equal(notifySuggestion(false, p, "always"), null);
  assert.equal(notifySuggestion(true, null, "always"), null);
});

test("fromWhen and editInit fall back on a when this build can't read, and it isn't readable", () => {
  const tz = "Europe/London";
  const bad = [
    { kind: "once", at: "not a time" },
    { kind: "once" },
    { kind: "cron", tz },
    { kind: "cron", expr: 42, tz },
    { kind: "cron", expr: "0 9 * * *", tz: "Not/AZone" },
    { kind: "interval", everyMinutes: "5" },
    { kind: "solar", at: "sunrise" },
    null,
  ];
  for (const when of bad) {
    assert.equal(isReadableWhen(when), false, JSON.stringify(when));
    assert.doesNotThrow(() => fromWhen(when as any, tz), JSON.stringify(when));
    assert.deepEqual(fromWhen(when as any, tz), { preset: "cron", expr: "" }, JSON.stringify(when));
    assert.doesNotThrow(() => editInit({ when: when as any, endsAt: "garbage" }, tz), JSON.stringify(when));
  }
  assert.equal(editInit({ when: { kind: "cron", expr: "0 9 * * *", tz: "Not/AZone" } }, tz).tz, tz, "an unknown zone falls back to the viewer's");
  assert.equal(editInit({ when: { kind: "interval", everyMinutes: 5 }, endsAt: "garbage" }, tz).endsLocal, "");
  for (const when of [{ kind: "once", at: "2026-10-20T08:00:00Z" }, { kind: "cron", expr: "0 9 * * 1-5", tz }, { kind: "interval", everyMinutes: 5 }]) {
    assert.equal(isReadableWhen(when), true, JSON.stringify(when));
  }
});

test("new-thread bots: Jarvis absent, a bot that needs setup disabled with why, agents last", async () => {
  const { newThreadBots, projectMatches, newThreadNote } = await import("../ui/app/lib/schedule-when");
  const list = newThreadBots([
    { id: "builtin-claude-code", name: "Claude Code", builtin: "claude-code" },
    { id: "builtin-jarvis", name: "Jarvis", builtin: "jarvis" },
    { id: "b1", name: "PR checker" },
    { id: "b2", name: "Video Cutter", setupInstructions: "install ffmpeg", setupStatus: "pending" },
    { id: "b3", name: "Done", setupInstructions: "x", setupStatus: "complete" },
  ], "builtin-jarvis");
  assert.deepEqual(list.map((b) => [b.id, b.disabled ?? null]), [["b1", null], ["b2", "needs setup"], ["b3", null], ["builtin-claude-code", null]]);
  const projects = [
    { id: "p1", name: "demo", path: "/w/demo", present: true },
    { id: "p2", name: "api", path: "/w/api", present: false },
  ];
  assert.deepEqual(projectMatches(projects, "API").map((p) => p.id), ["p2"], "a gone folder stays listed");
  assert.equal(projectMatches(projects, "").length, 2);
  assert.match(newThreadNote("Hello run", "demo"), /“Hello run · <date>” in demo\. .*auto-approves/);
});
