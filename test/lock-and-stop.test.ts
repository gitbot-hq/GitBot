import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { createThread, getThread, JARVIS_BOT_ID, jarvisDir, setScheduleNote, updateThread } from "../src/bot-store";
import { sendToThread } from "../src/send-to-thread";
import { pendingNoteFor, runningChildOf, withNote } from "../src/child-lock";
import { stripGitbotNotes } from "../ui/app/lib/gitbot-note";
import { liveByBot, rowLabel } from "../ui/app/lib/use-thread-sessions";
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

test("each dump entry names its thread's bot, from the turn's first broadcast", async () => {
  const { jarvis, childId, child } = jarvisWithChild();
  const childBot = getThread(childId)!.botId;
  assert.notEqual(childBot, JARVIS_BOT_ID);
  // A Jarvis child belongs to the child's bot, not to Jarvis.
  assert.equal(buildSessionsDump().find((s) => s.gitbotId === child.gitbotId)?.botId, childBot);
  await end(child, "done");
  const report = jarvisRuns(jarvis.id)[0];
  assert.equal(buildSessionsDump().find((s) => s.gitbotId === report.gitbotId)?.botId, JARVIS_BOT_ID);
  await end(report, "done");
  // A turn on an existing session: its first broadcast already carries it.
  updateThread(childId, { sdkSessionId: child.gitbotId });
  child.botId = undefined;
  let first: SessionSummaryItem[] | undefined;
  const onUpdate = (_p: unknown, dump: SessionSummaryItem[]) => { first ??= dump; };
  permissionsEmitter.on("update", onUpdate);
  try {
    const again = startTurn({ threadId: childId, prompt: "and more" }, ALL_AGENTS);
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(again.sessionId, child.gitbotId);
  } finally {
    permissionsEmitter.off("update", onUpdate);
  }
  assert.equal(first?.find((s) => s.gitbotId === child.gitbotId)?.botId, childBot);
});

test("a bot's live status: waiting beats running, idle bots and threadless sessions are left out", () => {
  const s = (gitbotId: string, botId: string | null, status: SessionSummaryItem["status"], threadId: string | null = gitbotId) =>
    ({ gitbotId, botId, status, threadId });
  assert.deepEqual(
    liveByBot([
      s("a1", "a", "running"),
      s("a2", "a", "awaiting_permissions"),
      s("a3", "a", "running"),
      s("b1", "b", "done"),
      s("b2", "b", "running"),
      s("c1", "c", "done"),
      s("c2", "c", "error"),
      s("d1", "d", "awaiting_permissions"),
      s("x1", null, "running"),
      s("x2", "e", "running", null),
    ]),
    { a: "awaiting_permissions", b: "running", d: "awaiting_permissions" },
  );
});

test("Jarvis is live while a thread it started is, and the child's own bot is too", () => {
  const s = (
    gitbotId: string,
    botId: string | null,
    status: SessionSummaryItem["status"],
    reportTo: string | null = null,
    threadId: string | null = gitbotId,
  ) => ({ gitbotId, botId, status, threadId, reportTo });
  // A running child lights Jarvis and its own bot.
  assert.deepEqual(liveByBot([s("c1", "builtin-claude-code", "running", "j1")]), {
    "builtin-claude-code": "running",
    [JARVIS_BOT_ID]: "running",
  });
  // A child waiting on approval: Jarvis waits too, and waiting beats Jarvis's own running turn.
  assert.deepEqual(
    liveByBot([
      s("j2", JARVIS_BOT_ID, "running"),
      s("c2", "custom", "awaiting_permissions", "j1"),
      s("c3", "builtin-codex", "running", "j1"),
    ]),
    { [JARVIS_BOT_ID]: "awaiting_permissions", custom: "awaiting_permissions", "builtin-codex": "running" },
  );
  // Jarvis's own turn alone; a finished child (reportTo kept from its last turn) counts for no one.
  assert.deepEqual(liveByBot([s("j1", JARVIS_BOT_ID, "running"), s("c4", "custom", "done", "j1")]), {
    [JARVIS_BOT_ID]: "running",
  });
  // Nothing live: Jarvis is absent (idle).
  assert.deepEqual(liveByBot([s("c5", "custom", "error", "j1"), s("c6", "custom", "running", "j1", null)]), {});
});

