import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createBot,
  createThread,
  getThread,
  JARVIS_BOT_ID,
  jarvisDir,
  listThreads,
  setSetupStatus,
  updateThread,
  type Bot,
} from "../src/bot-store";
import { childPermission, JARVIS_SERVER, jarvisQueryOptions, jarvisSystemPrompt, startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { sessions, type IRequest, type IResponse, type SessionStore } from "../src/server-common";
import { handleRequest } from "../src/server";
import { agentRunners, startTurn } from "../src/turns";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- A stub at the agent seam: turns start, nothing is spawned ---

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
  agentRunners[agent] = async (store) => {
    runs.push(store);
    store.status = "done";
  };
}
afterEach(() => { runs = []; });
after(() => { Object.assign(agentRunners, realRunners); });

function project(): { id: string; folder: string } {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  return { id: added.project.id, folder };
}

const jarvisThread = () => createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");

// --- Permission resolution ---

test("childPermission: plain agents auto-approve, bots keep their mode, an override wins", () => {
  const plain = (agent: "claude-code" | "codex" | "opencode") =>
    ({ builtin: agent, permissionMode: "ask-permissions" }) as Pick<Bot, "builtin" | "permissionMode">;
  const bot = (mode: Bot["permissionMode"]) => ({ permissionMode: mode }) as Pick<Bot, "builtin" | "permissionMode">;

  const table: Array<[string, Pick<Bot, "builtin" | "permissionMode">, "claude-code" | "codex" | "opencode", Bot["permissionMode"] | undefined, string, string, string]> = [
    // label, bot, agent, override → chosen, session permissionMode, mode
    ["plain claude-code", plain("claude-code"), "claude-code", undefined, "auto-approve", "yolo", "build"],
    ["plain codex", plain("codex"), "codex", undefined, "auto-approve", "yolo", "build"],
    ["plain opencode", plain("opencode"), "opencode", undefined, "auto-approve", "yolo", "build"],
    ["plain, user asked to be asked", plain("claude-code"), "claude-code", "ask-permissions", "ask-permissions", "ask-permissions", "build"],
    ["plain codex, asked (no ask channel)", plain("codex"), "codex", "ask-permissions", "ask-permissions", "allow-all-edits", "build"],
    ["plain, plan", plain("claude-code"), "claude-code", "plan", "plan", "yolo", "plan"],
    ["bot ask-permissions", bot("ask-permissions"), "claude-code", undefined, "ask-permissions", "ask-permissions", "build"],
    ["bot auto-approve", bot("auto-approve"), "claude-code", undefined, "auto-approve", "yolo", "build"],
    ["bot plan", bot("plan"), "claude-code", undefined, "plan", "yolo", "plan"],
    ["bot ask, overridden to auto", bot("ask-permissions"), "opencode", "auto-approve", "auto-approve", "yolo", "build"],
    ["plan bot, overridden to auto: no plan left over", bot("plan"), "claude-code", "auto-approve", "auto-approve", "yolo", "build"],
    ["auto bot, overridden to ask", bot("auto-approve"), "claude-code", "ask-permissions", "ask-permissions", "ask-permissions", "build"],
  ];
  for (const [label, b, agent, override, chosen, permissionMode, mode] of table) {
    assert.deepEqual(childPermission(b, agent, override), { chosen, permissionMode, mode }, label);
  }
});

// --- start_thread ---

test("start_thread with a plain agent: child under its bot, in the project, reporting to Jarvis, turn running", () => {
  const owner = jarvisThread();
  const { id, folder } = project();
  const result = startChildThread(owner.id, { agent: "claude-code", project: id, message: "create hello.txt containing hi" }, ALL_AGENTS);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.folder, folder);
  assert.equal(result.permissionMode, "auto-approve");

  const child = getThread(result.threadId)!;
  assert.equal(child.botId, "builtin-claude-code");
  assert.equal(child.reportTo, owner.id);
  assert.equal(child.repoPath, folder);
  assert.equal(child.kind, "chat");
  assert.equal(child.messageCount, 1);
  // The child is listed under its own bot, not under Jarvis.
  assert.ok(listThreads("builtin-claude-code").some((t) => t.id === child.id));
  assert.ok(!listThreads(JARVIS_BOT_ID).some((t) => t.id === child.id));

  assert.equal(runs.length, 1);
  const store = runs[0];
  assert.equal(store.threadId, child.id);
  assert.equal(store.repoPath, folder);
  assert.equal(store.agent, "claude-code");
  assert.equal(store.permissionMode, "yolo");
  assert.equal(store.mode, "build");
  // A child is never a Jarvis session: no tool server, no Jarvis prompt.
  assert.equal(store.botPreset?.jarvis, undefined);
  assert.equal(store.events[0].type, "user_prompt");
  sessions.delete(store.gitbotId);
});

