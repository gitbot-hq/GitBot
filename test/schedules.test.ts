// First: points the data directory at a throwaway one before bot-store loads.
import "./temp-data-dir";
import { test, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bindSession, createBot, createThread, dataDir, getThread, JARVIS_BOT_ID, jarvisDir, updateThread } from "../src/bot-store";
import { runningChildOf } from "../src/child-lock";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { watchChildReports } from "../src/reports";
import { Cron } from "croner";
import { ERROR_BACKOFF_MS, LATE_GRACE_MS, MIN_REARM_MS, RATE_CAP_STARTS, RATE_RETRY_MS, RATE_WINDOW_MS, schedulerClock, startScheduler, stopScheduler, TIMER_CAP_MS } from "../src/scheduler";
import { countOccurrences, minGapMinutes, nextOccurrence } from "../src/schedule-time";
import { createSchedule, getSchedule, listSchedules, nextRunsOf, SCHEDULES_MAX, SCHEDULES_PER_THREAD_MAX, updateSchedule, type Schedule } from "../src/schedules";
import {
  buildSessionsDump,
  emitEvent,
  notifyPermissionsChanged,
  sessions,
  type IRequest,
  type IResponse,
  type SessionStore,
} from "../src/server-common";
import { handleRequest } from "../src/server";
import { claudeQuery, runAgent } from "../src/start-claude-code";
import { readThreadTail } from "../src/thread-tools";
import { agentRunners, startTurn } from "../src/turns";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- Seams: agents never run, and time and the timer are the test's ---

const realRunners = { ...agentRunners };
const realClock = { ...schedulerClock };
let runs: SessionStore[] = [];
let nextSdkId = 0;
/** Called inside startTurn, at the moment the agent would start. */
let onRun: ((store: SessionStore) => void) | null = null;
for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
  agentRunners[agent] = async (store) => {
    runs.push(store);
    onRun?.(store);
    // Reaches `init`, as Claude Code would: the thread is bound, and the turn runs on.
    if (!store.sdkSessionId) {
      store.sdkSessionId = `sdk-sched-${++nextSdkId}`;
      if (store.threadId) bindSession(store.threadId, store.sdkSessionId);
    }
  };
}

let now = Date.now();
/** The armed timer, run by hand. */
let timer: { fn: () => void; ms: number; cancelled: boolean } | null = null;
schedulerClock.now = () => now;
schedulerClock.setTimer = (fn, ms) => {
  const t = { fn, ms, cancelled: false };
  timer = t;
  return () => { t.cancelled = true; };
};

beforeEach(() => {
  now = Date.now();
  timer = null;
  onRun = null;
  rmSync(join(dataDir(), "schedules.json"), { force: true });
  startScheduler(ALL_AGENTS);
});
afterEach(() => {
  stopScheduler();
  for (const s of sessions.values()) sessions.delete(s.gitbotId);
  runs = [];
});
after(() => {
  Object.assign(agentRunners, realRunners);
  Object.assign(schedulerClock, realClock);
});

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { await tick(); await tick(); await tick(); };

/** The armed timer, read fresh (a plain read narrows after `timer = null`). */
const armed = () => timer;

/** Moves time to `at` and lets the armed timer go off, as often as it re-arms short of it. */
function advanceTo(at: number): void {
  now = at;
  for (let i = 0; i < 10 && timer && !timer.cancelled; i++) {
    const t = timer;
    timer = null;
    t.fn();
    if (!timer) break;
    if ((timer as { ms: number }).ms > 0) break;
  }
}

/** Ends a running turn as the harness would: a result, a status, a broadcast. */
async function endTurn(store: SessionStore, status: "done" | "error" = "done"): Promise<void> {
  if (status === "done") emitEvent(store, "result", { subtype: "success", result: "ok" });
  else emitEvent(store, "error", { message: "it broke" });
  store.status = status;
  notifyPermissionsChanged();
  await settle();
}

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "gitbot-sched-")));
}

function project(): { id: string; folder: string } {
  const f = folder();
  const added = addProject(f);
  assert.ok(added.ok);
  return { id: added.project.id, folder: f };
}

function plainThread(title?: string) {
  return createThread("builtin-claude-code", folder(), title, "chat", "claude-code");
}

function jarvisThread() {
  return createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
}

async function serve(method: string, url: string, body?: unknown, remote?: string) {
  const req = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: {},
    ...(remote ? { socket: { remoteAddress: remote } } : {}),
  }) as unknown as IRequest;
  let status = 0;
  let out = "";
  const res: IResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; },
    write() {},
    end(chunk) { out = chunk ?? ""; },
  };
  const done = handleRequest(req, res, ALL_AGENTS, tmpdir());
  setImmediate(() => {
    (req as unknown as EventEmitter).emit("data", JSON.stringify(body ?? {}));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: out ? JSON.parse(out) : null };
}

const atIso = (ms: number) => new Date(ms).toISOString();

/** A once on the thread, `inMs` from now, created through the route. */
async function scheduleOnce(threadId: string, inMs = 90_000, fields: Record<string, unknown> = {}): Promise<Schedule> {
  const created = await serve("POST", "/schedules", {
    name: "Ping",
    prompt: "Reply with exactly: pong",
    when: { kind: "once", at: atIso(now + inMs) },
    target: { kind: "thread", threadId },
    ...fields,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body;
}

const userPrompt = (store: SessionStore) => [...store.events].reverse().find((e) => e.type === "user_prompt") as any;

/** What the real Claude Code runner would hand the SDK as the prompt. */
async function agentPrompt(store: SessionStore): Promise<string> {
  const realRun = claudeQuery.run;
  let prompt: unknown;
  claudeQuery.run = ((args: any) => {
    prompt = args.prompt;
    return {
      async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "pong" }; },
      supportedModels: async () => { throw new Error("stub"); },
    } as any;
  }) as typeof claudeQuery.run;
  try {
    await runAgent(store);
  } finally {
    claudeQuery.run = realRun;
  }
  assert.equal(typeof prompt, "string");
  return prompt as string;
}

// --- Firing ---

test("a once schedule fires one scheduled turn on its thread at its time", async () => {
  const thread = plainThread("Demo");
  const at = now + 90_000;
  const s = await scheduleOnce(thread.id);
  assert.equal(s.nextRunAt, atIso(at));
  assert.equal(s.nextRunAt, s.when.kind === "once" ? s.when.at : undefined);
  assert.equal(s.enabled, true);
  assert.equal(s.runCount, 0);
  assert.equal(s.createdBy.kind, "user");
  assert.equal(s.overlap, "queue");
  assert.equal(s.notify, "always");

  // The timer sleeps at most a minute, then looks again.
  assert.equal(timer?.ms, TIMER_CAP_MS);
  advanceTo(now + TIMER_CAP_MS);
  assert.equal(runs.length, 0, "not yet");
  assert.equal(timer?.ms, 30_000, "re-armed to the due time");

  advanceTo(at);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].threadId, thread.id);
  assert.deepEqual(runs[0].scheduled, { id: s.id, name: "Ping", run: 1 });
  assert.deepEqual(userPrompt(runs[0]).scheduled, { id: s.id, name: "Ping", run: 1 });
  assert.deepEqual(buildSessionsDump().find((d) => d.threadId === thread.id)?.scheduled, { id: s.id, name: "Ping", run: 1 });

  // Nothing more fires, however long it waits.
  advanceTo(at + 10 * TIMER_CAP_MS);
  assert.equal(runs.length, 1);
});

test("the schedule is claimed and persisted before startTurn is called", async () => {
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id);
  let onDisk: Schedule | undefined;
  onRun = () => {
    const all: Schedule[] = JSON.parse(readFileSync(join(dataDir(), "schedules.json"), "utf-8"));
    onDisk = all.find((x) => x.id === s.id);
  };
  advanceTo(now + 90_000);
  assert.equal(runs.length, 1);
  assert.ok(onDisk, "read while the turn was starting");
  assert.equal(onDisk!.runCount, 1);
  assert.ok(onDisk!.lastRunAt);
  assert.equal(onDisk!.nextRunAt, null);
  assert.equal(onDisk!.enabled, false);

  const after = getSchedule(s.id)!;
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].outcome, "started");
  assert.equal(after.history[0].threadId, thread.id);
});

