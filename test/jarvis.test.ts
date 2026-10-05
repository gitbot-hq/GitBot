import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createBot,
  createThread,
  dataDir,
  getBot,
  getThread,
  JARVIS_BOT_ID,
  jarvisDir,
  listBots,
  setSetupStatus,
  threadAgent,
  type Thread,
} from "../src/bot-store";
import { handleBotRoutes, resolveThreadTurn } from "../src/bot-routes";
import { presetSystemPrompt } from "../src/bot-prompt";
import {
  getBotsForJarvis,
  isJarvisTool,
  JARVIS_SERVER,
  jarvisQueryOptions,
  listBotsForJarvis,
  jarvisSystemPrompt,
  stripJarvisReminder,
  withJarvisReminder,
} from "../src/jarvis";
import { createSession, sessions, type IRequest, type IResponse } from "../src/server-common";
import { handleRequest } from "../src/server";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

/** Drives the bot routes the way the HTTP server does, without a socket. */
async function call(method: string, url: string, body?: unknown, agents: string[] = ALL_AGENTS) {
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
  const handled = handleBotRoutes(req, res, tmpdir(), agents);
  setImmediate(() => {
    if (body !== undefined) (req as unknown as EventEmitter).emit("data", JSON.stringify(body));
    (req as unknown as EventEmitter).emit("end");
  });
  assert.equal(await handled, true, `${method} ${url} was not handled`);
  return { status, body: JSON.parse(out) };
}

// --- Jarvis as a built-in bot ---

test("Jarvis is listed first, whether or not Claude Code is installed", () => {
  const bots = listBots(ALL_AGENTS);
  assert.equal(bots[0].id, JARVIS_BOT_ID);
  assert.equal(bots[0].builtin, "jarvis");
  assert.equal(bots.filter((b) => b.builtin === "jarvis").length, 1);
  // Jarvis always exists: without Claude Code it stays listed (the UI shows
  // it cannot run), so its threads keep their place in the sidebar.
  const withoutClaude = listBots(["codex"]);
  assert.equal(withoutClaude[0].id, JARVIS_BOT_ID);
  assert.ok(!withoutClaude.some((b) => b.id === "builtin-claude-code"));
  assert.equal(getBot(JARVIS_BOT_ID)?.name, "Jarvis");
});

test("GET /bots lists Jarvis without Claude Code", async () => {
  const listed = await call("GET", "/bots", undefined, ["codex"]);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.bots[0].id, JARVIS_BOT_ID);
});

test("Jarvis runs Claude Code in auto-approve on the default model", () => {
  const jarvis = getBot(JARVIS_BOT_ID)!;
  assert.equal(jarvis.permissionMode, "auto-approve");
  assert.equal(jarvis.model, undefined);
  assert.equal(threadAgent({ agent: "codex" }, jarvis), "claude-code");
  assert.equal(threadAgent({}, jarvis), "claude-code");
});

test("Jarvis cannot be edited, deleted or have its setup changed", async () => {
  assert.equal((await call("PATCH", `/bots/${JARVIS_BOT_ID}`, { name: "Mine" })).status, 403);
  assert.equal((await call("DELETE", `/bots/${JARVIS_BOT_ID}`)).status, 403);
  assert.equal((await call("POST", `/bots/${JARVIS_BOT_ID}/setup`, { action: "complete" })).status, 403);
  assert.equal(getBot(JARVIS_BOT_ID)?.name, "Jarvis");
});

test("a record in bots.json cannot shadow Jarvis", () => {
  const file = join(dataDir(), "bots.json");
  createBot({ name: "placeholder" });
  const original = readFileSync(file, "utf-8");
  try {
    const shadow = { ...createBot({ name: "Fake Jarvis", instructions: "evil" }), id: JARVIS_BOT_ID };
    writeFileSync(file, JSON.stringify([...JSON.parse(original), shadow]));
    assert.equal(listBots(ALL_AGENTS).filter((b) => b.id === JARVIS_BOT_ID).length, 1);
    assert.equal(getBot(JARVIS_BOT_ID)?.name, "Jarvis");
  } finally {
    writeFileSync(file, original);
  }
});

