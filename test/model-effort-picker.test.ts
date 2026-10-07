import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBot, createThread, dataDir, getThread, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import {
  contextUsage,
  contextWindowFor,
  DEFAULT_CLAUDE_MODEL,
  inFamily,
  modelLabel,
  isShortWindow,
  LONG_WINDOW_MODELS,
  LONG_WINDOW_PREFIXES,
  SHORT_WINDOW,
  SHORT_WINDOW_PREFIXES,
} from "../src/context-window";
import {
  DEFAULT_CLAUDE_EFFORT,
  EFFORT_LEVELS,
  isEffortLevel,
  isModelValue,
  MODEL_MAX_LENGTH,
  captureSupportedModels,
  resetSupportedModels,
  supportedClaudeModels,
} from "../src/claude-models";
import { createSession, sessions, type IRequest, type IResponse, type SessionStore } from "../src/server-common";
import { handleRequest } from "../src/server";
import { agentRunners } from "../src/turns";

// The per-thread model + effort picker: the window table it sizes the meter
// with, where a pick is kept, and what reaches the agent on the next turn.

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// Transcripts are read from under CLAUDE_CONFIG_DIR. Node's test runner gives
// each file its own process, so pointing it at a throwaway directory here
// cannot disturb another test file — or the real ~/.claude.
const configDir = mkdtempSync(join(tmpdir(), "gitbot-picker-cfg-"));
process.env.CLAUDE_CONFIG_DIR = configDir;

const realRunners = { ...agentRunners };
let runs: SessionStore[] = [];
for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
  agentRunners[agent] = async (store) => {
    runs.push(store);
    store.status = "done";
  };
}
afterEach(() => {
  for (const store of runs) sessions.delete(store.gitbotId);
  runs = [];
});
after(() => { Object.assign(agentRunners, realRunners); });

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

const claudeThread = () => createThread("builtin-claude-code", tmpdir(), undefined, "chat", "claude-code");

/**
 * Writes straight into threads.json, past every validator — what a hand edit,
 * another tool, or a build with a different enum would leave behind.
 */
function writeThreadFieldsRaw(id: string, fields: Record<string, unknown>): void {
  const file = join(dataDir(), "threads.json");
  const threads = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>[];
  const thread = threads.find((t) => t.id === id)!;
  Object.assign(thread, fields);
  writeFileSync(file, JSON.stringify(threads, null, 2), "utf-8");
}

// --- The window table ---