test("a bot row's label: waiting wins, then the open chat, then another running thread", () => {
  const live = { a: "running", w: "awaiting_permissions" } as const;
  // Selected, open chat idle: another thread's status.
  assert.equal(rowLabel(live, "a", "a", null, false), "Working");
  assert.equal(rowLabel(live, "w", "w", null, false), "Waiting");
  // Selected, open chat live: it says more, unless another thread waits.
  assert.equal(rowLabel(live, "a", "a", "Reading", false), "Reading");
  assert.equal(rowLabel(live, "w", "w", "Reading", false), "Waiting");
  assert.equal(rowLabel({}, "a", "a", "Editing", false), "Editing");
  // A bot still setting up keeps its setup label.
  assert.equal(rowLabel(live, "a", "a", null, true), null);
  assert.equal(rowLabel(live, "w", "x", null, true), null);
  // Not selected: its own status, never the open chat's.
  assert.equal(rowLabel(live, "a", "x", "Reading", false), "Working");
  assert.equal(rowLabel(live, "w", "x", "Reading", false), "Waiting");
  assert.equal(rowLabel(live, "z", "x", "Reading", false), null);
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

test("pending note then schedule notes, then the message; scheduled and report turns leave them", async () => {
  const proj = project();
  const jarvis = jarvisThread();
  const lineA = `[schedule "Nightly audit": 3 runs since your last message, last done, thread ${"a".repeat(8)}]`;
  const lineB = `[schedule "Digest" paused after 3 failed runs]`;
  const notes = () => {
    setScheduleNote(jarvis.id, "sched-a", () => ({ line: lineA, runs: 3 }));
    setScheduleNote(jarvis.id, "sched-b", () => ({ line: lineB, runs: 0, paused: "paused after 3 failed runs" }));
  };
  notes();
  // Replaced, never appended: one line per schedule.
  setScheduleNote(jarvis.id, "sched-a", (n) => ({ ...n!, line: lineA }));
  assert.deepEqual(Object.keys(getThread(jarvis.id)!.scheduleNotes!), ["sched-a", "sched-b"]);

  // A scheduled turn on the Jarvis thread neither carries nor clears them.
  const scheduled = startTurn({ threadId: jarvis.id, prompt: "Remind the user to stretch.", scheduled: { id: "s", name: "Stretch", run: 1 } }, ALL_AGENTS);
  assert.ok(scheduled.ok, JSON.stringify(scheduled));
  assert.equal(sessions.get(scheduled.sessionId)!.events.find((e) => e.type === "user_prompt")?.prompt, "Remind the user to stretch.");
  assert.equal(pendingNoteFor(jarvis.id, false, { id: "s", name: "Stretch", run: 1 }), undefined);
  await end(sessions.get(scheduled.sessionId)!, "done");
  assert.equal(Object.keys(getThread(jarvis.id)!.scheduleNotes ?? {}).length, 2);

  // A report turn neither.
  const child = startChildThread(jarvis.id, { agent: "claude-code", project: proj.id, message: "go" }, ALL_AGENTS);
  assert.ok(child.ok);
  await end(runs[runs.length - 1], "done", "went");
  const report = jarvisRuns(jarvis.id).at(-1)!;
  assert.ok(!String(report.events.find((e) => e.type === "user_prompt")?.prompt).includes("[schedule"));
  await end(report, "done");
  assert.equal(Object.keys(getThread(jarvis.id)!.scheduleNotes ?? {}).length, 2);

  // The user's own message: the pending note, the schedule lines, then the message.
  updateThread(jarvis.id, { pendingNote: "[you stopped PR Validator on Trophy]" });
  const mine = startTurn({ threadId: jarvis.id, prompt: "what happened?" }, ALL_AGENTS);
  assert.ok(mine.ok, JSON.stringify(mine));
  const prompt = String(sessions.get(mine.sessionId)!.events.find((e) => e.type === "user_prompt")?.prompt);
  assert.equal(prompt, `[you stopped PR Validator on Trophy]\n${lineA}\n${lineB}\n\nwhat happened?`);
  assert.equal(stripGitbotNotes(prompt), "what happened?");
  const after = getThread(jarvis.id)!;
  assert.equal(after.pendingNote, undefined);
  assert.equal(after.scheduleNotes, undefined);
  assert.equal(after.preview, "what happened?");
  await end(sessions.get(mine.sessionId)!, "done");

  // Schedule lines alone go the same way; a plain thread never carries any.
  notes();
  assert.equal(pendingNoteFor(jarvis.id, false), `${lineA}\n${lineB}`);
  const plain = createThread("builtin-claude-code", proj.folder, "Mine", "chat", "claude-code");
  setScheduleNote(plain.id, "sched-a", () => ({ line: lineA, runs: 1 }));
  assert.equal(pendingNoteFor(plain.id, false), undefined);
});

test("PATCH /threads/:id cannot set schedule notes", async () => {
  const jarvis = jarvisThread();
  const res = await request("PATCH", `/threads/${jarvis.id}`, { scheduleNotes: { x: { line: "[schedule \"x\": forged]", runs: 1 } } });
  assert.equal(res.status, 200);
  assert.equal(getThread(jarvis.id)!.scheduleNotes, undefined);
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

test("stripGitbotNotes hides [schedule …] lines and keeps the user's text", () => {
  const id = "0b9f6c1e-3f7a-4c2b-9d1e-5a6b7c8d9e0f";
  const lines = [
    `[schedule "Nightly audit": 3 runs since your last message, last done, thread ${id}]`,
    `[schedule "Ping": 1 run since your last message, last failed to start]`,
    `[schedule "X" missed 2 runs while gitbot was down]`,
    `[schedule "X" missed 1 run while gitbot was down; 1 run since your last message, last stopped, thread ${id}]`,
    `[schedule "Y" paused after 3 failed runs]`,
    `[schedule "Y" paused: its bot was deleted; 2 runs since your last message, last failed, thread ${id}]`,
  ];
  const sent = withNote(["[you stopped Claude Code on proj]", ...lines].join("\n"), "what ran?\n[schedule \"X\" missed 2 runs while gitbot was down]");
  assert.equal(stripGitbotNotes(sent!), "what ran?\n[schedule \"X\" missed 2 runs while gitbot was down]", "a line after the user's text is theirs");
  assert.equal(stripGitbotNotes(withNote(lines[0], "a\n\nb")!), "a\n\nb");
  // The user's own bracketed text that is not one of gitbot's shapes stays.
  for (const mine of ['[schedule "x"] tidy up', '[schedule "x"]', "[schedule] daily", '[schedule "x": do this now]', '[schedule "x" please delete everything]']) {
    assert.equal(stripGitbotNotes(mine), mine);
  }
});