test("start_thread with a bot: the bot's own mode, or the one asked for", () => {
  const owner = jarvisThread();
  const { id } = project();
  const reviewer = createBot({ name: "Reviewer", instructions: "Review", agent: "opencode", permissionMode: "ask-permissions" });

  const own = startChildThread(owner.id, { bot: reviewer.id, project: id, message: "review it" }, ALL_AGENTS);
  assert.ok(own.ok);
  assert.equal(own.permissionMode, "ask-permissions");
  assert.equal(getThread(own.threadId)!.botId, reviewer.id);
  assert.equal(getThread(own.threadId)!.reportTo, owner.id);
  assert.equal(runs[0].agent, "opencode");
  assert.equal(runs[0].permissionMode, "ask-permissions");
  assert.equal(runs[0].botPreset?.instructions, "Review");

  const asked = startChildThread(owner.id, { bot: reviewer.id, project: id, message: "review it", permissionMode: "auto-approve" }, ALL_AGENTS);
  assert.ok(asked.ok);
  assert.equal(asked.permissionMode, "auto-approve");
  assert.equal(runs[1].permissionMode, "yolo");
  for (const s of runs) sessions.delete(s.gitbotId);
});

test("start_thread refuses a bot that is not set up, with a message Jarvis can relay", () => {
  const owner = jarvisThread();
  const { id } = project();
  const before = listThreads().length;
  const pending = createBot({ name: "Video Cutter", setupInstructions: "install ffmpeg" });
  const result = startChildThread(owner.id, { bot: pending.id, project: id, message: "cut it" }, ALL_AGENTS);
  assert.ok(!result.ok);
  assert.match(result.error, /Video Cutter is not set up on this machine/);
  assert.match(result.error, /Tell the user/);

  setSetupStatus(pending.id, "failed");
  const failed = startChildThread(owner.id, { bot: pending.id, project: id, message: "cut it" }, ALL_AGENTS);
  assert.ok(!failed.ok);
  assert.match(failed.error, /setup failed/);

  assert.equal(listThreads().length, before);
  assert.equal(runs.length, 0);
});

test("start_thread refuses Jarvis as a child", () => {
  const owner = jarvisThread();
  const { id } = project();
  const result = startChildThread(owner.id, { bot: JARVIS_BOT_ID, project: id, message: "hi" }, ALL_AGENTS);
  assert.ok(!result.ok);
  assert.match(result.error, /cannot be a Jarvis thread/);
  assert.equal(runs.length, 0);
});

test("start_thread: unknown project, bot or agent, and bad arguments, give clear errors", () => {
  const owner = jarvisThread();
  const { id } = project();
  const before = listThreads().length;
  const cases: Array<[Parameters<typeof startChildThread>[1], RegExp, string[]?]> = [
    [{ agent: "claude-code", project: "p-nope", message: "x" }, /no project with id "p-nope".*list_projects/],
    [{ bot: "no-such-bot", project: id, message: "x" }, /no bot with id "no-such-bot".*list_bots/],
    [{ agent: "gpt", project: id, message: "x" }, /unknown agent "gpt"/],
    [{ agent: "codex", project: id, message: "x" }, /codex is not installed/, ["claude-code"]],
    [{ project: id, message: "x" }, /exactly one of bot or agent/],
    [{ bot: "builtin-codex", agent: "codex", project: id, message: "x" }, /exactly one of bot or agent/],
    [{ agent: "claude-code", project: id, message: "  " }, /message is required/],
  ];
  for (const [args, error, agents] of cases) {
    const result = startChildThread(owner.id, args, agents ?? ALL_AGENTS);
    assert.ok(!result.ok, JSON.stringify(args));
    assert.match(result.error, error);
  }
  assert.equal(listThreads().length, before);
  assert.equal(runs.length, 0);
});

