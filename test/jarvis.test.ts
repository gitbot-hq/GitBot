import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createBot,
  dataDir,
  getBot,
  JARVIS_BOT_ID,
  jarvisDir,
  listBots,
  setSetupStatus,
  threadAgent,
} from "../src/bot-store";
import { handleBotRoutes } from "../src/bot-routes";
import { presetSystemPrompt } from "../src/bot-prompt";
import {
  getBotsForJarvis,
  isJarvisTool,
  JARVIS_SERVER,
  jarvisQueryOptions,
  listBotsForJarvis,
} from "../src/jarvis";
import type { IRequest, IResponse } from "../src/server-common";

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

test("Jarvis is listed first while Claude Code is installed, and not otherwise", () => {
  const bots = listBots(ALL_AGENTS);
  assert.equal(bots[0].id, JARVIS_BOT_ID);
  assert.equal(bots[0].builtin, "jarvis");
  assert.equal(bots.filter((b) => b.builtin === "jarvis").length, 1);
  assert.ok(!listBots(["codex"]).some((b) => b.id === JARVIS_BOT_ID));
  // Still found by id, so its threads resolve.
  assert.equal(getBot(JARVIS_BOT_ID)?.name, "Jarvis");
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

  const plain = getBotsForJarvis([a.id, b.id, "builtin-opencode", "nope", JARVIS_BOT_ID]);
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

  const full = getBotsForJarvis([a.id, b.id], true);
  assert.equal((full[0] as any).instructions, "Review hard");
  assert.equal((full[1] as any).instructions, "Write tests");
  assert.ok(getBotsForJarvis([a.id], false).every((d) => !("instructions" in d)));
});

// --- Wiring ---

test("the tool server is attached only to a Jarvis session, fresh each turn", () => {
  assert.deepEqual(jarvisQueryOptions(undefined), {});
  assert.deepEqual(jarvisQueryOptions({ id: "x", name: "Reviewer", instructions: "Review" }), {});
  assert.deepEqual(jarvisQueryOptions({ id: "builtin-claude-code", name: "Claude Code", instructions: "" }), {});

  const jarvisPreset = { id: JARVIS_BOT_ID, name: "Jarvis", instructions: "", jarvis: { availableAgents: ALL_AGENTS } };
  const first = jarvisQueryOptions(jarvisPreset).mcpServers!;
  const second = jarvisQueryOptions(jarvisPreset).mcpServers!;
  assert.deepEqual(Object.keys(first), [JARVIS_SERVER]);
  assert.equal(JARVIS_SERVER, "gitbot");
  assert.equal((first[JARVIS_SERVER] as any).type, "sdk");
  assert.equal((first[JARVIS_SERVER] as any).name, "gitbot");
  assert.notEqual(first[JARVIS_SERVER], second[JARVIS_SERVER]);
});

test("Jarvis's prompt replaces the bot framing, and only its own tools are auto-allowed by name", () => {
  const prompt = presetSystemPrompt({ id: JARVIS_BOT_ID, name: "Jarvis", instructions: "", jarvis: { availableAgents: [] } });
  assert.match(prompt ?? "", /You are Jarvis/);
  assert.match(prompt ?? "", /DELEGATION/);
  assert.equal(presetSystemPrompt({ id: "builtin-claude-code", name: "Claude Code", instructions: "" }), undefined);

  assert.ok(isJarvisTool("mcp__gitbot__list_bots"));
  assert.ok(isJarvisTool("mcp__gitbot__get_bots"));
  assert.ok(!isJarvisTool("mcp__other__list_bots"));
  assert.ok(!isJarvisTool("Bash"));
});