test("a Jarvis thread runs in <dataDir>/jarvis on Claude Code, whatever folder or agent is passed", async () => {
  const res = await call("POST", "/threads", { botId: JARVIS_BOT_ID, repoPath: tmpdir(), agent: "codex" });
  assert.equal(res.status, 200);
  const thread = res.body.thread;
  assert.equal(thread.repoPath, join(dataDir(), "jarvis"));
  assert.equal(thread.repoPath, jarvisDir());
  assert.ok(existsSync(thread.repoPath));
  assert.equal(thread.agent, "claude-code");

  // Nor can it be moved afterwards.
  const patched = await call("PATCH", `/threads/${thread.id}`, { repoPath: tmpdir(), title: "Renamed" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.thread.repoPath, jarvisDir());
  assert.equal(patched.body.thread.title, "Renamed");
});

test("no Jarvis thread is made while Claude Code is missing", async () => {
  const res = await call("POST", "/threads", { botId: JARVIS_BOT_ID }, ["codex"]);
  assert.equal(res.status, 400);
  assert.equal(res.body.agentUnavailable, "claude-code");
});

// --- Tools ---

test("list_bots: ids and names only, not-ready markers, plain bots in, Jarvis out", () => {
  const ready = createBot({ name: "Ready Bot", description: "d", instructions: "secret job" });
  const pending = createBot({ name: "Pending Bot", setupInstructions: "install ffmpeg" });
  const failed = createBot({ name: "Failed Bot", setupInstructions: "install ffmpeg" });
  setSetupStatus(failed.id, "failed");
  const done = createBot({ name: "Done Bot", setupInstructions: "install ffmpeg" });
  setSetupStatus(done.id, "complete");

  const listed = listBotsForJarvis(["claude-code", "codex"]);
  const byId = new Map(listed.map((b) => [b.id, b]));

  assert.ok(!byId.has(JARVIS_BOT_ID));
  assert.ok(byId.has("builtin-claude-code"));
  assert.ok(byId.has("builtin-codex"));
  assert.ok(!byId.has("builtin-opencode"));

  assert.deepEqual(byId.get(ready.id), { id: ready.id, name: "Ready Bot" });
  assert.deepEqual(byId.get(pending.id), { id: pending.id, name: "Pending Bot", notReady: "setup pending" });
  assert.deepEqual(byId.get(failed.id), { id: failed.id, name: "Failed Bot", notReady: "setup failed" });
  assert.deepEqual(byId.get(done.id), { id: done.id, name: "Done Bot" });
  for (const b of listed) assert.deepEqual(Object.keys(b).filter((k) => !["id", "name", "notReady"].includes(k)), []);
});

test("get_bots: several ids in one call, instructions only with the flag", () => {
  const a = createBot({ name: "Alpha", description: "Reviews PRs", instructions: "Review hard", agent: "codex", repoPath: "/work/alpha" });
  const b = createBot({ name: "Beta", instructions: "Write tests", setupInstructions: "npm i" });

  const plain = getBotsForJarvis([a.id, b.id, "builtin-opencode", "nope", JARVIS_BOT_ID], false, ALL_AGENTS);
  assert.equal(plain.length, 5);
  assert.deepEqual(plain[0], {
    id: a.id, name: "Alpha", description: "Reviews PRs", agent: "codex", defaultFolder: "/work/alpha", setup: "not needed",
  });
  assert.equal((plain[1] as any).setup, "pending");
  assert.equal((plain[1] as any).agent, "claude-code");
  assert.equal((plain[2] as any).plainAgent, true);
  assert.equal((plain[2] as any).agent, "opencode");
  assert.ok("error" in plain[3]);
  assert.ok("error" in plain[4], "Jarvis is not one of its own abilities");
  for (const d of plain) assert.ok(!("instructions" in d));

  const full = getBotsForJarvis([a.id, b.id], true, ALL_AGENTS);
  assert.equal((full[0] as any).instructions, "Review hard");
  assert.equal((full[1] as any).instructions, "Write tests");
  assert.ok(getBotsForJarvis([a.id], false, ALL_AGENTS).every((d) => !("instructions" in d)));
});

test("get_bots: a plain bot whose agent is not installed is not offered", () => {
  const [codex, claude] = getBotsForJarvis(["builtin-codex", "builtin-claude-code"], false, ["claude-code"]);
  assert.deepEqual(codex, { id: "builtin-codex", error: "agent not installed" });
  assert.equal((claude as any).name, "Claude Code");
});

// --- /chat's resolution of a thread's turn ---

function jarvisThread(): Thread {
  return createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
}

test("resolveThreadTurn: a Jarvis thread is forced to its folder, default model and auto-approve", () => {
  const own = jarvisThread();
  const stale = { ...own, repoPath: tmpdir(), agent: "codex" as const };
  const turn = resolveThreadTurn(stale, getBot(JARVIS_BOT_ID)!, {
    model: "claude-haiku-4-5", permissionMode: "ask-permissions", mode: "plan",
  }, ALL_AGENTS);
  assert.ok(turn.ok);
  assert.equal(turn.repoPath, jarvisDir());
  assert.equal(turn.agent, "claude-code");
  assert.equal(turn.model, undefined);
  assert.equal(turn.permissionMode, "yolo");
  assert.equal(turn.mode, undefined);
  // The tool server learns its caller from the preset, not from Jarvis.
  assert.deepEqual(turn.preset.jarvis, { availableAgents: ALL_AGENTS, threadId: own.id });
});

test("resolveThreadTurn: a plain bot thread gets no jarvis key", () => {
  const thread = createThread("builtin-claude-code", tmpdir(), undefined, "chat", "claude-code");
  const turn = resolveThreadTurn(thread, getBot("builtin-claude-code")!, {}, ALL_AGENTS);
  assert.ok(turn.ok);
  assert.ok(!("jarvis" in turn.preset));
  assert.equal(turn.repoPath, tmpdir());
  assert.equal(turn.permissionMode, "ask-permissions");
});

test("resolveThreadTurn: a user bot keeps its own settings, and the request may override them", () => {
  const bot = createBot({ name: "Planner", instructions: "Plan", model: "claude-opus-4-1", permissionMode: "plan", allowedTools: ["Read"] });
  const thread = createThread(bot.id, tmpdir());
  const turn = resolveThreadTurn(thread, bot, {}, ALL_AGENTS);
  assert.ok(turn.ok);
  assert.ok(!("jarvis" in turn.preset));
  assert.equal(turn.repoPath, tmpdir());
  assert.equal(turn.model, "claude-opus-4-1");
  assert.equal(turn.permissionMode, "yolo");
  assert.equal(turn.mode, "plan");
  assert.deepEqual(turn.preset.allowedTools, ["Read"]);

  const overridden = resolveThreadTurn(thread, bot, { model: "m", permissionMode: "ask-permissions", mode: "build" }, ALL_AGENTS);
  assert.ok(overridden.ok);
  assert.equal(overridden.model, "m");
  assert.equal(overridden.permissionMode, "ask-permissions");
  assert.equal(overridden.mode, "build");
});

test("resolveThreadTurn: a setup thread is never Jarvis, and setup and missing agents refuse", () => {
  const bot = createBot({ name: "Needs ffmpeg", setupInstructions: "install ffmpeg", allowedTools: ["Read"] });
  const setup = resolveThreadTurn(createThread(bot.id, tmpdir(), "Set up", "setup"), bot, {}, ALL_AGENTS);
  assert.ok(setup.ok);
  assert.ok(!("jarvis" in setup.preset));
  assert.equal(setup.preset.setup, true);
  assert.equal(setup.preset.allowedTools, undefined);

  const work = resolveThreadTurn(createThread(bot.id, tmpdir()), bot, {}, ALL_AGENTS);
  assert.ok(!work.ok);
  assert.equal(work.status, 409);

  const missing = resolveThreadTurn(jarvisThread(), getBot(JARVIS_BOT_ID)!, {}, ["codex"]);
  assert.ok(!missing.ok);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.extra, { agentUnavailable: "claude-code" });
});

