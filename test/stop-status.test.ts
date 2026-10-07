import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBot, createThread, getThread, JARVIS_BOT_ID, jarvisDir, updateThread } from "../src/bot-store";
import { watchThreadActivity } from "../src/attention";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { watchChildReports } from "../src/reports";
import {
  buildSessionsDump,
  emitEvent,
  notifyPermissionsChanged,
  permissionsEmitter,
  sessions,
  type IRequest,
  type IResponse,
  type SessionStore,
  type SessionSummaryItem,
} from "../src/server-common";
import { abortCalls, handleRequest, opencodeStaleEnd } from "../src/server";
import { opencodeLifecycleEvent } from "../src/start-opencode";
import { listThreadsForJarvis, threadStatus } from "../src/thread-tools";
import { agentRunners, startTurn } from "../src/turns";
import { byThread } from "../ui/app/lib/use-thread-sessions";

// Stopping a turn reads as "stopped" everywhere — the UI's stream, thread_status,
// list_threads, the stored lastOutcome — and never wakes Jarvis, however the
// turn then ends.

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- Stubs: turns start and stay running until a test ends them ---

const realRunners = { ...agentRunners };
const realAbortCalls = { ...abortCalls };
let runs: SessionStore[] = [];
const unwatch: Array<() => void> = [];
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
  unwatch.push(watchThreadActivity(), watchChildReports(ALL_AGENTS));
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  Object.assign(abortCalls, realAbortCalls);
});
after(() => {
  for (const u of unwatch) u();
  Object.assign(agentRunners, realRunners);
});

const tick = () => new Promise((r) => setImmediate(r));

async function post(url: string): Promise<{ status: number; body: any }> {
  const req = Object.assign(new EventEmitter(), { method: "POST", url, headers: {} }) as unknown as IRequest;
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
  setImmediate(() => (req as unknown as EventEmitter).emit("end"));
  await done;
  return { status, body: JSON.parse(out || "{}") };
}

/** Every session snapshot the server pushes for a store, in order. */
function recordSnapshots(store: SessionStore): SessionSummaryItem[] {
  const seen: SessionSummaryItem[] = [];
  const listener = (_perms: unknown, dump: SessionSummaryItem[]) => {
    const mine = dump.find((s) => s.gitbotId === store.gitbotId);
    if (mine) seen.push(mine);
  };
  permissionsEmitter.on("update", listener);
  after(() => permissionsEmitter.off("update", listener));
  return seen;
}

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "gitbot-stop-")));
}

