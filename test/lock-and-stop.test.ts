import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { createThread, getThread, JARVIS_BOT_ID, jarvisDir, updateThread } from "../src/bot-store";
import { sendToThread } from "../src/send-to-thread";
import { runningChildOf, withNote } from "../src/child-lock";
import { stripGitbotNotes } from "../ui/app/lib/gitbot-note";
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
import { handleRequest } from "../src/server";
import { agentRunners, startTurn } from "../src/turns";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- A stub at the agent seam: turns start and stay running until a test ends them ---

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
let unwatch = () => {};
before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
  unwatch = watchChildReports(ALL_AGENTS);
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
});
after(() => {
  unwatch();
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

/** A Jarvis thread with a running child, as start_thread leaves them. */
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

const jarvisRuns = (jarvisId: string) => runs.filter((s) => s.threadId === jarvisId);

/** The lock as the UI derives it from the session dump. */
function lockedFromDump(dump: SessionSummaryItem[], jarvisId: string): boolean {
  return dump.some((s) => s.reportTo === jarvisId && (s.status === "running" || s.status === "awaiting_permissions"));
}

// --- Derived lock ---

test("a running reportable child locks its Jarvis thread, in the helper and the dump", () => {
  const { jarvis, childId, child } = jarvisWithChild();
  assert.deepEqual(runningChildOf(jarvis.id), { threadId: childId, sessionId: child.gitbotId });
  const entry = buildSessionsDump().find((s) => s.threadId === childId);
  assert.equal(entry?.reportTo, jarvis.id);
  assert.ok(lockedFromDump(buildSessionsDump(), jarvis.id));
  // Waiting on an approval is still running.
  child.pendingPermissions.set("t1", { toolUseID: "t1", toolName: "Bash", input: {} } as any);
  assert.ok(runningChildOf(jarvis.id));
  assert.ok(lockedFromDump(buildSessionsDump(), jarvis.id));
  child.pendingPermissions.clear();
});

test("a child that is done, a turn that is not reportable, or another thread's child: unlocked", async () => {
  const { jarvis, childId, child } = jarvisWithChild();
  const other = jarvisThread();
  // Another Jarvis thread is not locked by this one's child.
  assert.equal(runningChildOf(other.id), undefined);
  assert.ok(!lockedFromDump(buildSessionsDump(), other.id));

  await end(child, "done");
  // The report woke Jarvis; the child itself no longer locks.
  assert.equal(runningChildOf(jarvis.id), undefined);
  assert.ok(!lockedFromDump(buildSessionsDump(), jarvis.id));
  const report = jarvisRuns(jarvis.id)[0];
  await end(report, "done");

  // The user types into the child: running, but not reportable.
  const typed = startTurn({ threadId: childId, prompt: "and more" }, ALL_AGENTS);
  assert.ok(typed.ok, JSON.stringify(typed));
  assert.equal(sessions.get(typed.sessionId)!.status, "running");
  assert.equal(runningChildOf(jarvis.id), undefined);
  assert.equal(buildSessionsDump().find((s) => s.gitbotId === typed.sessionId)?.reportTo, null);
  assert.ok(!lockedFromDump(buildSessionsDump(), jarvis.id));
});

test("a child's end and the report turn it starts reach the UI in one update: no idle gap", async () => {
  const { jarvis, child } = jarvisWithChild();
  const seen: boolean[] = [];
  const onUpdate = (_p: unknown, dump: SessionSummaryItem[]) => {
    const jarvisLive = dump.some((s) => s.threadId === jarvis.id && s.status === "running");
    seen.push(lockedFromDump(dump, jarvis.id) || jarvisLive);
  };
  permissionsEmitter.on("update", onUpdate);
  try {
    await end(child, "done");
    await turnEnd();
  } finally {
    permissionsEmitter.off("update", onUpdate);
  }
  assert.ok(seen.length > 0);
  assert.ok(seen.every(Boolean), `a broadcast showed the Jarvis thread unlocked and idle: ${JSON.stringify(seen)}`);
});

test("a user thread handed to Jarvis by send_to_thread locks it like a started child", async () => {
  const proj = project();
  const jarvis = jarvisThread();
  const mine = createThread("builtin-claude-code", proj.folder, "Mine", "chat", "claude-code");
  updateThread(mine.id, { sdkSessionId: `sdk-${mine.id}` });
  const sent = sendToThread(jarvis.id, { threadId: mine.id, message: "carry on" }, ALL_AGENTS);
  assert.ok(sent.ok, JSON.stringify(sent));
  assert.equal(runningChildOf(jarvis.id)?.threadId, mine.id);
  assert.ok(lockedFromDump(buildSessionsDump(), jarvis.id));
  assert.equal(startTurn({ threadId: jarvis.id, prompt: "hi" }, ALL_AGENTS).ok, false);
  await end(runs[runs.length - 1], "done");
  assert.equal(runningChildOf(jarvis.id), undefined);
});

test("PATCH /threads/:id cannot set ownership or a pending note", async () => {
  const jarvis = jarvisThread();
  const mine = createThread("builtin-claude-code", project().folder, "Mine", "chat", "claude-code");
  const res = await request("PATCH", `/threads/${mine.id}`, { reportTo: jarvis.id, pendingNote: "[forged]", title: "Renamed" });
  assert.equal(res.status, 200);
  const after = getThread(mine.id)!;
  assert.equal(after.reportTo, undefined);
  assert.equal(after.pendingNote, undefined);
  assert.equal(after.title, "Renamed");
  const res2 = await request("PATCH", `/threads/${jarvis.id}`, { pendingNote: "[forged]" });
  assert.equal(res2.status, 200);
  assert.equal(getThread(jarvis.id)!.pendingNote, undefined);
});

test("the user cannot send to a locked Jarvis thread", () => {
  const { jarvis } = jarvisWithChild();
  const sent = startTurn({ threadId: jarvis.id, prompt: "hello?" }, ALL_AGENTS);
  assert.ok(!sent.ok);
  assert.equal(sent.status, 409);
  assert.match(sent.message, /Waiting on Claude Code on /);
});

// --- One child at a time ---

test("start_thread is refused while this Jarvis thread's child runs, and allowed once it ends", async () => {
  const { jarvis, childId, child, proj } = jarvisWithChild();
  const second = startChildThread(jarvis.id, { agent: "codex", project: proj.id, message: "another" }, ALL_AGENTS);
  assert.ok(!second.ok);
  assert.match(second.error, new RegExp(`^one child at a time: Claude Code on ${basename(proj.folder)} \\(thread ${childId}\\) is still running`));
  // Another Jarvis thread is not held up.
  const elsewhere = startChildThread(jarvisThread().id, { agent: "codex", project: proj.id, message: "other" }, ALL_AGENTS);
  assert.ok(elsewhere.ok, JSON.stringify(elsewhere));

  await end(child, "done");
  await end(jarvisRuns(jarvis.id)[0], "done");
  const next = startChildThread(jarvis.id, { agent: "codex", project: proj.id, message: "next step" }, ALL_AGENTS);
  assert.ok(next.ok, JSON.stringify(next));
});

// --- Stop ---

test("Stop aborts the child, does not wake Jarvis, and unlocks the thread", async () => {
  const { jarvis, child } = jarvisWithChild();
  child.abortController = new AbortController();
  const res = await post(`/sessions/${child.gitbotId}/abort`);
  assert.equal(res.status, 200);
  assert.ok(child.abortController.signal.aborted);
  // claude-code ends an aborted turn as "error" with an aborted event.
  emitEvent(child, "aborted", { message: "Aborted by user" });
  await end(child, "error", "halfway");
  assert.equal(jarvisRuns(jarvis.id).length, 0, "Jarvis was not woken");
  assert.equal(runningChildOf(jarvis.id), undefined);
  assert.ok(!lockedFromDump(buildSessionsDump(), jarvis.id));
});

test("the stopped note is stored on the thread and prepended to the next user message exactly once", async () => {
  const { jarvis, child, proj } = jarvisWithChild();
  child.abortController = new AbortController();
  await post(`/sessions/${child.gitbotId}/abort`);
  await end(child, "error", "halfway");
  const note = `[you stopped Claude Code on ${basename(proj.folder)}]`;
  // Stored state: it survives a reload, which reads the thread afresh.
  assert.equal(getThread(jarvis.id)?.pendingNote, note);

  const first = startTurn({ threadId: jarvis.id, prompt: "try something else" }, ALL_AGENTS);
  assert.ok(first.ok, JSON.stringify(first));
  const store = sessions.get(first.sessionId)!;
  const prompt = store.events.find((e) => e.type === "user_prompt")?.prompt;
  assert.equal(prompt, `${note}\n\ntry something else`);
  assert.equal(getThread(jarvis.id)?.pendingNote, undefined);
  // The preview is the user's words, not the note.
  assert.equal(getThread(jarvis.id)?.preview, "try something else");

  await end(store, "done");
  const second = startTurn({ threadId: jarvis.id, prompt: "and again" }, ALL_AGENTS);
  assert.ok(second.ok);
  assert.equal(sessions.get(second.sessionId)!.events.find((e) => e.type === "user_prompt")?.prompt, "and again");
});

test("a second Stop while the first is in flight changes nothing and notes nothing more", async () => {
  const { jarvis, child, proj } = jarvisWithChild();
  child.abortController = new AbortController();
  assert.equal((await post(`/sessions/${child.gitbotId}/abort`)).status, 200);
  assert.equal((await post(`/sessions/${child.gitbotId}/abort`)).status, 200);
  assert.equal(getThread(jarvis.id)?.pendingNote, `[you stopped Claude Code on ${basename(proj.folder)}]`);
  await end(child, "error");
  assert.equal(jarvisRuns(jarvis.id).length, 0);
});

test("a Stop with nothing to stop yet is refused, leaves no note, and the child still reports", async () => {
  const proj = project();
  const jarvis = jarvisThread();
  const started = startChildThread(jarvis.id, { agent: "codex", project: proj.id, message: "go" }, ALL_AGENTS);
  assert.ok(started.ok);
  const child = runs[runs.length - 1];
  // The codex runner has not made its abort controller yet.
  assert.equal(child.abortController, null);
  const res = await post(`/sessions/${child.gitbotId}/abort`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /not stoppable yet/i);
  assert.equal(child.abortRequested, false);
  assert.equal(getThread(jarvis.id)?.pendingNote, undefined);
  await end(child, "done", "went");
  assert.equal(jarvisRuns(jarvis.id).length, 1, "the finished child reported");
});

test("a report turn does not take the note; the user's next message does", async () => {
  const proj = project();
  const jarvis = jarvisThread();
  // First child: stopped.
  const a = startChildThread(jarvis.id, { agent: "claude-code", project: proj.id, message: "a" }, ALL_AGENTS);
  assert.ok(a.ok);
  const childA = runs[runs.length - 1];
  childA.abortController = new AbortController();
  await post(`/sessions/${childA.gitbotId}/abort`);
  await end(childA, "error");
  // Second child (as if Jarvis had started it on a later turn): reports.
  const b = startChildThread(jarvis.id, { agent: "codex", project: proj.id, message: "b" }, ALL_AGENTS);
  assert.ok(b.ok);
  await end(runs[runs.length - 1], "done", "b is done");
  const report = jarvisRuns(jarvis.id)[0];
  assert.ok(!String(report.events[0].prompt).includes("you stopped"));
  assert.ok(getThread(jarvis.id)?.pendingNote);
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

// --- The UI hides gitbot's notes in the user's bubble ---

test("stripGitbotNotes removes leading stop and restart notes, and only those", () => {
  const sent = withNote("[you stopped PR Validator on Trophy]\n[Codex on api was interrupted by a restart]", "hi\n[you stopped X on Y]");
  assert.equal(stripGitbotNotes(sent!), "hi\n[you stopped X on Y]");
  assert.equal(stripGitbotNotes(withNote("[you stopped Claude Code on proj]", "a\n\nb")!), "a\n\nb");
  assert.equal(stripGitbotNotes("[you stopped Claude Code on proj]"), "");
  // Not a note: the user's own bracketed text, and a child's report header.
  assert.equal(stripGitbotNotes("[draft] tidy up"), "[draft] tidy up");
  const report = "[Claude Code · proj · thread abc · done]\nok";
  assert.equal(stripGitbotNotes(report), report);
});
