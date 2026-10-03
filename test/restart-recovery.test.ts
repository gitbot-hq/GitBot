import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { createThread, getThread, JARVIS_BOT_ID, jarvisDir, setRunningFor, updateThread } from "../src/bot-store";
import { runningChildOf } from "../src/child-lock";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { watchChildReports } from "../src/reports";
import { recoverInterruptedChildren, watchRunningMarks } from "../src/restart-recovery";
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
import { agentRunners, startTurn } from "../src/turns";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- A stub at the agent seam: turns start and stay running until a test ends them ---

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
const unwatch: Array<() => void> = [];
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
  // As start() wires them.
  unwatch.push(watchRunningMarks(), watchChildReports(ALL_AGENTS));
});
afterEach(() => {
  // Each test ends with every mark accounted for, so one test's "restart"
  // never recovers another's child.
  recoverInterruptedChildren();
  sessions.clear();
  runs = [];
});
after(() => {
  for (const u of unwatch) u();
  Object.assign(agentRunners, realRunners);
});

const turnEnd = () => new Promise((r) => setImmediate(r));

function project() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  return { id: added.project.id, folder };
}

function jarvisThread() {
  return createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
}

function jarvisWithChild() {
  const proj = project();
  const jarvis = jarvisThread();
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: proj.id, message: "sleep 60" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  return { jarvis, childId: started.threadId, child: runs[runs.length - 1], proj };
}

async function end(store: SessionStore, status: "done" | "error", content = "finished") {
  emitEvent(store, "assistant", { content });
  store.status = status;
  notifyPermissionsChanged();
  await turnEnd();
}

/** What a restart leaves: the stored threads, and no live sessions. */
function restart(): string[] {
  sessions.clear();
  return recoverInterruptedChildren();
}

const userPrompt = (sessionId: string) => sessions.get(sessionId)!.events.find((e) => e.type === "user_prompt")?.prompt;

// --- The mark ---

test("a reportable turn marks its thread with its Jarvis thread; its end clears the mark", async () => {
  const { jarvis, childId, child } = jarvisWithChild();
  assert.equal(getThread(childId)?.runningFor, jarvis.id);
  await end(child, "done");
  assert.equal(getThread(childId)?.runningFor, undefined);
});

test("a turn the user types into a thread is not marked", async () => {
  const mine = createThread("builtin-claude-code", project().folder, "Mine", "chat", "claude-code");
  const typed = startTurn({ threadId: mine.id, prompt: "hello" }, ALL_AGENTS);
  assert.ok(typed.ok);
  assert.equal(getThread(mine.id)?.runningFor, undefined);
});

// --- Detection from stored thread state ---

test("interrupted detection: only threads still marked at startup", () => {
  const proj = project();
  const jarvis = jarvisThread();
  // Fixture state as gitbot left it on disk: one child mid-turn, one finished,
  // one the user started, all with no live session.
  const running = createThread("builtin-claude-code", proj.folder, "Running", "chat", "claude-code", jarvis.id);
  setRunningFor(running.id, jarvis.id);
  const finished = createThread("builtin-codex", proj.folder, "Finished", "chat", "codex", jarvis.id);
  createThread("builtin-claude-code", proj.folder, "Mine", "chat", "claude-code");

  assert.deepEqual(restart(), [running.id]);
  assert.equal(getThread(jarvis.id)?.pendingNote, `[Claude Code on ${basename(proj.folder)} was interrupted by a restart]`);
  assert.equal(getThread(running.id)?.runningFor, undefined);
  assert.equal(getThread(finished.id)?.pendingNote, undefined);
  // Recovery runs once: a second startup finds nothing.
  assert.deepEqual(restart(), []);
});

// --- After a restart mid-child ---

test("after a restart mid-child the Jarvis thread is unlocked", () => {
  const { jarvis } = jarvisWithChild();
  assert.ok(runningChildOf(jarvis.id));
  restart();
  assert.equal(runningChildOf(jarvis.id), undefined);
  assert.ok(!buildSessionsDump().some((s) => s.reportTo === jarvis.id));
  const sent = startTurn({ threadId: jarvis.id, prompt: "hello again" }, ALL_AGENTS);
  assert.ok(sent.ok, JSON.stringify(sent));
});

test("the interruption note reaches Jarvis with the next user message, exactly once", async () => {
  const { jarvis, proj } = jarvisWithChild();
  restart();
  const note = `[Claude Code on ${basename(proj.folder)} was interrupted by a restart]`;

  const first = startTurn({ threadId: jarvis.id, prompt: "where were we?" }, ALL_AGENTS);
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(userPrompt(first.sessionId), `${note}\n\nwhere were we?`);
  assert.equal(getThread(jarvis.id)?.pendingNote, undefined);

  await end(sessions.get(first.sessionId)!, "done");
  const second = startTurn({ threadId: jarvis.id, prompt: "and now" }, ALL_AGENTS);
  assert.ok(second.ok);
  assert.equal(userPrompt(second.sessionId), "and now");
});

test("a child that finished normally before the restart leaves no note", async () => {
  const { jarvis, child } = jarvisWithChild();
  await end(child, "done");
  // Its report turn to Jarvis is not a child: it is not marked either.
  const report = runs.find((s) => s.threadId === jarvis.id)!;
  await end(report, "done");
  assert.deepEqual(restart(), []);
  assert.equal(getThread(jarvis.id)?.pendingNote, undefined);
});

test("a child that ended in error before the restart leaves no note", async () => {
  const { jarvis, child } = jarvisWithChild();
  await end(child, "error");
  assert.deepEqual(restart(), []);
  assert.equal(getThread(jarvis.id)?.pendingNote, undefined);
});

// --- With a Stop ---

test("a child stopped before the restart is told once, as stopped, not as interrupted", async () => {
  const { jarvis, child, proj } = jarvisWithChild();
  child.abortController = new AbortController();
  await post(`/sessions/${child.gitbotId}/abort`);
  // The server dies before the aborted turn winds down.
  restart();
  assert.equal(getThread(jarvis.id)?.pendingNote, `[you stopped Claude Code on ${basename(proj.folder)}]`);
});

test("an interruption note is appended to a stop note already waiting", () => {
  const { jarvis, proj } = jarvisWithChild();
  updateThread(jarvis.id, { pendingNote: "[you stopped Codex on elsewhere]" });
  restart();
  assert.equal(
    getThread(jarvis.id)?.pendingNote,
    `[you stopped Codex on elsewhere]\n[Claude Code on ${basename(proj.folder)} was interrupted by a restart]`,
  );
});

const post = (url: string) => request("POST", url);

async function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req = Object.assign(new EventEmitter(), { method, url, headers: {} }) as unknown as IRequest;
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
    if (body !== undefined) (req as unknown as EventEmitter).emit("data", JSON.stringify(body));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: JSON.parse(out || "{}") };
}