test("start_thread only works for a Jarvis thread", () => {
  const { id } = project();
  const plain = createThread("builtin-claude-code", tmpdir(), undefined, "chat", "claude-code");
  for (const caller of [plain.id, "no-such-thread"]) {
    const result = startChildThread(caller, { agent: "claude-code", project: id, message: "x" }, ALL_AGENTS);
    assert.ok(!result.ok);
    assert.match(result.error, /only a Jarvis thread/);
  }
});

test("a child whose turn cannot start is not left behind", () => {
  const owner = jarvisThread();
  const { id } = project();
  const codexBot = createBot({ name: "Codex Helper", agent: "codex" });
  const before = listThreads().length;
  // The bot runs on codex, which this machine lacks: the turn refuses.
  const result = startChildThread(owner.id, { bot: codexBot.id, project: id, message: "x" }, ["claude-code"]);
  assert.ok(!result.ok);
  assert.match(result.error, /codex, which is not installed/);
  assert.equal(listThreads().length, before);
});

test("the start_thread tool takes its owner from the server's closure, never from the args", async () => {
  const owner = jarvisThread();
  const other = jarvisThread();
  const { id, folder } = project();
  const server = jarvisQueryOptions({
    id: JARVIS_BOT_ID, name: "Jarvis", instructions: "",
    jarvis: { availableAgents: ALL_AGENTS, threadId: owner.id },
  }).mcpServers![JARVIS_SERVER] as any;
  const tool = server.instance._registeredTools.start_thread;
  assert.ok(tool, "start_thread is registered on the Jarvis server");
  // Keys a model might try are not in the schema, and change nothing.
  const out = await tool.handler(
    { agent: "claude-code", project: id, message: "make hello.txt", reportTo: other.id, jarvisThreadId: other.id },
    {},
  );
  assert.ok(!out.isError, out.content[0].text);
  const started = JSON.parse(out.content[0].text);
  const child = getThread(started.threadId)!;
  assert.equal(child.reportTo, owner.id);
  assert.equal(child.repoPath, folder);
  assert.equal(started.folder, folder);
  for (const s of runs) sessions.delete(s.gitbotId);
});

test("a permission on a child's first turn can be answered by its SDK session id", async () => {
  const thread = createThread("builtin-claude-code", tmpdir(), undefined, "chat", "claude-code");
  const res = await chat({ threadId: thread.id, prompt: "ask me something" });
  assert.equal(res.status, 200);
  const store = sessions.get(res.body.sessionId)!;
  // The agent reports its own session id; the thread and the UI know only that.
  store.sdkSessionId = "sdk-first-turn";
  store.status = "running";
  let answer: any;
  store.pendingPermissions.set("tu-1", {
    resolve: (r: any) => { answer = r; }, input: { command: "ls" }, toolName: "Bash", toolUseID: "tu-1",
  });
  const reply = await serve("POST", "/sessions/sdk-first-turn/permission", { toolUseID: "tu-1", approved: true });
  assert.equal(reply.status, 200);
  assert.deepEqual(answer, { behavior: "allow", updatedInput: { command: "ls" } });
  assert.equal(store.pendingPermissions.size, 0);
  sessions.delete(store.gitbotId);
});

test("Jarvis's prompt offers start_thread and no longer says it is unavailable", () => {
  const prompt = jarvisSystemPrompt();
  assert.match(prompt, /start_thread/);
  assert.doesNotMatch(prompt, /not available yet/);
});

// --- startTurn, and /chat going through it ---

const chat = (body: unknown) => serve("POST", "/chat", body);

async function serve(method: string, url: string, body: unknown) {
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
    (req as unknown as EventEmitter).emit("data", JSON.stringify(body));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: JSON.parse(out) };
}

test("/chat starts a hub thread's turn through startTurn", async () => {
  const thread = createThread("builtin-claude-code", tmpdir(), undefined, "chat", "claude-code");
  const res = await chat({ threadId: thread.id, prompt: "fix the bug please" });
  assert.equal(res.status, 200);
  assert.equal(runs.length, 1);
  assert.equal(res.body.sessionId, runs[0].gitbotId);
  assert.equal(runs[0].threadId, thread.id);
  assert.equal(runs[0].repoPath, tmpdir());
  assert.equal(runs[0].permissionMode, "ask-permissions");
  assert.equal(getThread(thread.id)!.messageCount, 1);
  // A thread the user starts never reports to Jarvis.
  assert.equal(getThread(thread.id)!.reportTo, undefined);
  sessions.delete(runs[0].gitbotId);
});

