import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, realpathSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createBot,
  createThread,
  ensureSetupThread,
  JARVIS_BOT_ID,
  jarvisDir,
  updateThread,
} from "../src/bot-store";
import { addProject } from "../src/project-index";
import { handleBotRoutes } from "../src/bot-routes";
import { createSession, emitEvent, sessions, type IRequest, type IResponse } from "../src/server-common";
import {
  LIST_THREADS_CAP,
  listThreadsForJarvis,
  MESSAGE_CHARS,
  readThreadTail,
  TAIL_MAX,
  threadStatus,
  transcriptLoaders,
  type TranscriptMessage,
} from "../src/thread-tools";

// --- A stub at the transcript seam: transcripts keyed by session id ---

const transcripts = new Map<string, TranscriptMessage[]>();
const loaded: string[] = [];
const realLoaders = { ...transcriptLoaders };
for (const agent of Object.keys(transcriptLoaders) as (keyof typeof transcriptLoaders)[]) {
  transcriptLoaders[agent] = async (id) => {
    loaded.push(`${agent}:${id}`);
    return transcripts.get(id) ?? [];
  };
}
after(() => { Object.assign(transcriptLoaders, realLoaders); });

function project(): { id: string; folder: string } {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  return { id: added.project.id, folder };
}

const text = (role: string, t: string): TranscriptMessage => ({ role, content: [{ type: "text", text: t }] });

// --- list_threads ---

test("list_threads filters by project and by bot, and leaves out Jarvis and setup threads", async () => {
  const a = project();
  const b = project();
  const botX = createBot({ name: "X", setupInstructions: "install ffmpeg" });
  const botY = createBot({ name: "Y" });
  const xa = createThread(botX.id, a.folder, "X in A");
  const ya = createThread(botY.id, a.folder, "Y in A");
  const xb = createThread(botX.id, b.folder, "X in B");
  const setup = ensureSetupThread(botX.id, a.folder);
  assert.ok(setup);
  createThread(JARVIS_BOT_ID, jarvisDir(), "Jarvis");

  const inA = await listThreadsForJarvis({ project: a.id });
  assert.ok(inA.ok);
  assert.deepEqual(inA.threads.map((t) => t.id).sort(), [xa.id, ya.id].sort());
  assert.equal(inA.threads.find((t) => t.id === xa.id)!.bot, "X");
  assert.equal(inA.threads[0].projectId, a.id);

  const ofX = await listThreadsForJarvis({ bot: botX.id });
  assert.ok(ofX.ok);
  assert.deepEqual(ofX.threads.map((t) => t.id).sort(), [xa.id, xb.id].sort());

  const both = await listThreadsForJarvis({ project: b.id, bot: botX.id });
  assert.ok(both.ok);
  assert.deepEqual(both.threads.map((t) => t.id), [xb.id]);

  const all = await listThreadsForJarvis({});
  assert.ok(all.ok);
  for (const t of all.threads) {
    assert.notEqual(t.botId, JARVIS_BOT_ID);
    assert.notEqual(t.id, setup.id);
  }

  // Jarvis is not a bot whose threads can be listed, and unknown ids say so.
  assert.equal((await listThreadsForJarvis({ bot: JARVIS_BOT_ID })).ok, false);
  assert.equal((await listThreadsForJarvis({ project: "p-0000000000" })).ok, false);
});

test("list_threads maps a thread's folder to its project through the real path", async () => {
  const a = project();
  const link = join(mkdtempSync(join(tmpdir(), "gitbot-link-")), "alias");
  symlinkSync(a.folder, link);
  const bot = createBot({ name: "Linked" });
  const t = createThread(bot.id, link, "via symlink");
  const listed = await listThreadsForJarvis({ project: a.id });
  assert.ok(listed.ok);
  assert.deepEqual(listed.threads.map((x) => x.id), [t.id]);
});

test("list_threads caps its output, newest first, and marks threads this Jarvis started", async () => {
  const a = project();
  const bot = createBot({ name: "Many" });
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir());
  const ids: string[] = [];
  for (let i = 0; i < LIST_THREADS_CAP + 5; i++) {
    ids.push(createThread(bot.id, a.folder, `t${i}`, "chat", undefined, i === 0 ? jarvis.id : undefined).id);
  }
  // Touch the first so it is the newest.
  await new Promise((r) => setTimeout(r, 5));
  updateThread(ids[0], { preview: "bump" });
  const listed = await listThreadsForJarvis({ bot: bot.id }, jarvis.id);
  assert.ok(listed.ok);
  assert.equal(listed.threads.length, LIST_THREADS_CAP);
  assert.equal(listed.total, LIST_THREADS_CAP + 5);
  assert.equal(listed.truncated, true);
  assert.equal(listed.threads[0].id, ids[0]);
  assert.equal(listed.threads[0].startedByYou, true);
  assert.equal(listed.threads[1].startedByYou, undefined);
});

