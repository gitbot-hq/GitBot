import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bindSession, createThread, getThread, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import { sessions, type IRequest, type IResponse, type SessionStore } from "../src/server-common";
import { handleRequest } from "../src/server";
import { agentRunners, startTurn } from "../src/turns";

// A thread's first message went missing from its history: the thread is bound
// to its session at the agent's `init`, but Claude Code writes the prompt to
// its transcript only later (measured: the file does not exist yet at `init`,
// the prompt line lands ~700ms after). A history read in that window showed
// no first message. The real transcript reader runs here, against a temp
// CLAUDE_CONFIG_DIR, so "not written yet" is the real missing file.

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

const configDir = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-claude-config-")));
const realConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = configDir;

// The agent seam: the run reaches `init` (binds the thread) and keeps running,
// with nothing written to the transcript yet.
const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
let nextSdkId = 0;
for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
  agentRunners[agent] = async (store) => {
    runs.push(store);
    if (!store.sdkSessionId) {
      store.sdkSessionId = `sdk-${++nextSdkId}-${Date.now()}`;
      if (store.threadId) bindSession(store.threadId, store.sdkSessionId);
    }
  };
}
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
});
after(() => {
  Object.assign(agentRunners, realRunners);
  if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realConfigDir;
});

/** Claude Code writing a user prompt line to the session's transcript, now. */
function writePrompt(store: SessionStore, text: string, at = new Date(Date.now() + 1)): void {
  const dir = join(configDir, "projects", store.repoPath.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const line = {
    type: "user",
    userType: "external",
    timestamp: at.toISOString(),
    sessionId: store.sdkSessionId,
    message: { role: "user", content: [{ type: "text", text }] },
  };
  appendFileSync(join(dir, `${store.sdkSessionId}.jsonl`), JSON.stringify(line) + "\n");
}

function project(): { id: string; folder: string } {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  return { id: added.project.id, folder };
}

async function serve(method: string, url: string, body?: unknown) {
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
    (req as unknown as EventEmitter).emit("data", JSON.stringify(body ?? {}));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: out ? JSON.parse(out) : null };
}

const userTexts = (messages: any[]) =>
  messages.filter((m) => m.role === "user").map((m) => m.content.map((b: any) => b.text).join(""));

test("a user's first message is in the thread's history between init and the transcript write", async () => {
  const folder = project().folder;
  const thread = createThread("builtin-claude-code", folder, undefined, "chat", "claude-code");
  const sent = await serve("POST", "/chat", { threadId: thread.id, prompt: "fix the login bug" });
  assert.equal(sent.status, 200);
  const store = runs[0];

  // The UI trusts history from here: the session is bound and still running.
  const status = await serve("GET", `/sessions/${thread.id}/status`);
  assert.equal(status.body.streaming, true);
  assert.equal(status.body.sdkSessionId, store.sdkSessionId);
  assert.equal(getThread(thread.id)!.sdkSessionId, store.sdkSessionId);

  const early = await serve("GET", `/threads/${thread.id}/messages`);
  assert.equal(early.status, 200);
  assert.deepEqual(userTexts(early.body.messages), ["fix the login bug"]);

  // Once the agent has written it, it is shown once, from the transcript.
  writePrompt(store, "fix the login bug");
  const later = await serve("GET", `/threads/${thread.id}/messages`);
  assert.deepEqual(userTexts(later.body.messages), ["fix the login bug"]);
  assert.ok(later.body.messages[0].at > store.events[0].at, "the transcript's own line, not the stand-in");
});

test("a start_thread child's first message is in its history, and Jarvis's read of it", async () => {
  const owner = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const { id } = project();
  const result = startChildThread(owner.id, { agent: "claude-code", project: id, message: "build the project" }, ALL_AGENTS);
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(getThread(result.threadId)!.sdkSessionId, "bound at init");

  const early = await serve("GET", `/threads/${result.threadId}/messages`);
  assert.deepEqual(userTexts(early.body.messages), ["build the project"]);
});

test("a later turn's prompt is shown before the transcript has it, and not twice after", async () => {
  const folder = project().folder;
  const thread = createThread("builtin-claude-code", folder, undefined, "chat", "claude-code");
  assert.ok(startTurn({ threadId: thread.id, prompt: "one" }, ALL_AGENTS).ok);
  const store = runs[0];
  // Written while turn one ran, well before turn two was sent.
  writePrompt(store, "one", new Date(Date.now() - 1000));
  store.status = "done";

  // The second turn resumes the same SDK session.
  assert.ok(startTurn({ threadId: thread.id, prompt: "two" }, ALL_AGENTS).ok);
  assert.equal(runs[1].sdkSessionId, store.sdkSessionId);
  const early = await serve("GET", `/threads/${thread.id}/messages`);
  assert.deepEqual(userTexts(early.body.messages), ["one", "two"]);

  writePrompt(runs[1], "two");
  const later = await serve("GET", `/threads/${thread.id}/messages`);
  assert.deepEqual(userTexts(later.body.messages), ["one", "two"]);
});