test("a once schedule is disabled after it fires and keeps its history", async () => {
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id);
  advanceTo(now + 90_000);
  await endTurn(runs[0]);
  assert.equal(timer, null, "no timer left to arm");

  const listed = await serve("GET", `/schedules?threadId=${thread.id}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.owner, { pid: process.pid, thisProcess: true });
  assert.equal(listed.body.schedules.length, 1);
  const got: Schedule = listed.body.schedules[0];
  assert.equal(got.id, s.id);
  assert.equal(got.enabled, false);
  assert.equal(got.nextRunAt, null);
  assert.equal(got.runCount, 1);
  assert.equal(got.history.length, 1);
  assert.equal(got.history[0].outcome, "started");

  // Another thread's list does not show it.
  const other = await serve("GET", `/schedules?threadId=${plainThread().id}`);
  assert.deepEqual(other.body.schedules, []);
});

// --- The tag: the agent's only ---

test("the agent's prompt carries the schedule tag; user_prompt, title and preview do not", async (t) => {
  t.mock.method(console, "warn", () => {});
  // Auto-titled, so its first turn names it.
  const thread = plainThread();
  const s = await scheduleOnce(thread.id, 90_000, { prompt: "Say hello in three words" });
  advanceTo(now + 90_000);
  const store = runs[0];

  assert.equal(userPrompt(store).prompt, "Say hello in three words");
  const th = getThread(thread.id)!;
  assert.equal(th.title, "Say hello in three words");
  assert.equal(th.preview, "Say hello in three words");

  // History, before the transcript has the prompt, and Jarvis's read of it.
  const history = await serve("GET", `/threads/${thread.id}/messages`);
  const user = history.body.messages.filter((m: any) => m.role === "user");
  assert.equal(user.length, 1);
  assert.equal(user[0].content[0].text, "Say hello in three words");
  assert.deepEqual(user[0].scheduled, { id: s.id, name: "Ping", run: 1 });
  const tail = await readThreadTail(thread.id);
  assert.ok(tail.ok);
  assert.deepEqual(tail.messages.map((m) => m.text), ["Say hello in three words"]);

  const sent = await agentPrompt(store);
  assert.equal(sent, `<gitbot-schedule id="${s.id}" name="Ping" run="1"/>\nSay hello in three words`);
  for (const text of [userPrompt(store).prompt, getThread(thread.id)!.title, getThread(thread.id)!.preview]) {
    assert.ok(!text.includes("<gitbot-schedule"), text);
  }
});

test("a Jarvis-thread target gets the tag first and the Jarvis reminder last", async () => {
  const jarvis = jarvisThread();
  const s = await scheduleOnce(jarvis.id, 90_000, { prompt: "remind me to stretch" });
  advanceTo(now + 90_000);
  assert.equal(runs.length, 1);
  const sent = await agentPrompt(runs[0]);
  const [first, ...rest] = sent.split("\n");
  assert.equal(first, `<gitbot-schedule id="${s.id}" name="Ping" run="1"/>`);
  assert.ok(rest.join("\n").startsWith("remind me to stretch\n\n<gitbot-reminder>"), sent);
  assert.ok(sent.trimEnd().endsWith("</gitbot-reminder>"), sent);
  assert.equal(userPrompt(runs[0]).prompt, "remind me to stretch");
});

test("a scheduled turn does not consume a pending note", async () => {
  const jarvis = jarvisThread();
  updateThread(jarvis.id, { pendingNote: "[you stopped PR Validator on Trophy]" });
  await scheduleOnce(jarvis.id, 90_000, { prompt: "check the build" });
  advanceTo(now + 90_000);
  assert.equal(runs.length, 1);
  assert.equal(userPrompt(runs[0]).prompt, "check the build");
  assert.equal(getThread(jarvis.id)!.pendingNote, "[you stopped PR Validator on Trophy]");
  await endTurn(runs[0]);

  // The user's own next message carries it, once.
  const sent = await serve("POST", "/chat", { threadId: jarvis.id, prompt: "how did it go?" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const prompt = userPrompt(runs[runs.length - 1]);
  assert.equal(prompt.prompt, "[you stopped PR Validator on Trophy]\n\nhow did it go?");
  assert.equal(prompt.scheduled, undefined, "the user's turn is not scheduled");
  assert.equal(getThread(jarvis.id)!.pendingNote, undefined);
});

// --- Ownership ---

test("a scheduled run is never reportable and never changes thread ownership or runningFor", async (t) => {
  const unwatch = watchChildReports(ALL_AGENTS);
  t.after(unwatch);
  const jarvis = jarvisThread();
  const child = plainThread("Child");
  const mark = { owner: jarvis.id, pid: 424242 };
  updateThread(child.id, { reportTo: jarvis.id, runningFor: mark });

  await scheduleOnce(child.id);
  advanceTo(now + 90_000);
  assert.equal(runs.length, 1);
  const store = runs[0];
  assert.equal(store.reportable, false);
  assert.equal(store.reportOwner, undefined);
  assert.equal(buildSessionsDump().find((d) => d.threadId === child.id)?.reportTo, null);
  assert.equal(runningChildOf(jarvis.id), undefined, "the Jarvis thread is not locked");
  assert.equal(getThread(child.id)!.reportTo, jarvis.id, "still Jarvis's");
  // At its start. (Its end, like any turn's, lets watchRunningMarks clear the
  // thread's mark, which no reportable turn can hold while the thread is idle.)
  assert.deepEqual(getThread(child.id)!.runningFor, mark, "the running mark is untouched at the start");

  // Its end reports to no one.
  await endTurn(store);
  assert.equal(runs.length, 1, "no report turn on Jarvis");
  assert.equal(getThread(child.id)!.reportTo, jarvis.id);

  // A user turn after it still behaves as before: it takes the thread.
  const sent = await serve("POST", "/chat", { threadId: child.id, prompt: "thanks" });
  assert.equal(sent.status, 200);
  assert.equal(runs[1].scheduled, undefined);
  assert.equal(getThread(child.id)!.reportTo, undefined);
});

test("a store reused by a later turn never carries the last turn's schedule", async () => {
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id, 3_600_000);
  // Turn two on a thread is the store later turns reuse (keyed by the SDK id).
  assert.ok(startTurn({ threadId: thread.id, prompt: "one" }, ALL_AGENTS).ok);
  await endTurn(runs[0]);
  assert.ok(startTurn({ threadId: thread.id, prompt: "two" }, ALL_AGENTS).ok);
  const reused = runs[1];
  await endTurn(reused);

  await serve("POST", `/schedules/${s.id}/run`);
  assert.equal(runs[2], reused, "the scheduled turn reuses it");
  assert.deepEqual(reused.scheduled, { id: s.id, name: "Ping", run: 1 });
  await endTurn(reused);

  const sent = await serve("POST", "/chat", { threadId: thread.id, prompt: "three" });
  assert.equal(sent.status, 200);
  assert.equal(runs[3], reused);
  assert.equal(reused.scheduled, undefined);
  assert.equal(userPrompt(reused).scheduled, undefined);
  assert.equal(buildSessionsDump().find((d) => d.gitbotId === reused.gitbotId)?.scheduled, null);
  assert.equal(await agentPrompt(reused), "three", "the agent gets the message as typed");
});

// --- When it can't start ---

test("a busy target records skipped-busy and starts nothing", async () => {
  // A thread with a turn of its own running.
  const thread = plainThread("Busy");
  assert.ok(startTurn({ threadId: thread.id, prompt: "count slowly to 40" }, ALL_AGENTS).ok);
  const s = await scheduleOnce(thread.id);
  advanceTo(now + 90_000);
  assert.equal(runs.length, 1, "only the user's turn");
  let got = getSchedule(s.id)!;
  assert.equal(got.history.length, 1);
  assert.equal(got.history[0].outcome, "skipped-busy");
  assert.equal(got.history[0].threadId, thread.id);
  assert.equal(got.enabled, false, "a once is done either way");
  assert.equal(runs[0].status, "running", "the user's turn is unaffected");
  assert.equal(runs[0].scheduled, undefined);

  // A Jarvis thread waiting on its child.
  const jarvis = jarvisThread();
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: project().id, message: "run the tests" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  assert.ok(runningChildOf(jarvis.id));
  const onJarvis = await scheduleOnce(jarvis.id, 120_000);
  advanceTo(now + 120_000);
  assert.equal(runs.length, 2, "nothing started on Jarvis");
  got = getSchedule(onJarvis.id)!;
  assert.equal(got.history[0].outcome, "skipped-busy");
});

test("a start refusal records failed-to-start with the error", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id);
  // Claude Code is gone by the time it fires.
  stopScheduler();
  startScheduler(["codex"]);
  advanceTo(now + 90_000);
  assert.equal(runs.length, 0);
  const got = getSchedule(s.id)!;
  assert.equal(got.history.length, 1);
  assert.equal(got.history[0].outcome, "failed-to-start");
  assert.equal(got.history[0].threadId, thread.id);
  assert.match(got.history[0].error ?? "", /claude-code/i);
  assert.equal(got.runCount, 1);
});

test("the turn's outcome is written to the run's history entry when it ends", async () => {
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id, 3_600_000);
  const first = await serve("POST", `/schedules/${s.id}/run`);
  assert.equal(first.status, 200);
  assert.equal(getSchedule(s.id)!.history[0].turnOutcome, undefined, "not until it ends");
  await endTurn(runs[0], "done");
  assert.equal(getSchedule(s.id)!.history[0].turnOutcome, "done");

  await serve("POST", `/schedules/${s.id}/run`);
  await endTurn(runs[1], "error");
  const got = getSchedule(s.id)!;
  assert.deepEqual(got.history.map((h) => [h.outcome, h.turnOutcome]), [["started", "done"], ["started", "failed"]]);

  // A user's turn on the same thread writes nothing to the schedule.
  assert.ok(startTurn({ threadId: thread.id, prompt: "and now?" }, ALL_AGENTS).ok);
  await endTurn(runs[2], "error");
  assert.deepEqual(getSchedule(s.id)!.history.map((h) => h.turnOutcome), ["done", "failed"]);
});

// --- Startup ---

test("a once missed while gitbot was down is recorded missed and never fires", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id, 40_000);
  // gitbot stops; the time passes; it starts again.
  stopScheduler();
  assert.equal(timer?.cancelled, true);
  timer = null;
  now += 100_000;
  startScheduler(ALL_AGENTS);
  assert.equal(timer, null, "nothing left to fire");
  advanceTo(now + 10 * TIMER_CAP_MS);
  assert.equal(runs.length, 0);
  const got = getSchedule(s.id)!;
  assert.equal(got.enabled, false);
  assert.equal(got.nextRunAt, null);
  assert.equal(got.runCount, 1, "a missed run is a run used up (it counts toward maxRuns)");
  assert.deepEqual(got.history, [{ at: s.nextRunAt, outcome: "missed", missedCount: 1 }]);
});

test("startScheduler survives a corrupt schedules.json", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  stopScheduler();
  writeFileSync(join(dataDir(), "schedules.json"), "{ not json");
  assert.doesNotThrow(() => startScheduler(ALL_AGENTS));
  assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes("schedules.json")));
  const listed = await serve("GET", "/schedules");
  assert.deepEqual(listed.body.schedules, []);

  // Not even an unreadable one (a directory where the file should be).
  stopScheduler();
  rmSync(join(dataDir(), "schedules.json"), { force: true });
  const { mkdirSync } = await import("fs");
  mkdirSync(join(dataDir(), "schedules.json"));
  try {
    assert.doesNotThrow(() => startScheduler(ALL_AGENTS));
  } finally {
    rmSync(join(dataDir(), "schedules.json"), { recursive: true, force: true });
  }
});

// --- Routes ---

test("POST /schedules validates name, prompt, time, target and limits", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const good = {
    name: "Ping",
    prompt: "Reply with exactly: pong",
    when: { kind: "once", at: atIso(now + 60_000) },
    target: { kind: "thread", threadId: thread.id },
  };
  const refused = async (body: unknown, pattern: RegExp) => {
    const r = await serve("POST", "/schedules", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, pattern);
  };
  await refused({ ...good, when: { kind: "once", at: atIso(now - 1000) } }, /future/);
  await refused({ ...good, when: { kind: "once", at: "tomorrow" } }, /ISO/);
  await refused({ ...good, when: { kind: "once", at: "2099-01-01T10:00:00" } }, /zone/);
  await refused({ ...good, target: { kind: "thread", threadId: "no-such-thread" } }, /no thread/);
  await refused({ ...good, name: "x".repeat(61) }, /60/);
  for (const bad of ['Bad "name"', "it's", "<b>", "a>b"]) await refused({ ...good, name: bad }, /quotes/);
  await refused({ ...good, name: "" }, /name is required/);
  await refused({ ...good, prompt: "x".repeat(4001) }, /4000/);
  await refused({ ...good, prompt: "  " }, /prompt is required/);
  await refused({ ...good, attachments: [{ url: "https://x/y.png" }] }, /text only/);
  await refused({ ...good, when: { kind: "weekly" } }, /when.kind must be/);
  await refused({ ...good, target: { kind: "new-thread", botId: "b", projectId: "p" } }, /not supported yet/);
  await refused({ ...good, when: undefined }, /when is required/);
  // Impossible dates and times, which Date.parse would roll over.
  for (const at of ["2099-02-30T10:00:00Z", "2099-02-29T10:00Z", "2099-13-01T10:00:00Z", "2099-04-31T10:00:00Z", "2099-01-01T24:00:00Z", "2099-01-01T10:60:00Z", "2099-01-01T10:00:00+25:00"]) {
    await refused({ ...good, when: { kind: "once", at } }, /ISO 8601/);
  }
  assert.equal((await serve("POST", "/schedules", { ...good, when: { kind: "once", at: "2096-02-29T10:00:00+05:30" }, target: { kind: "thread", threadId: plainThread().id } })).status, 200, "a real leap day");
  await refused({ ...good, target: undefined }, /target is required/);

  // Exactly 60 characters is fine, and the write is logged with its sender.
  const ok = await serve("POST", "/schedules", { ...good, name: "n".repeat(60) }, "127.0.0.1");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.createdBy, { kind: "user", remote: "127.0.0.1" });
  assert.ok(logs.mock.calls.some((c) => c.arguments[0] === `[schedules] create ${ok.body.id} from 127.0.0.1`));

  // 20 per thread: the 21st is refused.
  for (let i = 1; i < SCHEDULES_PER_THREAD_MAX; i++) {
    assert.ok(createSchedule(good, { kind: "user" }, now).ok);
  }
  await refused(good, /at most 20 active schedules on one thread/);

  // 100 in all: the 101st is refused, on any thread.
  const fill = SCHEDULES_MAX - listSchedules().length;
  let target = plainThread();
  for (let i = 0; i < fill; i++) {
    if (i % SCHEDULES_PER_THREAD_MAX === 0) target = plainThread();
    assert.ok(createSchedule({ ...good, target: { kind: "thread", threadId: target.id } }, { kind: "user" }, now).ok);
  }
  await refused({ ...good, target: { kind: "thread", threadId: plainThread().id } }, /at most 100 schedules/);
});

test("POST /schedules/:id/run fires now and counts as a run", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id, 3_600_000);

  const fired = await serve("POST", `/schedules/${s.id}/run`, undefined, "::1");
  assert.equal(fired.status, 200);
  assert.equal(fired.body.run.outcome, "started");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].scheduled, { id: s.id, name: "Ping", run: 1 });
  assert.ok(logs.mock.calls.some((c) => c.arguments[0] === `[schedules] run ${s.id} from ::1`));
  let got = getSchedule(s.id)!;
  assert.equal(got.runCount, 1);
  assert.equal(got.nextRunAt, s.nextRunAt, "its own time is not moved");
  assert.equal(got.enabled, true);
  assert.equal(got.history.length, 1);

  // Again, once that turn is over: run 2.
  await endTurn(runs[0]);
  await serve("POST", `/schedules/${s.id}/run`);
  assert.deepEqual(runs[1].scheduled, { id: s.id, name: "Ping", run: 2 });
  await endTurn(runs[1]);

  // Its own time still comes: run 3.
  advanceTo(now + 3_600_000);
  assert.equal(runs.length, 3);
  assert.equal(runs[2].scheduled?.run, 3);
  await endTurn(runs[2]);

  // A run now that lands when the timer is due is that fire, not a second one.
  const due = await scheduleOnce(thread.id, 30_000);
  now += 30_000;
  const at = await serve("POST", `/schedules/${due.id}/run`);
  assert.equal(at.body.run.outcome, "started");
  got = getSchedule(due.id)!;
  assert.equal(got.enabled, false);
  assert.equal(got.nextRunAt, null);
  advanceTo(now + TIMER_CAP_MS);
  assert.equal(runs.length, 4, "fired once");

  assert.equal((await serve("POST", "/schedules/nope/run")).status, 404);
});

test("DELETE /schedules/:id stops a pending fire", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id, 30_000);
  const armed = timer!;
  assert.equal(armed.ms, 30_000);

  const removed = await serve("DELETE", `/schedules/${s.id}`, undefined, "127.0.0.1");
  assert.equal(removed.status, 200);
  assert.ok(logs.mock.calls.some((c) => c.arguments[0] === `[schedules] delete ${s.id} from 127.0.0.1`));
  assert.equal(armed.cancelled, true, "its timer is cleared");
  assert.equal(timer, armed, "and none re-armed");
  assert.equal(getSchedule(s.id), undefined);

  // Even a timer that went off anyway fires nothing.
  now += 30_000;
  armed.fn();
  assert.equal(runs.length, 0);
  assert.equal((await serve("DELETE", `/schedules/${s.id}`)).status, 404);
});

// --- Review fixes ---

const schedulesFile = () => join(dataDir(), "schedules.json");
/** Makes every write of schedules.json fail: its temp file's path is a directory. */
const blockWrites = () => mkdirSync(`${schedulesFile()}.${process.pid}.tmp`, { recursive: true });
const unblockWrites = () => rmSync(`${schedulesFile()}.${process.pid}.tmp`, { recursive: true, force: true });

/** A schedule as a later build (or a hand edit) might store it. */
function foreignSchedule(threadId: string, fields: Partial<Schedule>): Schedule {
  const stamp = atIso(now);
  return {
    id: `foreign-${Math.random().toString(36).slice(2)}`,
    name: "Nightly",
    prompt: "run the audit",
    when: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "thread", threadId },
    createdBy: { kind: "user" },
    enabled: true,
    overlap: "queue",
    notify: "always",
    runCount: 0,
    consecutiveFailures: 0,
    nextRunAt: atIso(now - 1000),
    history: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...fields,
  } as Schedule;
}

test("a schedule kind this build doesn't run never fires and never arms a 0 ms timer", async (t) => {
  const warns = t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  // A new-thread target (slice 09), and whens no build can work out (written by hand).
  const newThread = foreignSchedule(thread.id, { when: { kind: "once", at: atIso(now - 1000) }, target: { kind: "new-thread", botId: "b", projectId: "p" } });
  const badCron = foreignSchedule(thread.id, { when: { kind: "cron", expr: "not a pattern", tz: "UTC" } });
  const badZone = foreignSchedule(thread.id, { when: { kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" } });
  const badInterval = foreignSchedule(thread.id, { when: { kind: "interval", everyMinutes: 0, anchor: atIso(now) } });
  const foreign = [newThread, badCron, badZone, badInterval];
  stopScheduler();
  timer = null;
  writeFileSync(schedulesFile(), JSON.stringify(foreign, null, 2));
  startScheduler(ALL_AGENTS);
  assert.equal(timer, null, "nothing to arm a timer for");
  assert.equal(warns.mock.calls.length, foreign.length, "each logged once");

  // Next to a once this build does run, the timer is for the once alone.
  const once = await scheduleOnce(thread.id, 90_000);
  assert.equal(armed()?.ms, TIMER_CAP_MS);
  advanceTo(now + 90_000);
  assert.equal(runs.length, 1, "the once fired, and only it");
  assert.equal(runs[0].scheduled?.id, once.id);
  assert.equal(timer, null, "and nothing re-armed after it");
  for (const s of foreign) {
    const left = getSchedule(s.id)!;
    assert.equal(left.runCount, 0);
    assert.deepEqual(left.history, []);
    assert.equal(left.enabled, true);
    assert.equal(left.nextRunAt, s.nextRunAt, "left exactly as it was");
  }
  assert.equal(warns.mock.calls.length, foreign.length, "not logged again");

  // A run now is refused, not fired, and the log says so.
  const logs = t.mock.method(console, "log", () => {});
  const r = await serve("POST", `/schedules/${newThread.id}/run`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not supported/);
  assert.equal(runs.length, 1);
  assert.ok(logs.mock.calls.some((c) => String(c.arguments[0]).startsWith(`[schedules] run-refused ${newThread.id}`)));
});

test("a tick that keeps failing backs off, and a tick never re-arms sooner than the floor", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleOnce(thread.id, 30_000);
  blockWrites();
  try {
    advanceTo(now + 30_000);
    assert.equal(runs.length, 0, "the claim could not be saved, so nothing started");
    assert.equal(timer?.ms, ERROR_BACKOFF_MS, "backs off instead of re-arming at 0");
    // Still failing: still backing off, one log line per try.
    const before = errors.mock.calls.length;
    advanceTo(now + ERROR_BACKOFF_MS);
    assert.equal(timer?.ms, ERROR_BACKOFF_MS);
    assert.equal(errors.mock.calls.length, before + 1);
  } finally {
    unblockWrites();
  }
  // Writable again: the next try fires it, once.
  advanceTo(now + ERROR_BACKOFF_MS);
  assert.equal(runs.length, 1);
  assert.equal(getSchedule(s.id)!.runCount, 1);
  await endTurn(runs[0]);

  // Another once due a moment after the one a tick fires waits for the floor.
  const other = plainThread("Other");
  await scheduleOnce(thread.id, 60_000);
  await scheduleOnce(other.id, 60_100);
  advanceTo(now + 60_000);
  assert.equal(runs.length, 2);
  assert.equal(timer?.ms, MIN_REARM_MS, "not 100 ms: never sooner than the floor after a tick");
  advanceTo(now + MIN_REARM_MS);
  assert.equal(runs.length, 3);
});

test("a bot that still needs setup records failed-to-start with the setup message, not skipped-busy", async (t) => {
  t.mock.method(console, "log", () => {});
  const bot = createBot({ name: "Needs Setup", setupInstructions: "install ffmpeg" });
  const thread = createThread(bot.id, folder(), "Work", "chat", "claude-code");
  const s = await scheduleOnce(thread.id);
  advanceTo(now + 90_000);
  assert.equal(runs.length, 0);
  const run = getSchedule(s.id)!.history[0];
  assert.equal(run.outcome, "failed-to-start");
  assert.equal(run.error, "Needs Setup still needs to set up this machine");
});

test("a scheduled turn always runs in auto-approve, whatever the bot's default or the thread's pick", async () => {
  for (const permissionMode of ["ask-permissions", "plan", "auto-approve"] as const) {
    const bot = createBot({ name: `Bot ${permissionMode}`, permissionMode });
    const thread = createThread(bot.id, folder(), "Work", "chat", "claude-code");
    // The user's own turn, in the mode they picked in the composer.
    const mine = await serve("POST", "/chat", { threadId: thread.id, prompt: "one", permissionMode: "ask-permissions", mode: "plan" });
    assert.equal(mine.status, 200);
    const userStore = runs[runs.length - 1];
    assert.equal(userStore.permissionMode, "ask-permissions");
    assert.equal(userStore.mode, "plan");
    await endTurn(userStore);

    const s = await scheduleOnce(thread.id, 3_600_000);
    await serve("POST", `/schedules/${s.id}/run`);
    const store = runs[runs.length - 1];
    assert.deepEqual(store.scheduled?.id, s.id);
    assert.equal(store.permissionMode, "yolo", permissionMode);
    assert.equal(store.mode, "build", permissionMode);
    const config = await serve("GET", `/sessions/${store.gitbotId}/config`);
    assert.equal(config.body.permissionMode, "yolo");
    assert.deepEqual(config.body.scheduled, { id: s.id, name: "Ping", run: 1 });
    await endTurn(store);

    // The user's next turn is in their own mode again; config says it isn't scheduled.
    const again = await serve("POST", "/chat", { threadId: thread.id, prompt: "two", permissionMode: "ask-permissions" });
    assert.equal(again.status, 200);
    const next = runs[runs.length - 1];
    assert.equal(next.permissionMode, "ask-permissions");
    assert.equal((await serve("GET", `/sessions/${next.gitbotId}/config`)).body.scheduled, null);
    await endTurn(next);
  }
});

test("fired one-shots kept for their history don't count toward a thread's 20", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const body = { name: "Ping", prompt: "p", when: { kind: "once", at: atIso(now + 60_000) }, target: { kind: "thread", threadId: thread.id } };
  for (let i = 0; i < SCHEDULES_PER_THREAD_MAX; i++) {
    const made = createSchedule(body, { kind: "user" }, now);
    assert.ok(made.ok);
    updateSchedule(made.schedule.id, (s) => { s.enabled = false; s.nextRunAt = null; });
  }
  const ok = await serve("POST", "/schedules", body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // Twenty that can still fire are the limit.
  for (let i = 1; i < SCHEDULES_PER_THREAD_MAX; i++) assert.ok(createSchedule(body, { kind: "user" }, now).ok);
  const full = await serve("POST", "/schedules", body);
  assert.equal(full.status, 400);
  assert.match(full.body.error, /at most 20 active schedules on one thread/);
});

test("a startup that can't save still leaves the scheduler running, and never fires a missed once late", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const missed = await scheduleOnce(thread.id, 40_000);
  stopScheduler();
  timer = null;
  now += 100_000;
  blockWrites();
  try {
    assert.doesNotThrow(() => startScheduler(ALL_AGENTS));
    assert.equal(armed()?.ms, ERROR_BACKOFF_MS, "armed only to retry saving the missed record");
    advanceTo(now + ERROR_BACKOFF_MS);
    assert.equal(runs.length, 0, "still unsaved: the missed once never fires");
  } finally {
    unblockWrites();
  }
  // New schedules still arm the timer and fire.
  const later = await scheduleOnce(thread.id, 30_000);
  // The retry, now the disk takes it, records the missed run; it never fires.
  advanceTo(now + ERROR_BACKOFF_MS);
  const got = getSchedule(missed.id)!;
  assert.deepEqual(got.history, [{ at: missed.nextRunAt, outcome: "missed", missedCount: 1 }]);
  assert.equal(got.enabled, false);
  advanceTo(now + 20_000);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduled?.id, later.id, "the new one, not the missed one");
});

test("a recurring schedule whose missed record failed to save fires again once the disk recovers", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const made = now;
  const s = await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 });
  stopScheduler();
  timer = null;
  now = made + 3 * MIN + 30_000; // the runs at +1, +2 and +3 min passed
  blockWrites();
  try {
    startScheduler(ALL_AGENTS);
    for (let i = 0; i < 3; i++) {
      assert.equal(armed()?.ms, ERROR_BACKOFF_MS);
      elapse(ERROR_BACKOFF_MS);
    }
    assert.equal(runs.length, 0, "nothing fires late while the missed record is unsaved");
  } finally {
    unblockWrites();
  }
  elapse(ERROR_BACKOFF_MS); // +4:10: the retry saves
  let got = getSchedule(s.id)!;
  assert.deepEqual(got.history, [{ at: atIso(made + MIN), outcome: "missed", missedCount: 4 }], "+1 to +4 min, all passed");
  assert.equal(got.nextRunAt, atIso(made + 5 * MIN));
  assert.equal(runs.length, 0);
  elapse(50_000);
  assert.equal(runs.length, 1, "and it runs on, without a restart");
  got = getSchedule(s.id)!;
  assert.equal(got.history.at(-1)!.outcome, "started");
});

test("a corrupt schedules.json is moved aside, not overwritten, by the next write", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  stopScheduler();
  writeFileSync(schedulesFile(), "{ not json");
  startScheduler(ALL_AGENTS);
  const thread = plainThread("Demo");
  await scheduleOnce(thread.id);
  const aside = readdirSync(dataDir()).filter((f) => f.startsWith("schedules.json.bad-"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(dataDir(), aside[0]), "utf-8"), "{ not json", "kept as it was");
  assert.equal(listSchedules().length, 1);
  rmSync(join(dataDir(), aside[0]));
});

// --- Recurring: cron and interval (slice 02) ---

/** Moves time forward by `ms`, letting every timer that comes due on the way go off. */
function elapse(ms: number): void {
  const target = now + ms;
  for (let i = 0; i < 10_000; i++) {
    const t = timer;
    if (!t || t.cancelled || now + t.ms > target) break;
    now += t.ms;
    timer = null;
    t.fn();
  }
  now = target;
}

/** A recurring schedule on the thread, created through the route; the body is returned with its nextRuns. */
async function scheduleRecurring(threadId: string, when: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  const created = await serve("POST", "/schedules", {
    name: "Tick",
    prompt: "Reply with the word tick and nothing else",
    when,
    target: { kind: "thread", threadId },
    ...fields,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body as Schedule & { nextRuns: string[] };
}

const MIN = 60_000;
const started = (s: Schedule) => s.history.filter((h) => h.outcome === "started");

/** Ends every scheduled turn still running, so the next fire finds its thread idle. */
async function endAll(): Promise<void> {
  for (const r of runs) if (r.status === "running") await endTurn(r);
}

test("an interval schedule fires every N minutes from its anchor", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const made = now;
  const s = await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 });
  assert.deepEqual(s.when, { kind: "interval", everyMinutes: 1, anchor: atIso(made) }, "the anchor defaults to now");
  assert.equal(s.nextRunAt, atIso(made + MIN));
  assert.deepEqual(s.nextRuns, [atIso(made + MIN), atIso(made + 2 * MIN), atIso(made + 3 * MIN)]);
  assert.equal(armed()?.ms, MIN);

  for (let n = 1; n <= 3; n++) {
    elapse(MIN);
    assert.equal(runs.length, n);
    assert.deepEqual(runs[n - 1].scheduled, { id: s.id, name: "Tick", run: n }, "the chip counts 1, 2, 3");
    const got = getSchedule(s.id)!;
    assert.equal(got.runCount, n);
    assert.equal(got.nextRunAt, atIso(made + (n + 1) * MIN), "on the grid from the anchor");
    await endAll();
  }

  // An explicit anchor in the past: runs stay on its grid.
  const other = plainThread("Other");
  const anchored = await scheduleRecurring(other.id, { kind: "interval", everyMinutes: 5, anchor: atIso(made - 7 * MIN) });
  assert.deepEqual(anchored.nextRuns, [atIso(made + 8 * MIN), atIso(made + 13 * MIN), atIso(made + 18 * MIN)]);
  // And one in the future runs first at the anchor itself.
  const future = await scheduleRecurring(other.id, { kind: "interval", everyMinutes: 5, anchor: atIso(made + 30 * MIN) });
  assert.equal(future.nextRunAt, atIso(made + 30 * MIN));
});

test("a cron schedule follows its timezone", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  now = Date.parse("2026-10-14T12:00:30Z");
  const london = await scheduleRecurring(thread.id, { kind: "cron", expr: "*/2 * * * *", tz: "Europe/London" });
  assert.deepEqual(london.nextRuns, ["2026-10-14T12:02:00.000Z", "2026-10-14T12:04:00.000Z", "2026-10-14T12:06:00.000Z"]);
  const croner = new Cron("*/2 * * * *", { timezone: "Europe/London" }).nextRuns(3, new Date(now)).map((d) => d.toISOString());
  assert.deepEqual(london.nextRuns, croner, "the same as croner's own");

  // 09:00 in Kolkata (UTC+5:30) is 03:30 UTC; in New York (EDT, UTC-4) 13:00 UTC.
  const kolkata = await scheduleRecurring(thread.id, { kind: "cron", expr: "0 9 * * *", tz: "Asia/Kolkata" });
  assert.deepEqual(kolkata.nextRuns, ["2026-10-15T03:30:00.000Z", "2026-10-16T03:30:00.000Z", "2026-10-17T03:30:00.000Z"]);
  // 14 October 2026 is a Wednesday: Wed, Thu, Fri, then (after the weekend) Monday.
  const ny = await scheduleRecurring(thread.id, { kind: "cron", expr: "0 9 * * 1-5", tz: "America/New_York" });
  assert.deepEqual(ny.nextRuns, ["2026-10-14T13:00:00.000Z", "2026-10-15T13:00:00.000Z", "2026-10-16T13:00:00.000Z"]);
  const afterFriday = nextOccurrence(ny.when, Date.parse("2026-10-16T14:00:00Z"))!;
  assert.deepEqual(nextRunsOf({ ...ny, nextRunAt: atIso(afterFriday) }, 2), ["2026-10-19T13:00:00.000Z", "2026-10-20T13:00:00.000Z"], "weekdays only");
  await serve("DELETE", `/schedules/${ny.id}`); // due before the London one

  // No tz: the server's own.
  const local = await scheduleRecurring(thread.id, { kind: "cron", expr: "0 9 * * *" });
  assert.equal((local.when as any).tz, Intl.DateTimeFormat().resolvedOptions().timeZone);

  // It fires on the even minute, and moves to the next.
  elapse(90_000);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduled?.id, london.id);
  assert.equal(getSchedule(london.id)!.lastRunAt, "2026-10-14T12:02:00.000Z");
  assert.equal(getSchedule(london.id)!.nextRunAt, "2026-10-14T12:04:00.000Z");
});

test("cron across a DST change matches croner and fires once per wall time", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const warns = t.mock.method(console, "warn", () => {});
  const strictlyIncreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
  const walk = (when: any, from: number, n: number) => {
    const out: number[] = [];
    let at: number | null = from;
    while (out.length < n && (at = nextOccurrence(when, at!)) != null) out.push(at);
    return out;
  };
  const wall = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(ms);

  // London springs forward at 01:00 UTC on 29 March 2026 (01:00 GMT -> 02:00 BST).
  // croner alone gives 01:00Z, 01:30Z, then 01:00Z again here.
  const spring = { kind: "cron", expr: "*/30 * * * *", tz: "Europe/London" } as const;
  const springRuns = walk(spring, Date.parse("2026-03-29T00:10:00Z"), 6);
  assert.ok(strictlyIncreasing(springRuns), springRuns.map(atIso).join(" "));
  assert.deepEqual(springRuns.map(atIso), [
    "2026-03-29T00:30:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-29T01:30:00.000Z",
    "2026-03-29T02:00:00.000Z", "2026-03-29T02:30:00.000Z", "2026-03-29T03:00:00.000Z",
  ]);
  const springWall = springRuns.map((ms) => wall(ms, "Europe/London"));
  assert.equal(new Set(springWall).size, springWall.length, "no wall time twice");
  // Where croner's own answers go forward, they are the same.
  const cron = new Cron(spring.expr, { timezone: spring.tz, mode: "5-part" });
  for (const from of ["2026-03-28T22:00:00Z", "2026-03-29T05:00:00Z"]) {
    assert.deepEqual(walk(spring, Date.parse(from), 5), cron.nextRuns(5, new Date(from)).map((d) => d.getTime()));
  }
  // A daily 01:30 (a wall time that doesn't exist that night) still runs once that day.
  const daily = walk({ kind: "cron", expr: "30 1 * * *", tz: "Europe/London" }, Date.parse("2026-03-28T00:00:00Z"), 3);
  assert.deepEqual(daily.map(atIso), ["2026-03-28T01:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]);

  // New York springs forward at 07:00 UTC on 8 March 2026; croner repeats 07:00Z.
  const nyRuns = walk({ kind: "cron", expr: "0 * * * *", tz: "America/New_York" }, Date.parse("2026-03-08T05:30:00Z"), 4);
  assert.deepEqual(nyRuns.map(atIso), ["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-08T09:00:00.000Z"]);

  // London falls back at 01:00 UTC on 25 October 2026 (02:00 BST -> 01:00 GMT): 01:xx
  // happens twice on the wall, and runs once. From inside the repeated hour, croner
  // answers with an earlier time (01:00:30Z -> 00:02Z); the next run is still later.
  const back = { kind: "cron", expr: "* * * * *", tz: "Europe/London" } as const;
  for (const from of ["2026-10-25T00:58:00Z", "2026-10-25T01:00:00Z", "2026-10-25T01:00:30Z", "2026-10-25T01:30:00Z"]) {
    const next = nextOccurrence(back, Date.parse(from))!;
    assert.ok(next > Date.parse(from), `${from} -> ${atIso(next)}`);
  }
  // Where croner had to be asked again, it is logged (once a pattern), so a croner upgrade shows.
  const stepped = warns.mock.calls.filter((c) => String(c.arguments[0]).includes('for "* * * * *" in Europe/London'));
  assert.equal(stepped.length, 1, "logged once");
  const dailyBack = walk({ kind: "cron", expr: "30 1 * * *", tz: "Europe/London" }, Date.parse("2026-10-24T12:00:00Z"), 2);
  assert.deepEqual(dailyBack.map(atIso), ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"], "01:30 once, not again an hour later");

  // Through the scheduler: a 1-minute cron run across the fall-back hour.
  const thread = plainThread("Demo");
  now = Date.parse("2026-10-25T00:57:30Z");
  const s = await scheduleRecurring(thread.id, back);
  const seen: string[] = [];
  const numbers: number[] = [];
  for (let i = 0; i < 6; i++) {
    const before = getSchedule(s.id)!.nextRunAt!;
    elapse(Date.parse(before) - now);
    numbers.push(runs.at(-1)!.scheduled!.run);
    const after = getSchedule(s.id)!;
    assert.ok(Date.parse(after.nextRunAt!) > Date.parse(before), `${before} -> ${after.nextRunAt}`);
    assert.ok(armed()!.ms >= MIN_REARM_MS, "never a 0 ms re-arm");
    seen.push(after.lastRunAt!);
    await endAll();
  }
  assert.equal(new Set(seen).size, seen.length, "never fired twice at one time");
  assert.ok(strictlyIncreasing(seen.map((x) => Date.parse(x))));
  assert.equal(runs.length, 6);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6]);
});

test("nextRunAt always moves strictly forward, so a recurring schedule never re-fires in a loop", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const thread = plainThread("Demo");
  // Due at 01:00 UTC on the night London falls back, where croner's own answer
  // for "the minute after 01:00Z" is 00:01Z, an hour earlier.
  const at = Date.parse("2026-10-25T01:00:00Z");
  const cron = foreignSchedule(thread.id, { when: { kind: "cron", expr: "* * * * *", tz: "Europe/London" }, nextRunAt: atIso(at + 1000) });
  const interval = foreignSchedule(plainThread().id, { when: { kind: "interval", everyMinutes: 1, anchor: "2026-10-25T00:00:00Z" }, nextRunAt: atIso(at + 1000) });
  stopScheduler();
  timer = null;
  writeFileSync(schedulesFile(), JSON.stringify([cron, interval], null, 2));
  now = at;
  startScheduler(ALL_AGENTS);
  // Both come due with gitbot running: a run now (when due, that is the fire) and the timer.
  now = at + 1000;
  await serve("POST", `/schedules/${cron.id}/run`);
  advanceTo(now);
  for (const s of [cron, interval]) {
    const got = getSchedule(s.id)!;
    assert.ok(Date.parse(got.nextRunAt!) > now, `${s.when.kind}: ${got.nextRunAt}`);
    assert.equal(started(got).length, 1, `${s.when.kind} fired once`);
  }
  // However many times the timer goes off at the same instant, nothing fires again.
  for (let i = 0; i < 20; i++) {
    const tm = armed();
    if (!tm) break;
    assert.ok(tm.ms >= MIN_REARM_MS);
    timer = null;
    tm.fn();
  }
  assert.equal(runs.length, 2);
});

test("maxRuns ends the schedule and keeps its history", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 }, { maxRuns: 3 });
  assert.equal(s.maxRuns, 3);
  assert.equal(s.nextRuns.length, 3);
  assert.equal((await scheduleRecurring(plainThread().id, { kind: "interval", everyMinutes: 1 }, { maxRuns: 2 })).nextRuns.length, 2, "nextRuns stops at maxRuns");
  await serve("DELETE", `/schedules/${listSchedules().find((x) => x.maxRuns === 2)!.id}`);

  for (let n = 1; n <= 3; n++) {
    elapse(MIN);
    assert.equal(runs.length, n);
    await endAll();
  }
  const done = getSchedule(s.id)!;
  assert.equal(done.enabled, false);
  assert.equal(done.nextRunAt, null);
  assert.equal(done.runCount, 3);
  assert.deepEqual(started(done).map((h) => h.turnOutcome), ["done", "done", "done"], "the history is kept");
  assert.equal(timer, null, "nothing left to arm");
  elapse(10 * MIN);
  assert.equal(runs.length, 3, "no fourth");

  // A run now counts toward maxRuns too.
  const other = await scheduleRecurring(plainThread().id, { kind: "interval", everyMinutes: 60 }, { maxRuns: 2 });
  await serve("POST", `/schedules/${other.id}/run`);
  assert.equal(getSchedule(other.id)!.nextRunAt, other.nextRunAt, "a run now leaves the next run be");
  await serve("POST", `/schedules/${other.id}/run`);
  assert.equal(getSchedule(other.id)!.enabled, false);
  assert.equal(getSchedule(other.id)!.nextRunAt, null);

  // A once can't have maxRuns or endsAt; maxRuns must be a whole number ≥ 1.
  const once = { name: "P", prompt: "p", when: { kind: "once", at: atIso(now + MIN) }, target: { kind: "thread", threadId: thread.id } };
  assert.match((await serve("POST", "/schedules", { ...once, maxRuns: 2 })).body.error, /cron and interval/);
  for (const maxRuns of [0, -1, 1.5, "3"]) {
    const r = await serve("POST", "/schedules", { ...once, when: { kind: "interval", everyMinutes: 5 }, maxRuns });
    assert.equal(r.status, 400, String(maxRuns));
    assert.match(r.body.error, /maxRuns/);
  }
});

test("endsAt ends the schedule without firing", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const made = now;
  // Runs at +1 and +2 min; the one at +3 would be past endsAt.
  const s = await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 }, { endsAt: atIso(made + 150_000) });
  assert.deepEqual(s.nextRuns, [atIso(made + MIN), atIso(made + 2 * MIN)]);
  elapse(MIN);
  await endAll();
  elapse(MIN);
  await endAll();
  let got = getSchedule(s.id)!;
  assert.equal(runs.length, 2);
  assert.equal(got.enabled, false, "ended at the last run before endsAt");
  assert.equal(got.nextRunAt, null);

  // endsAt already past when a fire comes due (it waited): it ends, and fires nothing.
  const other = plainThread("Other");
  const late = await scheduleRecurring(other.id, { kind: "interval", everyMinutes: 1 }, { endsAt: atIso(now + 90_000) });
  stopScheduler(); // a stalled process: the timer goes off late
  now += 100_000;
  startScheduler(ALL_AGENTS);
  got = getSchedule(late.id)!;
  assert.equal(got.enabled, false);
  assert.equal(got.nextRunAt, null);
  assert.equal(runs.length, 2, "nothing fired");
  assert.deepEqual(got.history, [{ at: late.nextRunAt, outcome: "missed", missedCount: 1 }]);

  // Through the timer, not a restart: a fire held past endsAt.
  const third = await scheduleRecurring(other.id, { kind: "interval", everyMinutes: 1 }, { endsAt: atIso(now + 90_000) });
  now += 95_000; // the tick runs late, past endsAt
  advanceTo(now);
  got = getSchedule(third.id)!;
  assert.equal(got.enabled, false);
  assert.equal(started(got).length, 0);
  assert.equal(runs.length, 2);

  // Refused: endsAt not after the first run, or not a time.
  const body = { name: "P", prompt: "p", when: { kind: "interval", everyMinutes: 5 }, target: { kind: "thread", threadId: thread.id } };
  assert.match((await serve("POST", "/schedules", { ...body, endsAt: atIso(now + 5 * MIN) })).body.error, /after the first run/);
  assert.match((await serve("POST", "/schedules", { ...body, endsAt: "soon" })).body.error, /endsAt must be an ISO/);
});

test("a gap under one minute is refused for interval and cron", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const body = (when: unknown) => ({ name: "P", prompt: "p", when, target: { kind: "thread", threadId: thread.id } });
  for (const everyMinutes of [0, 0.5, -1]) {
    const r = await serve("POST", "/schedules", body({ kind: "interval", everyMinutes }));
    assert.equal(r.status, 400, String(everyMinutes));
    assert.match(r.body.error, everyMinutes === 0.5 ? /whole number/ : /at least 1/);
  }
  // Seconds are the only way below a minute in cron, so 6 fields are refused...
  const sixField = await serve("POST", "/schedules", body({ kind: "cron", expr: "*/30 * * * * *", tz: "UTC" }));
  assert.equal(sixField.status, 400);
  assert.match(sixField.body.error, /6 fields/);
  // ...and the closest gap of a 5-field one is measured with croner: never under a minute.
  const at = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(minGapMinutes({ kind: "cron", expr: "* * * * *", tz: "UTC" }, at), 1);
  assert.equal(minGapMinutes({ kind: "cron", expr: "*/2 * * * *", tz: "Europe/London" }, at), 2);
  assert.equal(minGapMinutes({ kind: "cron", expr: "0,1 9 * * *", tz: "UTC" }, at), 1, "the closest pair, not the usual gap");
  assert.equal(minGapMinutes({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }, at), 24 * 60);
  assert.equal(minGapMinutes({ kind: "cron", expr: "* * * * *", tz: "Europe/London" }, Date.parse("2026-10-25T00:30:00Z")), 1, "across fall-back, still 1");
  // Exactly 1 is allowed.
  assert.equal((await serve("POST", "/schedules", body({ kind: "interval", everyMinutes: 1 }))).status, 200);
  assert.equal((await serve("POST", "/schedules", body({ kind: "cron", expr: "* * * * *", tz: "UTC" }))).status, 200);
});

test("six-field cron, bad expressions and unknown timezones are refused", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const refused = async (when: unknown, pattern: RegExp) => {
    const r = await serve("POST", "/schedules", { name: "P", prompt: "p", when, target: { kind: "thread", threadId: thread.id } });
    assert.equal(r.status, 400, JSON.stringify(when));
    assert.match(r.body.error, pattern);
  };
  await refused({ kind: "cron", expr: "* * * * * *", tz: "UTC" }, /6 fields.*seconds/);
  await refused({ kind: "cron", expr: "0 0 9 * * * 2027", tz: "UTC" }, /7 fields/);
  await refused({ kind: "cron", expr: "bogus", tz: "UTC" }, /1 field: use a 5-field cron pattern/);
  await refused({ kind: "cron", expr: "0 9 * *", tz: "UTC" }, /4 fields: use a 5-field/);
  await refused({ kind: "cron", expr: "0 9 * * * * * *", tz: "UTC" }, /8 fields: use a 5-field/);
  await refused({ kind: "cron", expr: "@sometimes", tz: "UTC" }, /not a valid cron pattern/);
  await refused({ kind: "cron", expr: "61 * * * *", tz: "UTC" }, /not a valid cron pattern/);
  await refused({ kind: "cron", expr: "*/0 * * * *", tz: "UTC" }, /not a valid cron pattern/);
  await refused({ kind: "cron", expr: "@reboot", tz: "UTC" }, /not a valid cron pattern/);
  // croner would read this as a one-off date.
  await refused({ kind: "cron", expr: "2026-10-20T10:00", tz: "UTC" }, /1 field/);
  await refused({ kind: "cron", expr: "0 9 * * 2026-10-20T10:00", tz: "UTC" }, /not a valid cron pattern/);
  await refused({ kind: "cron", expr: "0 0 31 2 *", tz: "UTC" }, /never comes due/);
  await refused({ kind: "cron", expr: "", tz: "UTC" }, /expr is required/);
  await refused({ kind: "cron", expr: "x".repeat(101), tz: "UTC" }, /at most 100/);
  await refused({ kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus_Mons" }, /not a known IANA timezone/);
  await refused({ kind: "cron", expr: "0 9 * * *", tz: "" }, /not a known IANA timezone/);
  await refused({ kind: "cron", expr: "0 9 * * *", tz: 5 }, /not a known IANA timezone/);
  await refused({ kind: "interval", everyMinutes: 5, anchor: "yesterday" }, /anchor must be an ISO/);
  await refused({ kind: "interval", everyMinutes: 527_041 }, /at most/);
  await refused({ kind: "interval" }, /whole number/);
  // Extra spaces are fine, and stored tidied; nicknames are 5-field patterns.
  const ok = await serve("POST", "/schedules", { name: "P", prompt: "p", when: { kind: "cron", expr: "  0  9 * *   1-5 ", tz: "UTC" }, target: { kind: "thread", threadId: thread.id } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.when.expr, "0 9 * * 1-5");
  assert.equal((await serve("POST", "/schedules", { name: "P", prompt: "p", when: { kind: "cron", expr: "@hourly", tz: "UTC" }, target: { kind: "thread", threadId: thread.id } })).status, 200);
});

test("missed runs at startup: one entry with a count, next run moved forward, nothing fired", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const made = now;
  const s = await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 });
  elapse(MIN);
  assert.equal(runs.length, 1);
  await endAll();

  // Down from +1:10 to +3:40: the runs at +2 and +3 pass.
  elapse(10_000);
  stopScheduler();
  timer = null;
  now = made + 3 * MIN + 40_000;
  startScheduler(ALL_AGENTS);
  let got = getSchedule(s.id)!;
  assert.equal(runs.length, 1, "no burst after the restart");
  assert.deepEqual(got.history.at(-1), { at: atIso(made + 2 * MIN), outcome: "missed", missedCount: 2 });
  assert.equal(got.history.filter((h) => h.outcome === "missed").length, 1, "one entry");
  assert.equal(got.nextRunAt, atIso(made + 4 * MIN), "the next run on the anchor's grid");
  assert.equal(got.runCount, 3, "1 run + 2 missed");
  assert.equal(got.enabled, true);
  assert.equal(armed()?.ms, 20_000);

  elapse(20_000);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].scheduled?.run, 4);
  await endAll();

  // A cron, the same way.
  stopScheduler();
  timer = null;
  const cronThread = plainThread("Cron");
  startScheduler(ALL_AGENTS);
  now = Date.parse("2026-10-14T12:00:30Z");
  const cron = await scheduleRecurring(cronThread.id, { kind: "cron", expr: "*/5 * * * *", tz: "Asia/Kolkata" });
  stopScheduler();
  timer = null;
  now = Date.parse("2026-10-14T12:31:00Z"); // 12:05 … 12:30 passed: 6 runs
  startScheduler(ALL_AGENTS);
  got = getSchedule(cron.id)!;
  assert.deepEqual(got.history, [{ at: "2026-10-14T12:05:00.000Z", outcome: "missed", missedCount: 6 }]);
  assert.equal(got.nextRunAt, "2026-10-14T12:35:00.000Z");
  assert.equal(runs.length, 2);
});

test("missed runs count toward maxRuns", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 }, { maxRuns: 3 });
  stopScheduler();
  timer = null;
  now += 10 * MIN; // 10 came due; only 3 ever could
  startScheduler(ALL_AGENTS);
  const got = getSchedule(s.id)!;
  assert.deepEqual(got.history, [{ at: s.nextRunAt, outcome: "missed", missedCount: 3 }]);
  assert.equal(got.runCount, 3);
  assert.equal(got.enabled, false);
  assert.equal(got.nextRunAt, null);
  assert.equal(runs.length, 0);
  assert.equal(timer, null);

  // One run, then down: 2 missed end it.
  const other = await scheduleRecurring(plainThread().id, { kind: "interval", everyMinutes: 1 }, { maxRuns: 3 });
  elapse(MIN);
  assert.equal(runs.length, 1);
  await endAll();
  stopScheduler();
  timer = null;
  now += 5 * MIN;
  startScheduler(ALL_AGENTS);
  const ended = getSchedule(other.id)!;
  assert.equal(ended.history.at(-1)?.missedCount, 2);
  assert.equal(ended.runCount, 3);
  assert.equal(ended.enabled, false);
});

test("a long downtime is counted without walking every missed run", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const s = await scheduleRecurring(thread.id, { kind: "cron", expr: "* * * * *", tz: "Europe/London" });
  const i = await scheduleRecurring(plainThread().id, { kind: "interval", everyMinutes: 1 });
  stopScheduler();
  timer = null;
  now += 30 * 24 * 60 * MIN; // a month
  const before = performance.now();
  startScheduler(ALL_AGENTS);
  const took = performance.now() - before;
  assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
  const cron = getSchedule(s.id)!;
  const missed = cron.history[0].missedCount!;
  // 30 days of minutes, less the hour London repeats on 25 October, which runs once.
  assert.ok(Math.abs(missed - (30 * 24 * 60 - 60)) <= 2, `estimated ${missed}`);
  assert.ok(Date.parse(cron.nextRunAt!) > now);
  assert.equal(getSchedule(i.id)!.history[0].missedCount, 30 * 24 * 60, "an interval's count is exact");
  assert.equal(runs.length, 0);
});

test("a sixth start in a minute is delayed, unclaimed, then fires with delayedMs", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const threads = Array.from({ length: 6 }, (_, k) => plainThread(`T${k}`));
  const at = now + 30_000;
  const made: Schedule[] = [];
  for (const th of threads) made.push(await scheduleOnce(th.id, 30_000));
  assert.equal(RATE_CAP_STARTS, 5);
  advanceTo(at);
  assert.equal(runs.length, 5, "five start");
  const sixth = made.find((s) => getSchedule(s.id)!.runCount === 0)!;
  let held = getSchedule(sixth.id)!;
  assert.equal(held.runCount, 0, "not claimed");
  assert.equal(held.nextRunAt, atIso(at), "still due");
  assert.equal(held.enabled, true);
  assert.deepEqual(held.history, []);
  assert.equal(armed()?.ms, RATE_RETRY_MS, "retried in 10 s");
  assert.ok(logs.mock.calls.some((c) => String(c.arguments[0]).startsWith("[scheduler] rate cap")));

  // Still within the minute: still held, never more than 10 s between tries.
  for (let k = 0; k < 5; k++) {
    elapse(RATE_RETRY_MS);
    assert.equal(runs.length, 5);
    assert.ok(armed()!.ms <= RATE_RETRY_MS);
  }
  assert.equal(getSchedule(sixth.id)!.runCount, 0);
  // The minute after the first start, it starts.
  elapse(RATE_RETRY_MS);
  assert.equal(runs.length, 6);
  held = getSchedule(sixth.id)!;
  assert.equal(held.runCount, 1);
  const run = held.history[0];
  assert.equal(run.outcome, "started");
  assert.equal(run.delayedMs, now - at);
  assert.ok(run.delayedMs! >= RATE_WINDOW_MS);
  for (const s of made) if (s.id !== sixth.id) assert.equal(getSchedule(s.id)!.history[0].delayedMs, undefined, "only the held one");
});

test("the rate cap counts starts, not fires that were skipped or failed", async (t) => {
  t.mock.method(console, "log", () => {});
  // Five busy targets skip; a sixth, idle, still starts at once.
  const busy = Array.from({ length: 5 }, (_, k) => plainThread(`Busy${k}`));
  for (const th of busy) {
    const r = await serve("POST", "/chat", { threadId: th.id, prompt: "work" });
    assert.equal(r.status, 200);
  }
  const userTurns = runs.length;
  const idle = plainThread("Idle");
  for (const th of busy) await scheduleOnce(th.id, 30_000);
  const last = await scheduleOnce(idle.id, 30_000);
  advanceTo(now + 30_000);
  assert.equal(runs.length, userTurns + 1);
  assert.equal(getSchedule(last.id)!.history[0].outcome, "started");
  assert.equal(listSchedules().filter((s) => s.history[0]?.outcome === "skipped-busy").length, 5);
});

test("an over-cap fire caught by a restart is recorded missed", async (t) => {
  t.mock.method(console, "log", () => {});
  const threads = Array.from({ length: 6 }, (_, k) => plainThread(`T${k}`));
  const made: Schedule[] = [];
  for (const th of threads) made.push(await scheduleOnce(th.id, 30_000));
  const interval = await scheduleRecurring(plainThread("I").id, { kind: "interval", everyMinutes: 1 });
  elapse(30_000);
  assert.equal(runs.length, 5);
  elapse(30_000); // the interval comes due too, and waits
  assert.equal(runs.length, 5);
  const heldOnce = made.find((s) => getSchedule(s.id)!.runCount === 0)!;
  assert.equal(getSchedule(interval.id)!.runCount, 0);

  stopScheduler();
  timer = null;
  now += 5_000;
  startScheduler(ALL_AGENTS);
  const once = getSchedule(heldOnce.id)!;
  assert.deepEqual(once.history, [{ at: heldOnce.nextRunAt, outcome: "missed", missedCount: 1 }], "never a silent loss");
  assert.equal(once.enabled, false);
  const rec = getSchedule(interval.id)!;
  assert.deepEqual(rec.history, [{ at: interval.nextRunAt, outcome: "missed", missedCount: 1 }]);
  assert.ok(Date.parse(rec.nextRunAt!) > now);
  assert.equal(runs.length, 5);
});

test("the timer never sleeps more than 60s, or 10s while over the cap", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  now = Date.parse("2026-10-14T12:00:30Z");
  await scheduleRecurring(thread.id, { kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  assert.equal(armed()?.ms, TIMER_CAP_MS, "21 hours away: 60 s");
  // Every wake-up on the way re-arms at most 60 s, and only one timer is ever live.
  let wakes = 0;
  const cancelled: boolean[] = [];
  const realSet = schedulerClock.setTimer;
  schedulerClock.setTimer = (fn, ms) => {
    if (timer) cancelled.push(timer.cancelled);
    return realSet(fn, ms);
  };
  try {
    for (let k = 0; k < 30; k++) {
      assert.ok(armed()!.ms <= TIMER_CAP_MS);
      elapse(armed()!.ms);
      wakes++;
    }
  } finally {
    schedulerClock.setTimer = realSet;
  }
  assert.equal(wakes, 30);
  assert.ok(cancelled.every(Boolean), "a timer is replaced only after it is cancelled or has gone off");

  // Over the cap, with something due: at most 10 s, and at least the floor.
  const threads = Array.from({ length: 7 }, (_, k) => plainThread(`T${k}`));
  for (const th of threads.slice(0, 6)) await scheduleOnce(th.id, 5_000);
  elapse(5_000);
  assert.equal(runs.length, 5);
  assert.equal(armed()!.ms, RATE_RETRY_MS);
  elapse(50_000);
  assert.equal(runs.length, 5);
  elapse(10_000);
  assert.equal(runs.length, 6, "60 s after the first five started");

  // When the window frees sooner than 10 s, it wakes then (never under the floor).
  await endAll();
  const t0 = now;
  for (const th of threads.slice(0, 5)) await serve("POST", `/schedules/${(await scheduleOnce(th.id, 3_600_000)).id}/run`);
  assert.equal(runs.length, 11, "runs now are never held");
  await scheduleOnce(threads[6].id, 57_000);
  elapse(57_000);
  assert.equal(runs.length, 11, "the cap is full: 5 starts (runs now) in the minute");
  assert.equal(armed()!.ms, t0 + RATE_WINDOW_MS - now, "3 s: when the first of them leaves the window");
  elapse(3_000);
  assert.equal(runs.length, 12);
});

test("deleting a schedule the rate cap is holding means it never fires", async (t) => {
  t.mock.method(console, "log", () => {});
  const threads = Array.from({ length: 6 }, (_, k) => plainThread(`T${k}`));
  const made: Schedule[] = [];
  for (const th of threads) made.push(await scheduleOnce(th.id, 30_000));
  elapse(30_000);
  const held = made.find((s) => getSchedule(s.id)!.runCount === 0)!;
  assert.equal((await serve("DELETE", `/schedules/${held.id}`)).status, 200);
  elapse(2 * MIN);
  assert.equal(runs.length, 5);
  assert.ok(!armed() || armed()!.cancelled, "nothing left to arm");
});

// --- Review fixes (02) ---

test("a fire found long overdue while running (suspended, stalled, clock jumped) is missed, never fired late", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const made = now;
  const s = await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 });
  const once = await scheduleOnce(plainThread("Once").id, 90_000);
  // The process sleeps for 3 hours; on waking, the armed timer goes off once.
  now = made + 3 * 60 * MIN + 20_000;
  const tm = armed()!;
  timer = null;
  tm.fn();
  assert.equal(runs.length, 0, "nothing fired late");
  const got = getSchedule(s.id)!;
  assert.deepEqual(got.history, [{ at: atIso(made + MIN), outcome: "missed", missedCount: 180 }]);
  assert.equal(got.nextRunAt, atIso(made + 181 * MIN), "the next run, after now, on the grid");
  assert.equal(got.runCount, 180);
  const o = getSchedule(once.id)!;
  assert.deepEqual(o.history, [{ at: once.nextRunAt, outcome: "missed", missedCount: 1 }]);
  assert.equal(o.enabled, false);
  // And it runs on from there.
  elapse(40_000);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduled?.run, 181);

  // A little late (within the grace: a timer that woke late) still fires.
  await endAll();
  const due = Date.parse(getSchedule(s.id)!.nextRunAt!);
  now = due + LATE_GRACE_MS - 1000;
  const tm2 = armed()!;
  timer = null;
  tm2.fn();
  assert.equal(runs.length, 2);
  assert.equal(LATE_GRACE_MS, TIMER_CAP_MS + RATE_RETRY_MS);
});

test("a fire held by the rate cap fires however late, with the runs it waited past recorded after it", async (t) => {
  t.mock.method(console, "log", () => {});
  // Eleven onces at one time: 5 start, then 5 a minute later, then the last a minute after that.
  const made: Schedule[] = [];
  for (let k = 0; k < 11; k++) made.push(await scheduleOnce(plainThread(`T${k}`).id, 30_000));
  const at = now + 30_000;
  // And a 1-minute interval due a moment after them, which waits behind them.
  const interval = await scheduleRecurring(plainThread("I").id, { kind: "interval", everyMinutes: 1, anchor: atIso(at + 1000 - MIN) });
  elapse(30_000 + 1000);
  assert.equal(runs.length, 5);
  elapse(2 * MIN + 10_000);
  assert.equal(runs.length, 12, "every held fire ran, none dropped");
  const last = made.map((s) => getSchedule(s.id)!).find((s) => s.history[0].delayedMs! > LATE_GRACE_MS);
  assert.ok(last, "a held once ran more than the grace late, and still ran");
  const iv = getSchedule(interval.id)!;
  const [first, ...rest] = iv.history;
  assert.equal(first.outcome, "started");
  assert.ok(first.delayedMs! > MIN, `${first.delayedMs}`);
  // Due at +1 s, it started about 2 min late; the run due at +61 s passed meanwhile.
  assert.equal(rest[0].outcome, "missed", "the run it waited past comes after the started entry");
  assert.equal(rest[0].at, atIso(at + 1000 + MIN), "after the run that started, in due order");
  assert.equal(rest[0].missedCount, 1);
  // And the run due at +121 s found room, but its thread still busy with the late run.
  assert.equal(rest[1].outcome, "skipped-busy");
  assert.equal(rest[1].delayedMs, undefined);
  assert.equal(iv.runCount, 3, "2 runs + 1 missed");
  assert.ok(Date.parse(iv.nextRunAt!) > now);
});

test("a held 1-minute interval that fires a minute late records run 1, delayedMs, then one missed", async (t) => {
  t.mock.method(console, "log", () => {});
  for (let k = 0; k < 5; k++) await scheduleOnce(plainThread(`T${k}`).id, 30_000);
  const made = now;
  const s = await scheduleRecurring(plainThread("I").id, { kind: "interval", everyMinutes: 1, anchor: atIso(made + 30_000 - MIN) });
  elapse(30_000);
  assert.equal(runs.length, 5);
  assert.equal(getSchedule(s.id)!.runCount, 0, "held");
  elapse(60_000);
  assert.equal(runs.length, 6);
  const got = getSchedule(s.id)!;
  assert.deepEqual(got.history.map((h) => h.outcome), ["started", "missed"]);
  assert.equal(got.history[0].delayedMs, 60_000);
  assert.equal(runs[5].scheduled?.run, 1);
  assert.deepEqual(got.history[1], { at: atIso(made + 30_000 + MIN), outcome: "missed", missedCount: 1 });
  assert.equal(got.runCount, 2);
  assert.equal(got.nextRunAt, atIso(made + 30_000 + 2 * MIN));
});

test("a create while a fire is held re-arms at once, then never sooner than the floor", async (t) => {
  t.mock.method(console, "log", () => {});
  const threads = Array.from({ length: 6 }, (_, k) => plainThread(`T${k}`));
  for (const th of threads) await scheduleOnce(th.id, 30_000);
  elapse(30_000);
  assert.equal(runs.length, 5);
  await scheduleOnce(plainThread("Later").id, 3_600_000);
  assert.equal(armed()?.ms, 0, "a route re-arms with no floor");
  const tm = armed()!;
  timer = null;
  tm.fn();
  assert.equal(runs.length, 5, "still held");
  assert.ok(armed()!.ms >= MIN_REARM_MS && armed()!.ms <= RATE_RETRY_MS);
});

test("a restart keeps the rate window: starts just before it still count", async (t) => {
  t.mock.method(console, "log", () => {});
  for (let k = 0; k < 5; k++) await scheduleOnce(plainThread(`T${k}`).id, 30_000);
  elapse(30_000);
  assert.equal(runs.length, 5);
  await endAll();
  const sixth = await scheduleOnce(plainThread("Six").id, 15_000);
  stopScheduler();
  timer = null;
  now += 10_000;
  startScheduler(ALL_AGENTS);
  elapse(5_000);
  assert.equal(getSchedule(sixth.id)!.runCount, 0, "held: five started 15 s ago, before the restart");
  elapse(45_000);
  assert.equal(getSchedule(sixth.id)!.history[0].outcome, "started");
  assert.ok(getSchedule(sixth.id)!.history[0].delayedMs! > 0);
});

test("timezones must be IANA region names, stored canonical", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const post = (tz: unknown) => serve("POST", "/schedules", { name: "P", prompt: "p", when: { kind: "cron", expr: "0 9 * * *", tz }, target: { kind: "thread", threadId: thread.id } });
  for (const tz of ["+05:30", "-0400", "+5"]) {
    const r = await post(tz);
    assert.equal(r.status, 400, tz);
    assert.match(r.body.error, /fixed offset|not a known/);
  }
  for (const tz of ["EST", "IST", "CET", "PST8PDT"]) {
    const r = await post(tz);
    assert.equal(r.status, 400, tz);
    assert.match(r.body.error, /abbreviation|not a known/);
  }
  for (const [tz, stored] of [["utc", "UTC"], ["GMT", "UTC"], ["US/Eastern", "America/New_York"], ["Europe/London", "Europe/London"]]) {
    const r = await post(tz);
    assert.equal(r.status, 200, `${tz}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.when.tz, stored, tz);
  }
});