test("list_threads matches a folder reached with different letter case to its project", async (t) => {
  const a = project();
  const parent = a.folder.slice(0, a.folder.lastIndexOf("/"));
  const name = a.folder.slice(parent.length + 1);
  const shouted = `${parent}/${name.toUpperCase()}`;
  if (!existsSync(shouted)) { t.skip("case-sensitive filesystem"); return; }
  const bot = createBot({ name: "Cased" });
  const thread = createThread(bot.id, shouted, "shouted");
  const listed = await listThreadsForJarvis({ project: a.id });
  assert.ok(listed.ok);
  assert.deepEqual(listed.threads.map((x) => x.id), [thread.id]);
});

// --- thread_status ---

function threadWithSession(sdkId: string, agent: "claude-code" | "codex" | "opencode" = "claude-code") {
  const a = project();
  const bot = createBot({ name: `Status ${sdkId}` });
  const thread = createThread(bot.id, a.folder, "status", "chat", agent);
  updateThread(thread.id, { sdkSessionId: sdkId });
  return thread;
}

test("thread_status maps each session state", async () => {
  const cases: Array<[string, (s: ReturnType<typeof createSession>) => void, string]> = [
    ["running", () => {}, "running"],
    ["awaiting", (s) => {
      s.pendingPermissions.set("tu1", { resolve: () => {}, input: {}, toolName: "Bash", toolUseID: "tu1" });
    }, "waiting on approval"],
    ["done", (s) => { s.status = "done"; }, "done"],
    ["error", (s) => { emitEvent(s, "error", { message: "boom" }); s.status = "error"; }, "failed"],
    // Claude Code ends an aborted turn on "error"; opencode on "done". Both are stopped.
    ["aborted-cc", (s) => { emitEvent(s, "aborted", { message: "x" }); s.status = "error"; }, "stopped"],
    ["aborted-oc", (s) => { emitEvent(s, "aborted", { message: "x" }); s.status = "done"; }, "stopped"],
  ];
  for (const [label, setup, expected] of cases) {
    const thread = threadWithSession(`sdk-${label}`);
    const store = createSession(`g-${label}`, "claude-code", thread.repoPath, undefined, undefined, undefined, { threadId: thread.id });
    emitEvent(store, "assistant", { content: `last words of ${label}` });
    emitEvent(store, "assistant", { content: "from a subagent", parent_tool_use_id: "task1" });
    setup(store);
    const status = await threadStatus(thread.id);
    assert.ok(status.ok, label);
    assert.equal(status.status, expected, label);
    assert.equal(status.lastMessage, `last words of ${label}`, label);
    if (expected === "waiting on approval") assert.deepEqual(status.waitingOn, ["Bash"]);
    if (expected === "failed") assert.equal(status.error, "boom");
  }
});

test("thread_status prefers a running session over an older finished one", async () => {
  const thread = threadWithSession("sdk-two");
  const old = createSession("g-old", "claude-code", thread.repoPath, undefined, undefined, undefined, { threadId: thread.id });
  old.status = "done";
  createSession("g-new", "claude-code", thread.repoPath, undefined, undefined, undefined, { threadId: thread.id });
  // Order in the map should not matter for the running one.
  sessions.delete("g-old");
  sessions.set("g-old", old);
  const status = await threadStatus(thread.id);
  assert.ok(status.ok);
  assert.equal(status.status, "running");
});

test("thread_status: of two finished sessions the newest wins, and a failed one says so", async () => {
  const thread = threadWithSession("sdk-two-done");
  const old = createSession("g-two-old", "claude-code", thread.repoPath, undefined, undefined, undefined, { threadId: thread.id });
  old.status = "done";
  const newer = createSession("g-two-new", "claude-code", thread.repoPath, undefined, undefined, undefined, { threadId: thread.id });
  emitEvent(newer, "error", { message: "crashed" });
  newer.status = "error";
  const status = await threadStatus(thread.id);
  assert.ok(status.ok);
  assert.equal(status.status, "failed");
  assert.equal(status.error, "crashed");
});

test("thread_status of a running turn never passes off the previous reply as its last message", async () => {
  const sdk = "sdk-running-quiet";
  transcripts.set(sdk, [text("assistant", "an answer from the turn before")]);
  const thread = threadWithSession(sdk);
  createSession("g-running-quiet", "claude-code", thread.repoPath, undefined, undefined, undefined, { threadId: thread.id });
  loaded.length = 0;
  const status = await threadStatus(thread.id);
  assert.ok(status.ok);
  assert.equal(status.status, "running");
  assert.equal(status.lastMessage, undefined);
  assert.deepEqual(loaded, []);
});