test("a second /chat while a thread's first turn is still running gets 409 and no second session", async () => {
  const stub = agentRunners["claude-code"];
  agentRunners["claude-code"] = async (store) => { runs.push(store); }; // stays running
  try {
    const thread = createThread("builtin-claude-code", tmpdir(), undefined, "chat", "claude-code");
    const first = await chat({ threadId: thread.id, prompt: "first" });
    assert.equal(first.status, 200);
    // The agent has reported its id and the thread is bound to it, as on a real first turn.
    sessions.get(first.body.sessionId)!.sdkSessionId = `sdk-${thread.id}`;
    updateThread(thread.id, { sdkSessionId: `sdk-${thread.id}` });
    const before = sessions.size;
    const second = await chat({ threadId: thread.id, prompt: "second" });
    assert.deepEqual(second, { status: 409, body: { error: "Session is already running" } });
    assert.equal(sessions.size, before);
    assert.equal(runs.length, 1);
    // Before the agent's init (no session id on the thread yet) it is refused too.
    const fresh = createThread("builtin-claude-code", tmpdir(), undefined, "chat", "claude-code");
    assert.equal((await chat({ threadId: fresh.id, prompt: "one" })).status, 200);
    assert.equal((await chat({ threadId: fresh.id, prompt: "two" })).status, 409);
    assert.equal(runs.length, 2);
    for (const s of runs) sessions.delete(s.gitbotId);
  } finally {
    agentRunners["claude-code"] = stub;
  }
});

test("/chat keeps its errors", async () => {
  assert.deepEqual(await chat({ threadId: "missing", prompt: "x" }), { status: 404, body: { error: "Thread not found" } });
  assert.deepEqual(await chat({ agent: "claude-code", prompt: "x" }), { status: 400, body: { error: "repoPath is required" } });
  assert.deepEqual(await chat({ agent: "claude-code", repoPath: tmpdir() }), { status: 400, body: { error: "prompt or attachments is required" } });
  assert.deepEqual(await chat({ agent: "gpt", repoPath: tmpdir(), prompt: "x" }), { status: 400, body: { error: "agent must be claude-code, opencode, or codex" } });
  const pending = createBot({ name: "Needs Setup", setupInstructions: "x" });
  const blocked = await chat({ threadId: createThread(pending.id, tmpdir()).id, prompt: "x" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.setupRequired, true);
  assert.equal(runs.length, 0);
});

test("startTurn: a running session refuses a second turn; an idle one is reused", () => {
  const first = startTurn({ agent: "codex", repoPath: tmpdir(), prompt: "one" }, ALL_AGENTS);
  assert.ok(first.ok);
  const store = sessions.get(first.sessionId)!;
  store.status = "running";
  const busy = startTurn({ agent: "codex", repoPath: tmpdir(), prompt: "two", sessionId: first.sessionId }, ALL_AGENTS);
  assert.deepEqual(busy, { ok: false, status: 409, message: "Session is already running" });
  store.status = "done";
  const again = startTurn({ agent: "codex", repoPath: tmpdir(), prompt: "two", sessionId: first.sessionId }, ALL_AGENTS);
  assert.deepEqual(again, { ok: true, sessionId: first.sessionId });
  assert.equal(runs.length, 2);
  sessions.delete(first.sessionId);
});

test("startTurn: a runner that rejects leaves the session in error, not running", async () => {
  const stub = agentRunners.codex;
  agentRunners.codex = async () => { throw new Error("boom"); };
  try {
    const result = startTurn({ agent: "codex", repoPath: tmpdir(), prompt: "x" }, ALL_AGENTS);
    assert.ok(result.ok);
    await new Promise((r) => setImmediate(r));
    const store = sessions.get(result.sessionId)!;
    assert.equal(store.status, "error");
    assert.equal(store.events.at(-1)?.type, "error");
    sessions.delete(result.sessionId);
  } finally {
    agentRunners.codex = stub;
  }
});
