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
import { ERROR_BACKOFF_MS, MIN_REARM_MS, schedulerClock, startScheduler, stopScheduler, TIMER_CAP_MS } from "../src/scheduler";
import { createSchedule, getSchedule, listSchedules, SCHEDULES_MAX, SCHEDULES_PER_THREAD_MAX, updateSchedule, type Schedule } from "../src/schedules";
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
  assert.equal(got.runCount, 0);
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
  await refused({ ...good, when: { kind: "cron", expr: "0 9 * * *", tz: "UTC" } }, /not supported yet/);
  await refused({ ...good, when: { kind: "interval", everyMinutes: 5 } }, /not supported yet/);
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
  const cron = foreignSchedule(thread.id, {});
  const interval = foreignSchedule(thread.id, { when: { kind: "interval", everyMinutes: 5, anchor: atIso(now) } });
  const newThread = foreignSchedule(thread.id, { when: { kind: "once", at: atIso(now - 1000) }, target: { kind: "new-thread", botId: "b", projectId: "p" } });
  stopScheduler();
  timer = null;
  writeFileSync(schedulesFile(), JSON.stringify([cron, interval, newThread], null, 2));
  startScheduler(ALL_AGENTS);
  assert.equal(timer, null, "nothing to arm a timer for");
  assert.equal(warns.mock.calls.length, 3, "each logged once");

  // Next to a once this build does run, the timer is for the once alone.
  const once = await scheduleOnce(thread.id, 90_000);
  assert.equal(armed()?.ms, TIMER_CAP_MS);
  advanceTo(now + 90_000);
  assert.equal(runs.length, 1, "the once fired, and only it");
  assert.equal(runs[0].scheduled?.id, once.id);
  assert.equal(timer, null, "and nothing re-armed after it");
  for (const s of [cron, interval, newThread]) {
    const left = getSchedule(s.id)!;
    assert.equal(left.runCount, 0);
    assert.deepEqual(left.history, []);
    assert.equal(left.enabled, true);
    assert.equal(left.nextRunAt, s.nextRunAt, "left exactly as it was");
  }
  assert.equal(warns.mock.calls.length, 3, "not logged again");

  // A run now is refused, not fired.
  const r = await serve("POST", `/schedules/${cron.id}/run`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not supported/);
  assert.equal(runs.length, 1);
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
    assert.equal(timer, null, "the missed once is not armed, even though it could not be saved as missed");
  } finally {
    unblockWrites();
  }
  // New schedules still arm the timer and fire.
  const later = await scheduleOnce(thread.id, 30_000);
  assert.equal(armed()?.ms, 30_000);
  advanceTo(now + 30_000);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduled?.id, later.id, "the new one, not the missed one");
  assert.equal(getSchedule(missed.id)!.runCount, 0);
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
