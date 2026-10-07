import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bindSession, createThread, getThread, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import { claudeQuery } from "../src/start-claude-code";
import { createSession, sessions, type IRequest, type IResponse } from "../src/server-common";
import { handleRequest } from "../src/server";
import { JARVIS_SERVER } from "../src/jarvis";
import { DEFAULT_CLAUDE_MODEL } from "../src/context-window";
import { DEFAULT_CLAUDE_EFFORT, resetSupportedModels } from "../src/claude-models";

// Jarvis's model and effort, end to end: from `POST /chat` to the options
// object handed to the SDK.
//
// Why a separate file, stubbed where it is: the picker's other tests stop
// short of the SDK on one side or the other. model-effort-picker.test.ts stubs
// `agentRunners`, so it never reaches `query()`; claude-query-options.test.ts
// calls `runAgent` directly, so it never passes through `resolveThreadTurn` or
// `turns.ts`. Jarvis's model was pinned by code in exactly that gap — a clear
// in turns.ts that only ran on a reused session — so a test that skips either
// end cannot see it come back. This one leaves every runner real and stubs
// only `claudeQuery.run`, the seam in front of `query()`.

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// Transcripts are read from under CLAUDE_CONFIG_DIR. Each test file gets its
// own process, so this cannot disturb another file — or the real ~/.claude.
const configDir = mkdtempSync(join(tmpdir(), "gitbot-jarvis-cfg-"));
process.env.CLAUDE_CONFIG_DIR = configDir;

const realRun = claudeQuery.run;
let calls: any[] = [];
/** The session id the next stubbed run reports, so its thread binds to it. */
let nextSessionId = "sdk-jarvis-1";

claudeQuery.run = ((args: any) => {
  calls.push(args);
  const sessionId = nextSessionId;
  const messages = [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      message: { model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
    },
    {
      type: "result", subtype: "success", result: "ok",
      modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000, canonicalModel: "claude-opus-5-5" } },
      total_cost_usd: 0, duration_ms: 1, num_turns: 1,
    },
  ];
  return {
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    supportedModels: async () => [],
  } as any;
}) as typeof claudeQuery.run;

afterEach(() => {
  for (const s of sessions.values()) sessions.delete(s.gitbotId);
  calls = [];
  nextSessionId = "sdk-jarvis-1";
  resetSupportedModels();
});
after(() => { claudeQuery.run = realRun; });

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
  return { status, body: JSON.parse(out) };
}