/** A thread started by a Jarvis thread, so it would report to it, with its running turn. */
function jarvisChild(agent: "opencode" | "claude-code") {
  const added = addProject(folder());
  assert.ok(added.ok);
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const started = startChildThread(jarvis.id, { agent, project: added.project.id, message: "work" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  return { jarvis, threadId: started.threadId, store: runs[runs.length - 1] };
}

/** What each reader says of a thread's state. */
async function readings(threadId: string, store: SessionStore) {
  const status = await threadStatus(threadId);
  assert.ok(status.ok);
  const listed = listThreadsForJarvis({ bot: getThread(threadId)!.botId });
  assert.ok(listed.ok);
  return {
    stream: byThread(buildSessionsDump()).states[threadId],
    snapshotStopped: buildSessionsDump().find((s) => s.gitbotId === store.gitbotId)?.stopped,
    threadStatus: status.status,
    listThreads: listed.threads.find((t) => t.id === threadId)?.status,
    lastOutcome: getThread(threadId)!.lastOutcome,
  };
}

const STOPPED = { stream: "stopped", snapshotStopped: true, threadStatus: "stopped", listThreads: "stopped", lastOutcome: "stopped" };

const jarvisTurns = (jarvisId: string) => runs.filter((s) => s.threadId === jarvisId);

// --- OpenCode: the turn can end on its own while the abort call is in flight ---

test("an OpenCode stop that races the agent's own end reads stopped in every snapshot", async () => {
  const { jarvis, threadId, store } = jarvisChild("opencode");
  store.sdkSessionId = "oc-race";
  const snapshots = recordSnapshots(store);
  // The reviewer's race: opencode's event loop sees session.idle and ends the
  // turn, broadcasting it, before the abort call returns.
  abortCalls.opencode = async () => {
    emitEvent(store, "assistant", { content: "finished anyway" });
    store.status = "done";
    notifyPermissionsChanged();
    await tick();
  };
  const res = await post(`/sessions/${store.gitbotId}/abort`);
  assert.equal(res.status, 200);
  await tick();

  const ended = snapshots.filter((s) => s.status !== "running");
  assert.ok(ended.length >= 2, "the loop's broadcast and the route's both went out");
  assert.deepEqual(ended.map((s) => s.stopped), ended.map(() => true), "no snapshot ever said done");
  assert.equal(store.events.filter((e) => e.type === "aborted").length, 1);
  assert.deepEqual(await readings(threadId, store), STOPPED);
  assert.equal(jarvisTurns(jarvis.id).length, 0, "a stopped child does not wake Jarvis");
});

test("an OpenCode stop does not end a new turn that started while the abort was in flight", async () => {
  // A thread bound to its opencode session: each turn reuses the one store.
  const bot = createBot({ name: "OC", agent: "opencode" });
  const threadId = createThread(bot.id, folder(), undefined, "chat", "opencode").id;
  updateThread(threadId, { sdkSessionId: "oc-next" });
  const first = startTurn({ threadId, prompt: "go" }, ALL_AGENTS);
  assert.ok(first.ok, JSON.stringify(first));
  const store = sessions.get(first.sessionId)!;
  // (Asserted after the route: it swallows anything the abort call throws.)
  let next: ReturnType<typeof startTurn> | undefined;
  abortCalls.opencode = async () => {
    // opencode ended the stopped turn, and the user sent the next message.
    store.status = "done";
    notifyPermissionsChanged();
    await tick();
    next = startTurn({ threadId, prompt: "carry on" }, ALL_AGENTS);
  };
  await post(`/sessions/${store.gitbotId}/abort`);
  await tick();
  assert.ok(next?.ok, JSON.stringify(next));
  assert.equal(next.sessionId, store.gitbotId, "the same store, a new turn");
  assert.equal(store.status, "running");
  assert.equal(store.abortRequested, false);
  assert.equal(store.events.some((e) => e.type === "aborted"), false);
  assert.equal(byThread(buildSessionsDump()).states[threadId], "running");
});

// --- A stop the server accepted is a stop, however the turn ends ---

test("the agent finishing just as Stop is pressed reads stopped, and does not wake Jarvis", async () => {
  const { jarvis, threadId, store } = jarvisChild("claude-code");
  store.abortController = new AbortController();
  assert.equal((await post(`/sessions/${store.gitbotId}/abort`)).status, 200);
  // The result had already arrived: no AbortError, no "aborted" event.
  emitEvent(store, "assistant", { content: "all done" });
  store.status = "done";
  notifyPermissionsChanged();
  await tick();
  assert.equal(store.events.some((e) => e.type === "aborted"), false);
  assert.deepEqual(await readings(threadId, store), STOPPED);
  assert.equal(jarvisTurns(jarvis.id).length, 0);
});

test("a stream that ends with no result after Stop reads stopped, not failed", async () => {
  const { jarvis, threadId, store } = jarvisChild("claude-code");
  store.abortController = new AbortController();
  await post(`/sessions/${store.gitbotId}/abort`);
  // The SDK closed its stream without throwing: the harness reports an exit.
  emitEvent(store, "error", { message: "Claude process exited unexpectedly" });
  store.status = "error";
  notifyPermissionsChanged();
  await tick();
  assert.deepEqual(await readings(threadId, store), STOPPED);
  assert.equal(jarvisTurns(jarvis.id).length, 0);
});

test("a running turn with a stop in flight still reads running", async () => {
  const { threadId, store } = jarvisChild("claude-code");
  store.abortController = new AbortController();
  await post(`/sessions/${store.gitbotId}/abort`);
  const r = await readings(threadId, store);
  assert.equal(r.stream, "running");
  assert.equal(r.snapshotStopped, false);
  assert.equal(r.threadStatus, "running");
  store.status = "error";
  notifyPermissionsChanged();
  await tick();
});

// --- The next turn starts afresh ---

test("a new turn after a stop clears stopped", async () => {
  const { threadId, store } = jarvisChild("claude-code");
  store.abortController = new AbortController();
  await post(`/sessions/${store.gitbotId}/abort`);
  emitEvent(store, "aborted", { message: "Request aborted by user" });
  store.status = "error";
  notifyPermissionsChanged();
  await tick();
  assert.deepEqual(await readings(threadId, store), STOPPED);

  const next = startTurn({ threadId, prompt: "try again" }, ALL_AGENTS);
  assert.ok(next.ok, JSON.stringify(next));
  const turn = sessions.get(next.sessionId)!;
  let r = await readings(threadId, turn);
  assert.equal(r.stream, "running");
  assert.equal(r.snapshotStopped, false);
  assert.equal(r.threadStatus, "running");

  emitEvent(turn, "assistant", { content: "done this time" });
  turn.status = "done";
  notifyPermissionsChanged();
  await tick();
  r = await readings(threadId, turn);
  assert.deepEqual(r, { stream: "done", snapshotStopped: false, threadStatus: "done", listThreads: "done", lastOutcome: "done" });
});

// --- OpenCode: its ends name the session, not the turn ---

/** A thread bound to its opencode session, with a running turn: each turn reuses the one store. */
function boundOpencode(sdkId: string) {
  const bot = createBot({ name: `OC ${sdkId}`, agent: "opencode" });
  const threadId = createThread(bot.id, folder(), undefined, "chat", "opencode").id;
  updateThread(threadId, { sdkSessionId: sdkId });
  const first = startTurn({ threadId, prompt: "go" }, ALL_AGENTS);
  assert.ok(first.ok, JSON.stringify(first));
  return { threadId, store: sessions.get(first.sessionId)! };
}

const count = (store: SessionStore, type: string) => store.events.filter((e) => e.type === type).length;

test("OpenCode's late end of a stopped turn does not end the next one", async () => {
  const { threadId, store } = boundOpencode("oc-late");
  abortCalls.opencode = async () => {}; // returns before opencode reports the turn over
  await post(`/sessions/${store.gitbotId}/abort`);
  await tick();
  assert.equal(store.status, "done");

  // The user sends the next message at once: a new turn on the same store.
  const next = startTurn({ threadId, prompt: "now this" }, ALL_AGENTS);
  assert.ok(next.ok && next.sessionId === store.gitbotId);
  // opencode's own end of the stopped turn arrives late.
  opencodeLifecycleEvent(store, "session.error", { error: { name: "MessageAbortedError" } });
  opencodeLifecycleEvent(store, "session.status", { status: { type: "idle" } });
  opencodeLifecycleEvent(store, "session.idle", {});
  await tick();
  assert.equal(store.status, "running", "the new turn runs on");
  assert.equal(count(store, "agent_error") + count(store, "done"), 0);
  assert.equal(byThread(buildSessionsDump()).states[threadId], "running");

  // opencode takes the new prompt: from here its ends are this turn's.
  opencodeLifecycleEvent(store, "message.updated", { info: { id: "u2", role: "user" } });
  opencodeLifecycleEvent(store, "session.idle", {});
  await tick();
  assert.equal(store.status, "done");
  assert.equal(count(store, "done"), 1);
  assert.equal(getThread(threadId)!.lastOutcome, "done");
});

test("an error after the turn has ended does not turn it into a failure", async () => {
  const { threadId, store } = boundOpencode("oc-after");
  abortCalls.opencode = async () => {};
  await post(`/sessions/${store.gitbotId}/abort`);
  await tick();
  opencodeLifecycleEvent(store, "session.error", { error: { name: "MessageAbortedError" } });
  assert.equal(store.status, "done");
  assert.equal(count(store, "agent_error"), 0);
  assert.deepEqual(await readings(threadId, store), STOPPED);
});

test("an OpenCode turn's own ends: an error then idle closes it once; idle twice is one end", async () => {
  const failing = boundOpencode("oc-fail").store;
  opencodeLifecycleEvent(failing, "session.error", { error: { data: { message: "rate limited" } } });
  assert.equal(failing.status, "error");
  opencodeLifecycleEvent(failing, "session.idle", {});
  // As before: the idle that follows closes the turn's stream.
  assert.equal(failing.status, "done");
  assert.deepEqual(failing.events.filter((e) => e.type === "agent_error" || e.type === "done").map((e) => e.type), ["agent_error", "done"]);

  const fine = boundOpencode("oc-fine").store;
  opencodeLifecycleEvent(fine, "session.status", { status: { type: "busy" } });
  assert.equal(fine.status, "running");
  opencodeLifecycleEvent(fine, "session.status", { status: { type: "idle" } });
  opencodeLifecycleEvent(fine, "session.idle", {});
  assert.equal(count(fine, "done"), 1);
  // A stray error after its own idle leaves a finished turn finished.
  opencodeLifecycleEvent(fine, "session.error", { error: { name: "UnknownError" } });
  assert.equal(fine.status, "done");
  assert.equal(count(fine, "agent_error"), 0);
  await tick();
});

test("a stop still in flight does not end a later turn that was stopped too", async () => {
  const { threadId, store } = boundOpencode("oc-two-stops");
  let releaseFirst: () => void = () => {};
  let calls = 0;
  abortCalls.opencode = () => {
    calls++;
    if (calls > 1) return Promise.resolve(); // the second stop's call returns at once
    // The first stop's call: opencode ends turn 1, turn 2 starts, and the call hangs.
    store.status = "done";
    notifyPermissionsChanged();
    return new Promise<void>((r) => { releaseFirst = r; });
  };
  const firstStop = post(`/sessions/${store.gitbotId}/abort`);
  await tick(); await tick();
  const next = startTurn({ threadId, prompt: "turn two" }, ALL_AGENTS);
  assert.ok(next.ok && next.sessionId === store.gitbotId);
  const turnTwo = store.turn;
  // The user stops turn 2 too, before the first call has returned.
  assert.equal((await post(`/sessions/${store.gitbotId}/abort`)).status, 200);
  assert.equal(count(store, "aborted"), 1, "turn 2 stopped by its own stop");
  releaseFirst();
  assert.equal((await firstStop).status, 200);
  await tick();
  assert.equal(store.turn, turnTwo);
  assert.equal(count(store, "aborted"), 1, "the first stop did nothing to turn 2");
  assert.deepEqual(await readings(threadId, store), STOPPED);
});

test("after a stop, a next turn OpenCode fails before saving its message still ends", async () => {
  const { threadId, store } = boundOpencode("oc-stuck");
  abortCalls.opencode = async () => {}; // the reply beats opencode's idle events to gitbot
  await post(`/sessions/${store.gitbotId}/abort`);
  await tick();
  assert.notEqual(store.opencodeStaleEnd, undefined, "the race this covers");

  const next = startTurn({ threadId, prompt: "next" }, ALL_AGENTS);
  assert.ok(next.ok && next.sessionId === store.gitbotId);
  // opencode published the stopped turn's idle pair before answering the stop.
  opencodeLifecycleEvent(store, "session.status", { status: { type: "idle" } });
  opencodeLifecycleEvent(store, "session.idle", {});
  assert.equal(store.status, "running", "the stale pair does not end the next turn");
  // Then the next prompt fails before its user message is saved: no
  // message.updated, and no idle after the error.
  opencodeLifecycleEvent(store, "session.error", { error: { name: "UnknownError", data: { message: 'Agent not found: "build"' } } });
  await tick();
  assert.equal(store.status, "error", "the turn ends instead of running forever");
  assert.equal(byThread(buildSessionsDump()).states[threadId], "failed");
  assert.equal(getThread(threadId)!.lastOutcome, "failed");
});

test("after a stop, a lost OpenCode end stops being waited for after a while", async () => {
  const { threadId, store } = boundOpencode("oc-lost");
  abortCalls.opencode = async () => {};
  const realMs = opencodeStaleEnd.ms;
  opencodeStaleEnd.ms = 20;
  try {
    await post(`/sessions/${store.gitbotId}/abort`);
    // opencode's events for the stopped turn never arrive (a reconnect lost them).
    const next = startTurn({ threadId, prompt: "next" }, ALL_AGENTS);
    assert.ok(next.ok);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(store.opencodeStaleEnd, undefined);
    opencodeLifecycleEvent(store, "session.error", { error: { name: "UnknownError" } });
    await tick();
    assert.equal(store.status, "error");
  } finally {
    opencodeStaleEnd.ms = realMs;
  }
});