test("thread_status with no live session is idle, with the last message from the transcript", async () => {
  for (const agent of ["claude-code", "codex", "opencode"] as const) {
    const sdk = `sdk-idle-${agent}`;
    transcripts.set(sdk, [
      text("user", "do it"),
      text("assistant", "all done"),
      { role: "assistant", content: [{ type: "tool_use", tool_name: "Bash", tool_input: "ls" }] },
    ]);
    const thread = threadWithSession(sdk, agent);
    loaded.length = 0;
    const status = await threadStatus(thread.id);
    assert.ok(status.ok);
    assert.equal(status.status, "idle");
    assert.equal(status.lastMessage, "all done");
    assert.deepEqual(loaded, [`${agent}:${sdk}`]);
  }
});

test("thread_status caps the last message", async () => {
  const thread = threadWithSession("sdk-long");
  const store = createSession("g-long", "claude-code", thread.repoPath, undefined, undefined, undefined, { threadId: thread.id });
  emitEvent(store, "assistant", { content: "x".repeat(10_000) });
  store.status = "done";
  const status = await threadStatus(thread.id);
  assert.ok(status.ok);
  assert.ok(status.lastMessage!.length < 4100);
});

// --- read_thread_tail ---

test("read_thread_tail returns the last n messages, capped in count and length", async () => {
  const sdk = "sdk-tail";
  const msgs: TranscriptMessage[] = [];
  for (let i = 0; i < 30; i++) msgs.push(text(i % 2 ? "assistant" : "user", `m${i}`));
  msgs.push(text("assistant", "y".repeat(MESSAGE_CHARS + 500)));
  transcripts.set(sdk, msgs);
  const thread = threadWithSession(sdk, "codex");

  const three = await readThreadTail(thread.id, 3);
  assert.ok(three.ok);
  assert.deepEqual(three.messages.slice(0, 2).map((m) => m.text), ["m28", "m29"]);
  assert.ok(three.messages[2].text.length < MESSAGE_CHARS + 50);
  assert.equal(three.total, 31);

  const many = await readThreadTail(thread.id, 500);
  assert.ok(many.ok);
  assert.equal(many.messages.length, TAIL_MAX);
});

test("read_thread_tail renders tool calls, and a thread with no turn yet has no messages", async () => {
  const sdk = "sdk-tools";
  transcripts.set(sdk, [{ role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", tool_name: "Bash", tool_input: "npm test" }] }]);
  const thread = threadWithSession(sdk, "opencode");
  const tail = await readThreadTail(thread.id, 1);
  assert.ok(tail.ok);
  assert.equal(tail.messages[0].text, "checking\n[tool Bash: npm test]");

  const bot = createBot({ name: "Fresh" });
  const fresh = createThread(bot.id, project().folder);
  const none = await readThreadTail(fresh.id, 5);
  assert.ok(none.ok);
  assert.deepEqual(none.messages, []);
});

// --- Jarvis threads are off limits ---

test("thread_status and read_thread_tail refuse setup threads", async () => {
  const bot = createBot({ name: "Needs setup", setupInstructions: "install ffmpeg" });
  const setup = ensureSetupThread(bot.id, project().folder);
  assert.ok(setup);
  for (const result of [await threadStatus(setup.id), await readThreadTail(setup.id, 5)]) {
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /setup/);
  }
});

test("thread_status and read_thread_tail refuse Jarvis threads and unknown ids", async () => {
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir());
  updateThread(jarvis.id, { sdkSessionId: "sdk-jarvis" });
  transcripts.set("sdk-jarvis", [text("assistant", "secret")]);
  loaded.length = 0;
  for (const result of [await threadStatus(jarvis.id), await readThreadTail(jarvis.id, 5)]) {
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /Jarvis/);
  }
  assert.deepEqual(loaded, []);
  assert.equal((await threadStatus("nope")).ok, false);
  assert.equal((await readThreadTail("nope", 1)).ok, false);
});

// --- The thread view reads through the same loader ---

async function getMessages(id: string) {
  const req = Object.assign(new EventEmitter(), { method: "GET", url: `/threads/${id}/messages`, headers: {} }) as unknown as IRequest;
  let status = 0;
  let out = "";
  const res: IResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; },
    write() {},
    end(chunk) { out = chunk ?? ""; },
  };
  assert.equal(await handleBotRoutes(req, res, tmpdir(), ["claude-code", "codex", "opencode"]), true);
  return { status, body: JSON.parse(out) };
}

test("GET /threads/:id/messages: 404 for no thread, empty before a turn, the transcript after", async () => {
  assert.equal((await getMessages("nope")).status, 404);

  const bot = createBot({ name: "Route" });
  const thread = createThread(bot.id, project().folder);
  loaded.length = 0;
  const empty = await getMessages(thread.id);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.messages, []);
  assert.deepEqual(loaded, []);

  transcripts.set("sdk-route", [text("user", "hi")]);
  // An agent this build does not know reads as Claude Code, as it always has.
  updateThread(thread.id, { sdkSessionId: "sdk-route", agent: "mystery" as any });
  const full = await getMessages(thread.id);
  assert.deepEqual(full.body.messages, [text("user", "hi")]);
  assert.deepEqual(loaded, ["claude-code:sdk-route"]);
});