/** POST /chat returns as soon as the run starts; wait for it to finish. */
async function turn(threadId: string, prompt: string, extra: Record<string, unknown> = {}) {
  const before = calls.length;
  const res = await serve("POST", "/chat", { threadId, prompt, ...extra });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  for (let i = 0; i < 200; i++) {
    const store = sessions.get(res.body.sessionId);
    if (calls.length > before && store && store.status !== "running") break;
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(calls.length, before + 1, "the turn reached the SDK exactly once");
  return calls[calls.length - 1].options as Record<string, any>;
}

const jarvisThread = () => createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");

/** The options really are a Jarvis turn's, not some other session's. */
function assertIsJarvisTurn(options: Record<string, any>): void {
  assert.ok(options.mcpServers?.[JARVIS_SERVER], "Jarvis's own tool server is attached");
  assert.equal(options.cwd, jarvisDir(), "it runs in Jarvis's folder");
  assert.equal(options.permissionMode, "default", "never plan mode, whatever was asked");
}

test("a fresh Jarvis turn sends the thread's pick to the SDK", async () => {
  const thread = jarvisThread();
  await serve("PATCH", `/threads/${thread.id}`, { model: "sonnet", effort: "xhigh" });
  const options = await turn(thread.id, "jarvis, what is running?");
  assertIsJarvisTurn(options);
  assert.equal(options.model, "sonnet");
  assert.equal(options.effort, "xhigh");
  assert.equal(options.resume, undefined, "a first turn has nothing to resume");
  assert.equal("fallbackModel" in options, false);
});

test("a Jarvis thread that picked nothing still sends an explicit default model and effort", async () => {
  const options = await turn(jarvisThread().id, "jarvis, hello");
  assertIsJarvisTurn(options);
  assert.equal(options.model, DEFAULT_CLAUDE_MODEL);
  assert.equal(options.effort, DEFAULT_CLAUDE_EFFORT);
});

test("a pick made between two Jarvis turns rides alongside resume on the second", async () => {
  // The real flow, both turns through /chat: the first binds the thread to its
  // SDK session, the user picks, the second resumes that session on the pick.
  const thread = jarvisThread();
  nextSessionId = "sdk-jarvis-resume";
  const first = await turn(thread.id, "jarvis, first");
  assert.equal(first.model, DEFAULT_CLAUDE_MODEL);
  assert.equal(getThread(thread.id)!.sdkSessionId, "sdk-jarvis-resume", "the first turn bound its session");

  await serve("PATCH", `/threads/${thread.id}`, { model: "haiku", effort: "low" });
  const second = await turn(thread.id, "jarvis, second");
  assertIsJarvisTurn(second);
  assert.equal(second.resume, "sdk-jarvis-resume", "the same conversation, resumed");
  assert.equal(second.model, "haiku");
  assert.equal(second.effort, "low");
});

test("a Jarvis turn on a reused session sends the pick — the branch the old clear lived on", async () => {
  // turns.ts used to clear model and effort here, on the reuse branch only. A
  // session found by its SDK id under the thread is that branch; the test above
  // can create a fresh store instead, which never ran the clear.
  const thread = jarvisThread();
  // Bound the way a real first turn binds it. Not via PATCH: that route
  // deliberately refuses to set a Jarvis thread's sdkSessionId.
  bindSession(thread.id, "sdk-jarvis-reused");
  await serve("PATCH", `/threads/${thread.id}`, { model: "fable", effort: "max" });
  const existing = createSession("sdk-jarvis-reused", "claude-code", jarvisDir());
  existing.sdkSessionId = "sdk-jarvis-reused";
  existing.status = "done";
  nextSessionId = "sdk-jarvis-reused";

  const options = await turn(thread.id, "jarvis, carry on");
  // Proof of the branch, not just that the map still holds the store: the
  // turn's prompt landed on the existing session's own event log.
  assert.ok(
    existing.events.some((e) => e.type === "user_prompt" && String(e.prompt).includes("jarvis, carry on")),
    "the turn ran on the reused session",
  );
  assertIsJarvisTurn(options);
  assert.equal(options.resume, "sdk-jarvis-reused");
  assert.equal(options.model, "fable");
  assert.equal(options.effort, "max");
});

test("a reopened Jarvis thread's meter is sized from its pick", async () => {
  // threadContext used to skip the thread's model for Jarvis, mirroring the old
  // pin — so a Jarvis thread on Haiku would read against a 1M window while its
  // turns ran on a 200k one, and the greying would have nothing to grey.
  const thread = jarvisThread();
  bindSession(thread.id, "sdk-jarvis-meter");
  const dir = join(configDir, "projects", jarvisDir().replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sdk-jarvis-meter.jsonl"), JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 150_000, output_tokens: 90 } },
  }));

  const unpicked = await serve("GET", `/threads/${thread.id}/messages`);
  assert.equal(unpicked.body.context.window, 1_000_000, "no pick: the default, which is long");

  await serve("PATCH", `/threads/${thread.id}`, { model: "haiku" });
  const picked = await serve("GET", `/threads/${thread.id}/messages`);
  assert.equal(picked.body.context.window, 200_000, "on Haiku: Haiku's window");
  assert.equal(picked.body.context.used, 150_100);
});

test("a Jarvis request still cannot move its permissions or mode", async () => {
  // The other half of the split: model and effort became the thread's, the
  // rest of what made Jarvis "fixed" did not.
  const thread = jarvisThread();
  const options = await turn(thread.id, "jarvis, plan it", { permissionMode: "ask-permissions", mode: "plan", model: "opus" });
  assertIsJarvisTurn(options);
  assert.equal(options.model, "opus", "the request's model is honoured, as for any Claude Code thread");
});