test("PATCH on a Jarvis thread cannot change its folder, agent, kind or session", async () => {
  const thread = jarvisThread();
  const res = await call("PATCH", `/threads/${thread.id}`, {
    repoPath: tmpdir(), agent: "codex", kind: "setup", sdkSessionId: "hijack", title: "Kept",
  });
  assert.equal(res.status, 200);
  const after = getThread(thread.id)!;
  assert.equal(after.repoPath, jarvisDir());
  assert.equal(after.agent, "claude-code");
  assert.equal(after.kind, "chat");
  assert.equal(after.sdkSessionId, null);
  assert.equal(after.title, "Kept");
});

// --- Wiring ---

test("the tool server is attached only to a Jarvis session, fresh each turn", () => {
  assert.deepEqual(jarvisQueryOptions(undefined), {});
  assert.deepEqual(jarvisQueryOptions({ id: "x", name: "Reviewer", instructions: "Review" }), {});
  assert.deepEqual(jarvisQueryOptions({ id: "builtin-claude-code", name: "Claude Code", instructions: "" }), {});

  const jarvisPreset = { id: JARVIS_BOT_ID, name: "Jarvis", instructions: "", jarvis: { availableAgents: ALL_AGENTS, threadId: "t" } };
  const first = jarvisQueryOptions(jarvisPreset).mcpServers!;
  const second = jarvisQueryOptions(jarvisPreset).mcpServers!;
  assert.deepEqual(Object.keys(first), [JARVIS_SERVER]);
  assert.equal(JARVIS_SERVER, "gitbot");
  assert.equal((first[JARVIS_SERVER] as any).type, "sdk");
  assert.equal((first[JARVIS_SERVER] as any).name, "gitbot");
  assert.notEqual(first[JARVIS_SERVER], second[JARVIS_SERVER]);
});

