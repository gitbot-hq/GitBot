import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBot, dataDir, getBot, listThreads, threadAgent } from "../src/bot-store";
import { handleBotRoutes } from "../src/bot-routes";
import { presetSystemPrompt } from "../src/bot-prompt";
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

const builtinsIn = (bots: { builtin?: string; name: string }[]) =>
  bots.filter((b) => b.builtin).map((b) => b.name);

test("GET /bots lists a plain bot for each installed agent, and only those", async () => {
  assert.deepEqual(builtinsIn((await call("GET", "/bots", undefined, [])).body.bots), []);
  assert.deepEqual(builtinsIn((await call("GET", "/bots", undefined, ["codex"])).body.bots), ["Codex"]);
  assert.deepEqual(
    builtinsIn((await call("GET", "/bots", undefined, ["opencode", "claude-code"])).body.bots),
    ["Claude Code", "OpenCode"],
  );
  assert.deepEqual(builtinsIn((await call("GET", "/bots")).body.bots), ["Claude Code", "Codex", "OpenCode"]);
});

test("plain bots run their own agent with no instructions", async () => {
  const { bots } = (await call("GET", "/bots")).body;
  for (const bot of bots.filter((b: any) => b.builtin)) {
    assert.equal(bot.agent, bot.builtin);
    assert.equal(bot.instructions, "");
    assert.equal(bot.setupInstructions, undefined);
  }
});

test("user bots are listed first and are not built-in; built-ins are never stored", async () => {
  const mine = createBot({ name: "Reviewer", instructions: "Review the diff" });
  const { bots } = (await call("GET", "/bots")).body;
  const ids = bots.map((b: any) => b.id);
  assert.ok(ids.indexOf(mine.id) < ids.indexOf("builtin-claude-code"));
  assert.equal(bots.find((b: any) => b.id === mine.id).builtin, undefined);

  const stored = JSON.parse(readFileSync(join(dataDir(), "bots.json"), "utf-8"));
  assert.ok(stored.every((b: any) => !b.builtin && !String(b.id).startsWith("builtin-")));
});

test("a built-in bot cannot be edited, deleted or have its setup changed", async () => {
  // Refused whether or not its agent is installed here.
  for (const agents of [ALL_AGENTS, []]) {
    const patch = await call("PATCH", "/bots/builtin-codex", { name: "Mine now", instructions: "x" }, agents);
    assert.equal(patch.status, 403);
    const del = await call("DELETE", "/bots/builtin-codex", undefined, agents);
    assert.equal(del.status, 403);
    const setup = await call("POST", "/bots/builtin-codex/setup", { action: "complete" }, agents);
    assert.equal(setup.status, 403);
  }
  const bot = getBot("builtin-codex");
  assert.equal(bot?.name, "Codex");
  assert.equal(bot?.instructions, "");

  const get = await call("GET", "/bots/builtin-codex");
  assert.equal(get.status, 200);
  assert.equal(get.body.bot.builtin, "codex");
});

test("a stored bot cannot be turned into a built-in by a patch", async () => {
  const mine = createBot({ name: "Sneaky" });
  const res = await call("PATCH", `/bots/${mine.id}`, { builtin: "codex", name: "Still mine" });
  assert.equal(res.status, 200);
  assert.equal(res.body.bot.name, "Still mine");
  assert.equal(getBot(mine.id)?.builtin, undefined);
});

test("a thread with a plain bot runs on that bot's agent, with no system prompt", async () => {
  const res = await call("POST", "/threads", { botId: "builtin-opencode", repoPath: tmpdir(), agent: "codex" });
  assert.equal(res.status, 200);
  const thread = res.body.thread;
  assert.equal(thread.botId, "builtin-opencode");
  assert.equal(thread.agent, "opencode");

  const listed = await call("GET", "/threads?botId=builtin-opencode");
  assert.ok(listed.body.threads.some((t: any) => t.id === thread.id));

  // The preset /chat builds for this thread adds nothing to the agent's prompt.
  const bot = getBot(thread.botId)!;
  assert.equal(presetSystemPrompt({ id: bot.id, name: bot.name, instructions: bot.instructions }), undefined);
});

test("a plain bot's thread is not made while its agent is missing", async () => {
  const before = listThreads("builtin-codex").length;
  const res = await call("POST", "/threads", { botId: "builtin-codex", repoPath: tmpdir() }, ["claude-code"]);
  assert.equal(res.status, 400);
  assert.equal(res.body.agentUnavailable, "codex");
  assert.equal(listThreads("builtin-codex").length, before);
});

test("/chat's agent for a plain bot is the bot's, whatever the thread record says", () => {
  const codex = getBot("builtin-codex")!;
  assert.equal(threadAgent({ agent: "claude-code" }, codex), "codex");
  assert.equal(threadAgent({}, codex), "codex");
  // Other bots keep the agent of the thread's first turn, else their own.
  assert.equal(threadAgent({ agent: "opencode" }, { agent: "codex" }), "opencode");
  assert.equal(threadAgent({}, { agent: "codex" }), "codex");
  assert.equal(threadAgent({}, {}), "claude-code");
});

test("records in bots.json cannot pose as or shadow a built-in", async () => {
  const file = join(dataDir(), "bots.json");
  const original = readFileSync(file, "utf-8");
  try {
    const posing = { ...createBot({ name: "Poser" }), builtin: "claude-code" };
    const shadow = { ...createBot({ name: "Fake Codex", instructions: "evil" }), id: "builtin-codex" };
    const stored = JSON.parse(original);
    writeFileSync(file, JSON.stringify([...stored, posing, shadow]));

    const { bots } = (await call("GET", "/bots")).body;
    const codexes = bots.filter((b: any) => b.id === "builtin-codex");
    assert.equal(codexes.length, 1);
    assert.equal(codexes[0].name, "Codex");
    assert.equal(bots.find((b: any) => b.id === posing.id).builtin, undefined);

    assert.equal(getBot("builtin-codex")?.instructions, "");
    assert.equal(getBot(posing.id)?.builtin, undefined);
  } finally {
    writeFileSync(file, original);
  }
});