test("cron across DST in more zones (southern, 30-minute, midnight changes): forward, once per wall time", async (t) => {
  t.mock.method(console, "warn", () => {});
  const offsetAt = (ms: number, tz: string) => {
    const p: Record<string, number> = {};
    for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(ms)) {
      if (x.type !== "literal") p[x.type] = Number(x.value);
    }
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MIN) * MIN;
  };
  /** Every 2026 offset change in a zone, to the minute. */
  const changes = (tz: string) => {
    const out: number[] = [];
    const step = 6 * 60 * MIN;
    for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2027-01-01T00:00:00Z"); t += step) {
      if (offsetAt(t, tz) === offsetAt(t + step, tz)) continue;
      let lo = t;
      let hi = t + step;
      while (hi - lo > MIN) {
        const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN;
        if (offsetAt(mid, tz) === offsetAt(lo, tz)) lo = mid; else hi = mid;
      }
      out.push(hi);
    }
    return out;
  };
  const wall = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(ms);
  const zones = ["Australia/Lord_Howe", "America/Santiago", "Australia/Sydney", "Europe/London", "America/New_York"];
  const patterns = ["*/15 * * * *", "30 1 * * *", "0 0 * * *", "45 2 * * *"];
  let cases = 0;
  for (const tz of zones) {
    const found = changes(tz);
    assert.equal(found.length, 2, `${tz}: two changes in 2026`);
    for (const change of found) {
      for (const expr of patterns) {
        const when = { kind: "cron", expr, tz } as const;
        const end = change + 36 * 60 * MIN;
        const seen = new Set<string>();
        let prev = change - 36 * 60 * MIN;
        for (let i = 0; i < 1000; i++) {
          const next = nextOccurrence(when, prev);
          assert.ok(next != null, `${tz} ${expr}: a next run`);
          assert.ok(next! > prev, `${tz} ${expr}: forward from ${atIso(prev)}`);
          if (next! > end) break;
          const w = wall(next!, tz);
          assert.ok(!seen.has(w), `${tz} ${expr}: ${w} twice`);
          seen.add(w);
          // No gap longer than the pattern's own plus the shift (at most an hour).
          const most = expr.startsWith("*/15") ? 15 * MIN : 24 * 60 * MIN;
          assert.ok(next! - prev <= most + 60 * MIN || i === 0, `${tz} ${expr}: gap ${(next! - prev) / MIN} min at ${atIso(next!)}`);
          prev = next!;
        }
        cases++;
      }
    }
  }
  assert.equal(cases, zones.length * 2 * patterns.length);
  // Lord Howe's shift is 30 minutes; a */15 cron there loses or repeats only that half hour.
  const lh = changes("Australia/Lord_Howe");
  assert.equal(Math.abs(offsetAt(lh[0] + MIN, "Australia/Lord_Howe") - offsetAt(lh[0] - MIN, "Australia/Lord_Howe")), 30 * MIN);
});