test("Jarvis's prompt replaces the bot framing, and only its own tools are auto-allowed by name", () => {
  const prompt = presetSystemPrompt({ id: JARVIS_BOT_ID, name: "Jarvis", instructions: "", jarvis: { availableAgents: [], threadId: "t" } });
  assert.match(prompt ?? "", /You are Jarvis/);
  assert.match(prompt ?? "", /DELEGATION/);
  assert.equal(presetSystemPrompt({ id: "builtin-claude-code", name: "Claude Code", instructions: "" }), undefined);

  assert.ok(isJarvisTool("mcp__gitbot__list_bots"));
  assert.ok(isJarvisTool("mcp__gitbot__get_bots"));
  assert.ok(!isJarvisTool("mcp__other__list_bots"));
  assert.ok(!isJarvisTool("Bash"));
});

test("Jarvis's prompt sorts each request, and delegates code reading with briefs it does not research", () => {
  const prompt = jarvisSystemPrompt();
  for (const section of ["YOUR ROLE:", "WHY YOU DELEGATE:", "BASIC TASKS", "YOU DO NOT READ CODE:", "FOLLOW-UPS:", "UPDATES:", "LAST CHECK, EVERY TURN:"]) {
    assert.ok(prompt.includes(section), section);
  }
  assert.match(prompt, /not from your own research/);
  assert.match(prompt, /checking\s+blast radius or callsites/);
  // Behaviour first, the tool reference after it.
  assert.ok(prompt.indexOf("REPORTS:") < prompt.indexOf("YOUR TOOLS"));
});

test("Jarvis's turn reminder reaches the agent and is stripped from history", () => {
  const sent = withJarvisReminder("review those changes");
  assert.match(sent, /^review those changes\n\n<gitbot-reminder>/);
  assert.equal(stripJarvisReminder(sent), "review those changes");
  assert.equal(stripJarvisReminder(withJarvisReminder("")), "");
  assert.equal(stripJarvisReminder("a message that mentions <gitbot-reminder> mid-text"), "a message that mentions <gitbot-reminder> mid-text");
});

// --- A live Jarvis session's settings ---

/** Drives the full request handler, as the HTTP server does. */
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
    if (body !== undefined) (req as unknown as EventEmitter).emit("data", JSON.stringify(body));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: JSON.parse(out) };
}

function idleJarvisSession() {
  const store = createSession(`jarvis-${Date.now()}-${Math.random()}`, "claude-code", jarvisDir(), undefined, undefined, "yolo", {
    threadId: "t",
    preset: { id: JARVIS_BOT_ID, name: "Jarvis", instructions: "", jarvis: { availableAgents: ALL_AGENTS, threadId: "t" } },
  });
  store.status = "done";
  return store;
}

test("a Jarvis session's permission mode cannot be changed mid-thread", async () => {
  const store = idleJarvisSession();
  const res = await serve("PATCH", `/sessions/${store.gitbotId}`, { permissionMode: "ask-permissions" });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /auto-approve/);
  assert.equal(store.permissionMode, "yolo");
  sessions.delete(store.gitbotId);
});

test("a bare /chat cannot reuse a Jarvis session to change its settings", async () => {
  const store = idleJarvisSession();
  const res = await serve("POST", "/chat", {
    sessionId: store.gitbotId, agent: "claude-code", repoPath: tmpdir(), prompt: "hi",
    model: "claude-haiku-4-5", permissionMode: "ask-permissions", mode: "plan",
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Jarvis turns need a threadId");
  assert.equal(store.model, undefined);
  assert.equal(store.mode, undefined);
  assert.equal(store.permissionMode, "yolo");
  assert.equal(store.status, "done");
  sessions.delete(store.gitbotId);
});