// Each window below was measured against a live session with
// `Query.getContextUsage({ detail: "summary" })` on 2026-10-07.
test("the short-window models are Haiku 4.5 and the 4.6 pair, and nothing else", () => {
  for (const model of ["haiku", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-sonnet-4-6"]) {
    assert.equal(contextWindowFor(model), SHORT_WINDOW, model);
  }
  // 0.3.x made these natively 1M, with no [1m] suffix to ask for it. Note 4.7
  // and 4.8 are long while 4.6 is short: the generation does not decide it.
  for (const model of ["default", "opus", "fable", "sonnet", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-4-7", "claude-opus-4-8"]) {
    assert.equal(contextWindowFor(model), 1_000_000, model);
  }
  // Nothing configured: the default model's window, not the short one.
  assert.equal(contextWindowFor(undefined), 1_000_000);
  assert.equal(contextWindowFor(DEFAULT_CLAUDE_MODEL), 1_000_000);
});

test("an explicit [1m] is the long window, including on a model that is short without it", () => {
  // Measured: claude-opus-4-6[1m] reports 1M. The CLI refuses the suffix where
  // it cannot be granted (haiku[1m], sonnet-4-6[1m] on this account), so a run
  // that reports usage at all really does have the long window.
  for (const model of ["claude-opus-4-6[1m]", "claude-fable-5-1[1m]", "claude-opus-5[1m]", "sonnet[1m]"]) {
    assert.equal(contextWindowFor(model), 1_000_000, model);
  }
});

test("a build of a short-window family this table has not learned about is still sized short", () => {
  // The live list is forwarded to the picker verbatim and changes server-side,
  // so a new row can appear without this table being edited. Guessing 1M for a
  // 200k model is the harmful direction: the meter would under-report.
  for (const model of [
    "claude-haiku-4-5-20251001", "claude-opus-4-6-20260101", "claude-sonnet-4-6-20251215",
    // Haiku is matched as a whole family, not per version: the tier is the one
    // most likely to stay short, so an unmeasured future build is assumed so.
    "claude-haiku-5", "claude-haiku-5-20270101", "claude-haiku-6",
  ]) {
    assert.equal(contextWindowFor(model), SHORT_WINDOW, model);
  }
  // The known-long models stay long, including dated builds of them.
  for (const model of ["default", "opus", "sonnet", "fable", "claude-opus-5-5", "claude-sonnet-5-5",
                       "claude-fable-5-1", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-4-7-20260101"]) {
    assert.equal(contextWindowFor(model), 1_000_000, model);
  }
});

test("a model this build does not recognise is assumed short, not long", () => {
  // Deliberate: sizing a 200k model as 1M under-reports how full the window is,
  // never greys it out, and surfaces nothing until a turn fails. Sizing a 1M
  // model as 200k over-reports, which is visible on the meter and reportable.
  // The benefit of the doubt goes to the direction a user can see.
  for (const model of ["claude-opus-9", "claude-mythos-1", "claude-opus-4-61", "claude-haikuish-5", "whatever"]) {
    assert.equal(contextWindowFor(model), SHORT_WINDOW, model);
  }
  // These exist today on other plans and are 200k — named in the table so they
  // are right because they are known, not because of the fallback.
  for (const model of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-5-haiku"]) {
    assert.equal(contextWindowFor(model), SHORT_WINDOW, model);
  }
  // "Nothing configured" is not "unrecognised": the thread runs the default,
  // which is long. Same for a value too broken to use — the turn drops it and
  // falls back to the default too, so the meter must agree.
  assert.equal(contextWindowFor(undefined), 1_000_000);
  assert.equal(contextWindowFor(""), 1_000_000);
  assert.equal(contextWindowFor({ a: 1 } as unknown as string), 1_000_000);
});

test("every public entry point survives a model that is not a string", () => {
  // Not covered by going through contextWindowFor: modelLabel does its own
  // `.includes` and threw independently, so a guard on its sibling left
  // contextUsage — the function the meter actually calls — still loaded.
  for (const bad of [{ a: 1 }, ["x"], 7, true, null] as unknown as string[]) {
    assert.doesNotThrow(() => modelLabel(bad), `modelLabel(${JSON.stringify(bad)})`);
    assert.equal(modelLabel(bad), "");
    assert.doesNotThrow(() => contextUsage(5, bad), `contextUsage(${JSON.stringify(bad)})`);
    const usage = contextUsage(5, bad);
    // And the value never escapes as a non-string: this struct is serialized
    // to the browser, which does its own string work on `model`.
    assert.equal(typeof usage.model, "string");
    assert.equal(usage.model, "");
    assert.equal(typeof usage.label, "string");
    assert.equal(usage.window, 1_000_000, "unusable means 'not configured', which runs the default");
  }
  // The real path still works.
  assert.equal(modelLabel("claude-opus-5[1m]"), "Opus 5 (1M context)");
  assert.equal(contextUsage(5, "haiku").window, SHORT_WINDOW);
});

test("a family prefix has to end on a token boundary", () => {
  // Only exercised through contextWindowFor before. `claude-opus-4-6` must not
  // claim `claude-opus-4-61`, which is a different model.
  assert.equal(inFamily("claude-opus-4-6", "claude-opus-4-6"), true);
  assert.equal(inFamily("claude-opus-4-6-20260101", "claude-opus-4-6"), true);
  assert.equal(inFamily("claude-opus-4-6[1m]", "claude-opus-4-6"), true);
  assert.equal(inFamily("claude-opus-4-61", "claude-opus-4-6"), false);
  assert.equal(inFamily("claude-haikuish", "claude-haiku"), false);
  assert.equal(inFamily("claude-opus-5-5", "claude-opus-5"), true);
  assert.equal(inFamily("claude-opus-51", "claude-opus-5"), false);
  assert.equal(inFamily("sonnet", "claude-sonnet-5"), false);
});

test("sizing consults resolvedModel, because an alias name says nothing about its family", () => {
  // The row is what the SDK sends; its name can be anything. Matching the value
  // alone would size a Haiku-backed alias as 1M and never grey it.
  assert.equal(contextWindowFor("some-alias", "claude-haiku-4-5-20251001"), SHORT_WINDOW);
  assert.equal(contextWindowFor("default", "claude-haiku-4-5-20251001"), SHORT_WINDOW,
    "even `default` is only long because of what it resolves to");
  assert.equal(contextWindowFor("some-alias", "claude-opus-5-5"), 1_000_000);
  // A short-looking alias that resolves long is long: `[1m]` anywhere wins.
  assert.equal(contextWindowFor("haiku-ish", "claude-opus-4-6[1m]"), 1_000_000);
});

test("isShortWindow honours [1m] on its own, not only through contextWindowFor", () => {
  // Exported, so the next caller will not necessarily have the suffix check in
  // front of it. A short family with an explicit long window is not short.
  assert.equal(isShortWindow("claude-opus-4-6[1m]"), false);
  assert.equal(isShortWindow("claude-opus-4-6"), true);
  assert.equal(isShortWindow("claude-haiku-5"), true);
  assert.equal(isShortWindow("sonnet"), false);
  // Same answer as the window function it backs, for every shape.
  for (const model of ["claude-opus-4-6[1m]", "claude-opus-4-6", "haiku", "claude-haiku-5", "sonnet", "default"]) {
    assert.equal(isShortWindow(model), contextWindowFor(model) === SHORT_WINDOW, model);
  }
});

test("effort and model values are checked at the boundary, not trusted", () => {
  assert.ok(isEffortLevel("xhigh"));
  assert.ok(!isEffortLevel("xxhigh"));
  assert.ok(!isEffortLevel(undefined));
  assert.ok(isModelValue("claude-opus-4-6[1m]"));
  // A model reaches both the SDK's argv and contextWindowFor's string work,
  // so a non-string must not get past the boundary.
  for (const bad of [{ a: 1 }, ["x"], 7, true, null, "", "   ", "x".repeat(MODEL_MAX_LENGTH + 1)]) {
    assert.ok(!isModelValue(bad), JSON.stringify(bad));
  }
});

// --- Where a pick lives ---

test("a pick is stored on the thread, so it outlives the in-memory session", async () => {
  const thread = claudeThread();
  const saved = await serve("PATCH", `/threads/${thread.id}`, { model: "sonnet", effort: "xhigh" });
  assert.equal(saved.status, 200);
  // Read back through the store, which is threads.json and nothing else: the
  // same read a restarted gitbot does.
  assert.equal(getThread(thread.id)!.model, "sonnet");
  assert.equal(getThread(thread.id)!.effort, "xhigh");
});

test("a bad effort level is refused and nothing is stored", async () => {
  const thread = claudeThread();
  const bad = await serve("PATCH", `/threads/${thread.id}`, { effort: "ludicrous" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /effort must be one of/);
  const blank = await serve("PATCH", `/threads/${thread.id}`, { model: "  " });
  assert.equal(blank.status, 400);
  assert.equal(getThread(thread.id)!.effort, undefined);
  assert.equal(getThread(thread.id)!.model, undefined);
});

// --- What reaches the turn ---

test("the thread's stored pick is what the next turn runs", async () => {
  const thread = claudeThread();
  await serve("PATCH", `/threads/${thread.id}`, { model: "haiku", effort: "low" });
  const res = await serve("POST", "/chat", { threadId: thread.id, prompt: "hello there" });
  assert.equal(res.status, 200);
  assert.equal(runs[0].model, "haiku");
  assert.equal(runs[0].effort, "low");
});

test("the turn's own model and effort beat the stored pick", async () => {
  const thread = claudeThread();
  await serve("PATCH", `/threads/${thread.id}`, { model: "haiku", effort: "low" });
  const res = await serve("POST", "/chat", { threadId: thread.id, prompt: "hello there", model: "opus", effort: "max" });
  assert.equal(res.status, 200);
  assert.equal(runs[0].model, "opus");
  assert.equal(runs[0].effort, "max");
});

test("/chat refuses an effort level the SDK does not have", async () => {
  const thread = claudeThread();
  const res = await serve("POST", "/chat", { threadId: thread.id, prompt: "hello there", effort: "turbo" });
  assert.equal(res.status, 400);
  assert.equal(runs.length, 0);
});

test("/chat refuses a model that is not a usable string, rather than carrying it into the turn", async () => {
  const thread = claudeThread();
  // {a:1} used to reach contextWindowFor and throw "model.includes is not a
  // function" from inside the running turn; ["x"] used to pass the window
  // table (arrays have .includes) and reach the SDK as an argv value.
  for (const model of [{ a: 1 }, ["x"], 7, "", "x".repeat(MODEL_MAX_LENGTH + 1)]) {
    const res = await serve("POST", "/chat", { threadId: thread.id, prompt: "hello there", model });
    assert.equal(res.status, 400, JSON.stringify(model));
    assert.match(res.body.error, /model must be/);
  }
  assert.equal(runs.length, 0);
});

test("a stored value outside the enum is dropped on read, not forwarded to the agent", async () => {
  const thread = claudeThread();
  await serve("PATCH", `/threads/${thread.id}`, { model: "sonnet", effort: "high" });
  // threads.json is a plain file: another tool, or an older build with a
  // different enum, can put anything in it. The CLI accepts an unknown effort
  // and silently ignores it, so forwarding one runs at a level no layer agrees
  // with. Degrade to the default, exactly as an absent value does.
  writeThreadFieldsRaw(thread.id, { effort: "turbo" });
  await serve("POST", "/chat", { threadId: thread.id, prompt: "hello there" });
  assert.equal(runs[0].effort, undefined, "an unknown stored effort must not reach the run");
  assert.equal(runs[0].model, "sonnet", "the model beside it is still good and still applies");

  runs = [];
  writeThreadFieldsRaw(thread.id, { model: { a: 1 } as unknown as string });
  await serve("POST", "/chat", { threadId: thread.id, prompt: "hello there" });
  assert.equal(runs[0].model, undefined, "an unusable stored model must not reach the run");
});

test("a malformed stored model degrades the thread view too, rather than making it unopenable", async () => {
  // Needs a transcript on disk: without one the reader returns before it ever
  // sizes a window, so the crash path is not reached and the test proves nothing.
  const repoPath = mkdtempSync(join(tmpdir(), "gitbot-ctxrepo-"));
  const dir = join(configDir, "projects", repoPath.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ctx-1.jsonl"), JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 90 } },
  }));
  const thread = createThread("builtin-claude-code", repoPath, undefined, "chat", "claude-code");
  await serve("PATCH", `/threads/${thread.id}`, { sdkSessionId: "ctx-1" });

  // Sanity: a good model sizes the meter, so the path really is live.
  await serve("PATCH", `/threads/${thread.id}`, { model: "haiku" });
  const good = await serve("GET", `/threads/${thread.id}/messages`);
  assert.equal(good.body.context.window, 200_000);

  // The turn path validated this, but the read path handed it straight to
  // contextWindowFor's string work: `model.includes` threw, GET returned 500,
  // and the thread could not be opened at all.
  writeThreadFieldsRaw(thread.id, { model: { a: 1 } as unknown as string });
  const res = await serve("GET", `/threads/${thread.id}/messages`);
  assert.equal(res.status, 200, "the thread still opens");
  assert.equal(res.body.context.used, 1100);
  // Degraded to the default model's window, which is what the turn will run
  // once resolveThreadTurn drops the same value.
  assert.equal(res.body.context.window, 1_000_000);
});

test("a pick made between turns reaches the session the second turn reuses", async () => {
  // Every other test here runs the create-a-session branch, because a stubbed
  // runner never binds an sdkSessionId. This is the other branch: a thread
  // whose session already exists, where the pick has to be written onto the
  // store that is being reused rather than onto a fresh one.
  const thread = claudeThread();
  await serve("PATCH", `/threads/${thread.id}`, { sdkSessionId: "sdk-1", model: "sonnet", effort: "low" });
  const existing = createSession("sdk-1", "claude-code", tmpdir());
  existing.sdkSessionId = "sdk-1";
  existing.status = "done";

  await serve("POST", "/chat", { threadId: thread.id, prompt: "first turn here" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0], existing, "the turn reused the thread's existing session");
  assert.equal(runs[0].model, "sonnet");
  assert.equal(runs[0].effort, "low");

  runs = [];
  existing.status = "done";
  await serve("PATCH", `/threads/${thread.id}`, { model: "haiku", effort: "max" });
  await serve("POST", "/chat", { threadId: thread.id, prompt: "second turn here" });
  assert.equal(runs[0], existing, "still the same session");
  assert.equal(runs[0].model, "haiku", "the new pick replaced the old one on the reused store");
  assert.equal(runs[0].effort, "max");
  sessions.delete("sdk-1");
});

test("a thread's pick beats its bot's model, which still applies when nothing is picked", async () => {
  const bot = createBot({ name: "Pinned", instructions: "work", agent: "claude-code", model: "claude-opus-5-5", permissionMode: "auto-approve" });
  const thread = createThread(bot.id, tmpdir(), undefined, "chat", "claude-code");
  await serve("POST", "/chat", { threadId: thread.id, prompt: "the bot's own model" });
  assert.equal(runs[0].model, "claude-opus-5-5");
  runs = [];
  await serve("PATCH", `/threads/${thread.id}`, { model: "sonnet" });
  await serve("POST", "/chat", { threadId: thread.id, prompt: "the thread's pick" });
  assert.equal(runs[0].model, "sonnet");
});

test("effort and model are Claude Code's: a codex thread is left alone", async () => {
  const thread = createThread("builtin-codex", tmpdir(), undefined, "chat", "codex");
  await serve("PATCH", `/threads/${thread.id}`, { model: "sonnet", effort: "max" });
  await serve("POST", "/chat", { threadId: thread.id, prompt: "codex, do a thing" });
  assert.equal(runs[0].agent, "codex");
  assert.equal(runs[0].model, undefined);
  assert.equal(runs[0].effort, undefined);
});

test("a Jarvis thread runs the default model at no chosen effort, whatever is stored", async () => {
  const thread = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  await serve("PATCH", `/threads/${thread.id}`, { model: "haiku", effort: "low" });
  await serve("POST", "/chat", { threadId: thread.id, prompt: "jarvis, plan something" });
  assert.equal(runs[0].model, undefined);
  assert.equal(runs[0].effort, undefined);
});

// --- First paint ---

test("GET /claude-models answers before any session has run, with no list to give", async () => {
  // Explicit, not incidental: any other test in this process that captures a
  // list would otherwise decide this one's answer.
  resetSupportedModels();
  const res = await serve("GET", "/claude-models");
  assert.equal(res.status, 200);
  // null, not []: the browser has to tell "no session yet" from "no models",
  // because the first means show the fallback list.
  assert.equal(res.body.models, null);
  assert.deepEqual(res.body.effortLevels, [...EFFORT_LEVELS]);
  assert.equal(res.body.defaultEffort, DEFAULT_CLAUDE_EFFORT);
});

test("the model list is captured from a live query, and a bad answer is not", async () => {
  const settle = () => new Promise((r) => setImmediate(r));
  const rows = [{ value: "sonnet", displayName: "Sonnet 5.5", description: "x" }];

  resetSupportedModels();
  captureSupportedModels({ supportedModels: async () => rows });
  await settle();
  assert.deepEqual(supportedClaudeModels(), rows);

  // Captured once: the list is the account's, not the session's, so a later
  // turn must not pay for it again or replace it.
  captureSupportedModels({ supportedModels: async () => { throw new Error("should not be asked"); } });
  await settle();
  assert.deepEqual(supportedClaudeModels(), rows);

  // A rejection leaves the picker on its fallback rather than taking the turn
  // down with it — supportedModels is fired alongside the run, not awaited.
  resetSupportedModels();
  captureSupportedModels({ supportedModels: async () => { throw new Error("no transport"); } });
  await settle();
  assert.equal(supportedClaudeModels(), null);

  // Shapes that are not a list of rows are refused, so the browser never has
  // to defend against a half-answer.
  for (const bad of [null, undefined, "nope", {}, [{ displayName: "no value" }], [{ value: "no name" }]]) {
    resetSupportedModels();
    captureSupportedModels({ supportedModels: async () => bad });
    await settle();
    assert.equal(supportedClaudeModels(), null, JSON.stringify(bad));
  }
  resetSupportedModels();
});

// --- The two short-window tables that must not drift ---

test("the UI's short-window tables match the server's", async () => {
  const ui = await import("../ui/app/lib/claude-models");
  const server = await import("../src/context-window");
  // The meter sizes from the server's copy and the picker greys from the UI's.
  // If they disagree, a model is greyed but sized long, or sized short but
  // offered — the two comments saying "keep in step" are what this enforces.
  assert.deepEqual([...ui.SHORT_WINDOW_MODELS].sort(), [...server.SHORT_WINDOW_MODELS].sort());
  assert.deepEqual([...ui.SHORT_WINDOW_PREFIXES].sort(), [...SHORT_WINDOW_PREFIXES].sort());
  assert.deepEqual([...ui.LONG_WINDOW_MODELS].sort(), [...LONG_WINDOW_MODELS].sort());
  assert.deepEqual([...ui.LONG_WINDOW_PREFIXES].sort(), [...LONG_WINDOW_PREFIXES].sort());
  // And they must agree model by model, not just as sets — including on the
  // resolvedModel path and on models neither table knows.
  const cases: Array<[string, string?]> = [
    ["haiku"], ["claude-haiku-4-5-20251001"], ["claude-opus-4-6"], ["claude-opus-4-6-20260101"],
    ["claude-sonnet-4-6"], ["sonnet"], ["default"], ["claude-opus-4-7"], ["claude-opus-4-6[1m]"],
    ["claude-haiku-5"], ["claude-haiku-5-20270101"], ["claude-haikuish-5"], ["claude-opus-4-61"],
    ["claude-opus-4-5"], ["claude-3-5-haiku"], ["claude-opus-9"], ["claude-opus-5-5"],
    ["some-alias", "claude-haiku-4-5-20251001"], ["some-alias", "claude-opus-5-5"],
    ["default", "claude-haiku-4-5-20251001"], ["haiku-ish", "claude-opus-4-6[1m]"],
  ];
  for (const [model, resolved] of cases) {
    assert.equal(
      ui.isShortWindowModel(model, resolved),
      server.contextWindowFor(model, resolved) === SHORT_WINDOW,
      `UI and server disagree about ${model}${resolved ? ` → ${resolved}` : ""}`,
    );
  }
});

// --- The picker's own decisions, extracted so they can be tested ---
// chat.tsx has no test harness; these are the pure functions it calls.

test("modelFit: a model is refused before the conversation reaches its window, not at it", async () => {
  const { modelFit, WINDOW_HEADROOM, SHORT_WINDOW: UI_SHORT } = await import("../ui/app/lib/claude-models");
  const haiku = { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" };
  // A turn resends the whole conversation and then writes a reply, so a thread
  // sitting just under a window is certain to pass it on the next turn.
  assert.equal(modelFit(haiku, 199_000, false).blocked, true, "199k against a 200k window cannot work");
  assert.equal(modelFit(haiku, UI_SHORT * WINDOW_HEADROOM, false).blocked, false, "exactly at the headroom still fits");
  assert.equal(modelFit(haiku, 10_000, false).blocked, false);
  assert.equal(modelFit(haiku, 10_000, false).note, undefined, "nothing to say when it fits");
  // A long model is not refused at the same point.
  const opus = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" };
  assert.equal(modelFit(opus, 199_000, false).blocked, false);
  assert.equal(modelFit(opus, 950_000, false).blocked, true, "the headroom applies to the long window too");
});

test("modelFit: the current pick is warned about, never blocked", async () => {
  const { modelFit } = await import("../ui/app/lib/claude-models");
  const haiku = { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" };
  const current = modelFit(haiku, 300_000, true);
  // Blocking the row a thread is already on would say "you cannot pick what you
  // have picked" — and with unknown models now assumed short, it could strand a
  // thread with no selectable row at all.
  assert.equal(current.blocked, false);
  assert.match(current.note!, /pick a model with a larger window/i);
  assert.equal(modelFit(haiku, 300_000, false).blocked, true);
});

test("modelFit: an unrecognised model's tooltip says the window is assumed, not known", async () => {
  const { modelFit } = await import("../ui/app/lib/claude-models");
  const known = modelFit({ value: "haiku", displayName: "Haiku 4.5" }, 300_000, false);
  assert.match(known.note!, /Haiku 4\.5's 200,000-token window/);
  const unknown = modelFit({ value: "claude-opus-9", displayName: "Opus 9" }, 300_000, false);
  // Honest about the limit of our own knowledge: claiming Opus 9 is a small
  // model would be a statement the user cannot check and we cannot support.
  assert.match(unknown.note!, /assumes/);
  assert.match(unknown.note!, /does not know/);
  assert.doesNotMatch(unknown.note!, /Opus 9's 200,000-token window/);
});

test("modelRow prefers a real model row over the recommendation pointer", async () => {
  const { modelRow, modelDisplayName, FALLBACK_CLAUDE_MODELS } = await import("../ui/app/lib/claude-models");
  // `default` and `opus` both resolve to claude-opus-5-5. A thread pinned to
  // the literal id should read as the model, not as "Default (recommended)".
  assert.equal(modelRow(FALLBACK_CLAUDE_MODELS, "claude-opus-5-5")?.value, "opus");
  assert.equal(modelDisplayName(FALLBACK_CLAUDE_MODELS, "claude-opus-5-5"), "Opus 5.5");
  // An exact value match still wins over any resolution.
  assert.equal(modelRow(FALLBACK_CLAUDE_MODELS, "default")?.value, "default");
});

test("derivedModelName names a value no list accounts for", async () => {
  const { derivedModelName, modelRow, FALLBACK_CLAUDE_MODELS } = await import("../ui/app/lib/claude-models");
  assert.equal(derivedModelName("claude-opus-6-1[1m]"), "Opus 6.1");
  assert.equal(derivedModelName("claude-opus-5-5"), "Opus 5.5");
  // A trailing date stamp is not a version number.
  assert.equal(derivedModelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(derivedModelName("fable"), "Fable");
  assert.equal(derivedModelName("default"), "Default");
  // Unparseable input is shown as-is rather than mangled into a wrong name.
  assert.equal(derivedModelName("some-weird-thing"), "some-weird-thing");
  assert.equal(derivedModelName(""), "");
  // modelRow falls back from the row's own value to the row it resolves to.
  assert.equal(modelRow(FALLBACK_CLAUDE_MODELS, "sonnet")?.displayName, "Sonnet 5.5");
  assert.equal(modelRow(FALLBACK_CLAUDE_MODELS, "claude-sonnet-5-5")?.displayName, "Sonnet 5.5");
  assert.equal(modelRow(FALLBACK_CLAUDE_MODELS, "claude-opus-9"), null);
});