test("a missed count stops at maxRuns, on every counting path", () => {
  const minute = { kind: "cron", expr: "* * * * *", tz: "Europe/London" } as const;
  const from = Date.parse("2026-10-14T12:00:00Z");
  // Exact (through croner), wall clock, and estimated: each capped.
  for (const [span, max] of [[10, 5], [100, 60], [100_000, 700], [100_000, 99_000]]) {
    const r = countOccurrences(minute, from, from + span * MIN, max);
    assert.equal(r.count, Math.min(max, span + 1), `${span} min, max ${max}`);
  }
  // Uncapped: exact for a few, then on the wall clock.
  assert.deepEqual(countOccurrences(minute, from, from + 9 * MIN), { count: 10, estimated: false });
  assert.deepEqual(countOccurrences(minute, from, from + 300 * MIN), { count: 301, estimated: true });
  const interval = { kind: "interval", everyMinutes: 1, anchor: atIso(from) } as const;
  assert.deepEqual(countOccurrences(interval, from, from + 100_000 * MIN, 700), { count: 700, estimated: false });
});

test("startup after a long downtime stays quick with a hundred long-missed crons", async (t) => {
  t.mock.method(console, "log", () => {});
  stopScheduler();
  timer = null;
  const thread = plainThread("Demo");
  const many = Array.from({ length: 100 }, (_, k) =>
    foreignSchedule(thread.id, { id: `many-${k}`, when: { kind: "cron", expr: k % 2 ? "* * * * *" : "*/2 * * * *", tz: "Europe/London" }, nextRunAt: atIso(now - 9 * 60 * MIN) }));
  writeFileSync(schedulesFile(), JSON.stringify(many, null, 2));
  const before = performance.now();
  startScheduler(ALL_AGENTS);
  const took = performance.now() - before;
  assert.ok(took < 3_000, `took ${Math.round(took)} ms`);
  const counts = listSchedules().map((s) => s.history[0].missedCount!);
  assert.ok(counts.every((c, k) => Math.abs(c - (k % 2 ? 541 : 271)) <= 2), counts.slice(0, 4).join(","));
  t.diagnostic(`100 crons, 9 h missed: ${Math.round(took)} ms`);
});

// --- Re-review fixes (02) ---

test("a missed count ending inside the repeated autumn hour is exact at the end", (t) => {
  t.mock.method(console, "warn", () => {});
  const minute = { kind: "cron", expr: "* * * * *", tz: "Europe/London" } as const;
  // Down from 23:00Z on 24 October; London repeats 01:xx on the 25th (00:00Z-01:59Z).
  // croner ran every wall minute 00:00-01:59 BST once, then skips the GMT repeat.
  const first = Date.parse("2026-10-24T23:00:00Z");
  const exact = (last: number) => {
    let n = 1;
    let t = first;
    for (;;) {
      const next = nextOccurrence(minute, t);
      if (next == null || next > last) return n;
      n++;
      t = next;
    }
  };
  for (const restart of ["2026-10-25T01:10:00Z", "2026-10-25T01:50:00Z", "2026-10-25T03:30:00Z"]) {
    const last = Date.parse(restart);
    assert.equal(countOccurrences(minute, first, last).count, exact(last), restart);
  }
  assert.equal(countOccurrences(minute, first, Date.parse("2026-10-25T01:10:00Z")).count, 120);
  // A long span ending there: the middle is on the wall clock, the end exact.
  const longFirst = Date.parse("2026-10-23T12:00:00Z");
  const long = countOccurrences(minute, longFirst, Date.parse("2026-10-25T01:10:00Z"));
  assert.equal(long.estimated, true);
  assert.ok(Math.abs(long.count - (36 * 60 + 60 + 1)) <= 1, `${long.count}`); // 12:00Z..00:59Z, all of BST 01:xx once
});

test("Etc/GMT±N and other fixed-offset Etc zones are refused; Etc/UTC is stored as UTC", async (t) => {
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  const post = (tz: string) => serve("POST", "/schedules", { name: "P", prompt: "p", when: { kind: "cron", expr: "0 9 * * *", tz }, target: { kind: "thread", threadId: thread.id } });
  for (const tz of ["Etc/GMT+5", "Etc/GMT-14", "etc/gmt+5", "Etc/GMT+0"]) {
    const r = await post(tz);
    if (r.status === 200) assert.equal(r.body.when.tz, "UTC", `${tz} is UTC itself`);
    else assert.match(r.body.error, /fixed offset/, tz);
  }
  assert.equal((await post("Etc/GMT+5")).status, 400);
  for (const tz of ["Etc/UTC", "Etc/GMT", "Etc/Universal", "Etc/Zulu"]) {
    const r = await post(tz);
    assert.equal(r.status, 200, tz);
    assert.equal(r.body.when.tz, "UTC", tz);
  }
});

test("a missed record that keeps failing to save is logged again once a minute", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const thread = plainThread("Demo");
  await scheduleRecurring(thread.id, { kind: "interval", everyMinutes: 1 });
  stopScheduler();
  timer = null;
  now += 3 * MIN;
  blockWrites();
  try {
    startScheduler(ALL_AGENTS);
    const stuck = () => errors.mock.calls.filter((c) => String(c.arguments[0]).includes("still can't record")).length;
    elapse(50_000);
    assert.equal(stuck(), 0, "not every 10 s");
    elapse(10_000);
    assert.equal(stuck(), 1, "a minute after boot");
    elapse(60_000);
    assert.equal(stuck(), 2);
    assert.equal(runs.length, 0);
  } finally {
    unblockWrites();
  }
});
