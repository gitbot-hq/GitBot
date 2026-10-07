import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { claudeQuery, runAgent } from "../src/start-claude-code";
import { createSession, sessions, type BotPreset, type SessionStore } from "../src/server-common";
import { DEFAULT_CLAUDE_MODEL } from "../src/context-window";
import { DEFAULT_CLAUDE_EFFORT, resetSupportedModels } from "../src/claude-models";

// What the turn actually hands the SDK.
//
// Every other test in this suite stubs `agentRunners`, so it stops at
// `turns.ts` and asserts the plumbing rather than the result. These stub one
// level lower — at `claudeQuery.run`, the seam in front of `query()` — so the
// subject is the `options` object a run is built from. That object is the only
// place `model`, `effort` and `resume` are true of a run; `start-claude-code`
// settles the first two itself (`?? DEFAULT_*`), so a store that carries
// neither still has to arrive at the SDK with both.

const realRun = claudeQuery.run;
let calls: any[] = [];

/** Claude Code's own small-model helper work shows up in `modelUsage` on
 *  almost every turn, whatever the main model is. Observed, not invented —
 *  it is in all four shapes the 2026-10-07 probe captured, and it is the
 *  entry a careless "take the only one" or "take the largest" would pick. */
const HELPER_ENTRY = {
  "claude-haiku-4-5-20251001": { contextWindow: 200_000, canonicalModel: "claude-haiku-4-5" },
};

/** What the next run reports back. Defaults to a turn that resolves cleanly.
 *  `noRanAs` omits `message.model`, leaving the configured string as the only
 *  thing that can find the entry. */
let script: { ranAs?: string; noRanAs?: boolean; modelUsage?: Record<string, unknown> | undefined } = {};

/** A query that records its options and ends the turn cleanly. */
function stubQuery(): void {
  claudeQuery.run = ((args: any) => {
    calls.push(args);
    const ranAs = script.ranAs ?? "claude-opus-5-5";
    const modelUsage = "modelUsage" in script
      ? script.modelUsage
      : { ...HELPER_ENTRY, [ranAs]: { contextWindow: 1_000_000, canonicalModel: ranAs } };
    const messages = [
      { type: "system", subtype: "init", session_id: "sdk-session-1" },
      {
        type: "assistant",
        message: {
          ...(script.noRanAs ? {} : { model: ranAs }),
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [],
        },
      },
      { type: "result", subtype: "success", result: "ok", modelUsage, total_cost_usd: 0, duration_ms: 1, num_turns: 1 },
    ];
    const iterable: any = {
      async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
      // runAgent asks the live query for the account's model list, alongside
      // the run and awaited by nobody. Rejecting here is the realistic case
      // for a transport that cannot answer, and must not disturb the turn.
      supportedModels: async () => { throw new Error("not available in this stub"); },
    };
    return iterable;
  }) as typeof claudeQuery.run;
}

// The context meter warns when it cannot find the turn's own usage entry. A
// warning on a path that should have hit is a silent failure of exactly the
// kind this warning exists to prevent, so the tests watch for it.
const realWarn = console.warn;
let meterWarnings: string[] = [];

stubQuery();
console.warn = (...args: unknown[]) => { meterWarnings.push(args.join(" ")); };
afterEach(() => {
  for (const store of sessions.values()) sessions.delete(store.gitbotId);
  calls = [];
  script = {};
  meterWarnings = [];
  resetSupportedModels();
});
after(() => { claudeQuery.run = realRun; console.warn = realWarn; });

/** Warnings from the context meter only; the model-list capture warns too. */
const meterWarned = () => meterWarnings.filter((w) => w.includes("context meter"));

/** A claude-code session with a prompt waiting, as startTurn would leave it. */
function store(fields: Partial<SessionStore> = {}): SessionStore {
  const s = createSession(`gb-${Math.random().toString(36).slice(2)}`, "claude-code", tmpdir());
  Object.assign(s, fields);
  s.events.push({ seq: 0, type: "user_prompt", prompt: "do the thing" });
  return s;
}

const optionsOf = (i = 0) => calls[i].options as Record<string, any>;

test("a thread that picked nothing still reaches the SDK with an explicit model and effort", async () => {
  const s = store();
  await runAgent(s);
  assert.equal(calls.length, 1);
  // Not absent, not left to settings.json or CLAUDE_CODE_EFFORT_LEVEL: the
  // picker is the single source, so both are sent on every turn.
  assert.equal(optionsOf().model, DEFAULT_CLAUDE_MODEL);
  assert.equal(optionsOf().effort, DEFAULT_CLAUDE_EFFORT);
  // And the store is left holding what it ran, so the meter can name it.
  assert.equal(s.model, DEFAULT_CLAUDE_MODEL);
  assert.equal(s.effort, DEFAULT_CLAUDE_EFFORT);
});

test("a pick reaches the SDK verbatim, suffix and all", async () => {
  await runAgent(store({ model: "claude-opus-4-6[1m]", effort: "xhigh" }));
  assert.equal(optionsOf().model, "claude-opus-4-6[1m]");
  assert.equal(optionsOf().effort, "xhigh");
});

test("model and effort ride alongside resume, so a pick applies to the next turn of an existing session", async () => {
  // The whole "applies to the next turn" mechanism: nothing is pushed into a
  // running session, the full options object is re-sent with `resume`.
  const s = store({ sdkSessionId: "sdk-session-1", model: "sonnet", effort: "low" });
  await runAgent(s);
  assert.equal(optionsOf().resume, "sdk-session-1");
  assert.equal(optionsOf().model, "sonnet");
  assert.equal(optionsOf().effort, "low");

  // A pick made between turns is what the next one runs — on the same session.
  s.model = "haiku";
  s.effort = "max";
  s.events = [{ seq: 0, type: "user_prompt", prompt: "and again" }];
  await runAgent(s);
  assert.equal(calls.length, 2);
  assert.equal(optionsOf(1).resume, "sdk-session-1", "still the same conversation");
  assert.equal(optionsOf(1).model, "haiku");
  assert.equal(optionsOf(1).effort, "max");
});

test("a Jarvis turn runs the default model and effort, not an absent one", async () => {
  // turns.ts clears a Jarvis store's model/effort; this is what that means by
  // the time it reaches the SDK, which the turns.ts-level test cannot see.
  const jarvis: BotPreset = {
    id: "builtin-jarvis",
    name: "Jarvis",
    instructions: "",
    jarvis: { availableAgents: ["claude-code"], threadId: "t1" },
  };
  await runAgent(store({ model: undefined, effort: undefined, botPreset: jarvis }));
  assert.equal(optionsOf().model, DEFAULT_CLAUDE_MODEL);
  assert.equal(optionsOf().effort, DEFAULT_CLAUDE_EFFORT);
});

test("no fallbackModel is ever set: a refused model has to fail in the open", async () => {
  await runAgent(store({ model: "claude-opus-4-6[1m]" }));
  assert.equal("fallbackModel" in optionsOf(), false);
  // And the SDK's own thinking knob is left alone, as decided.
  assert.equal("thinking" in optionsOf(), false);
});

test("a turn survives the model-list capture failing", async () => {
  // supportedModels() rejects in the stub above. The turn must still finish.
  const s = store();
  await runAgent(s);
  assert.equal(s.status, "done");
});

// --- The window the turn was actually held to ---
//
// `result.modelUsage` is the one input that can correct the static window
// table, and it is not keyed by the configured string when that string is an
// alias. The payload shapes below are the ones the 2026-10-07 probe returned.
// Each asserts a window the static table could not have produced, so a hit is
// distinguishable from the fallback — and that nothing warned, since a warning
// on a hit path is how this gap stayed hidden in the first place.

test("step 1: a literal model id is echoed back as configured, and the helper entry does not fool it", async () => {
  // Probe: configured "claude-opus-5[1m]" → keys [helper, "claude-opus-5[1m]"].
  // Note the run reports itself as "claude-opus-5", without the suffix, so the
  // configured string is the only thing that finds this entry.
  script = {
    ranAs: "claude-opus-5",
    modelUsage: { ...HELPER_ENTRY, "claude-opus-5[1m]": { contextWindow: 777_000, canonicalModel: "claude-opus-5" } },
  };
  const s = store({ model: "claude-opus-5[1m]" });
  await runAgent(s);
  assert.equal(s.context?.window, 777_000, "the window came from modelUsage, not the table");
  assert.deepEqual(meterWarned(), []);
});

test("step 1 stands alone: the configured id finds the entry with no resolved id to help", async () => {
  // The run never said what it was, so `ranAs` is unknown and steps 2 and 3
  // cannot fire. Only the exact configured string is left.
  script = {
    noRanAs: true,
    modelUsage: { ...HELPER_ENTRY, "claude-sonnet-5-5": { contextWindow: 555_000, canonicalModel: "claude-sonnet-5-5" } },
  };
  const s = store({ model: "claude-sonnet-5-5" });
  await runAgent(s);
  assert.equal(s.context?.window, 555_000);
  assert.deepEqual(meterWarned(), []);
});

test("step 2: an alias is keyed by the id the run resolved to", async () => {
  // Probe: configured "default" → keys [helper, "claude-opus-5-5"], with no
  // "default" entry at all. This is the case that silently missed before.
  script = {
    ranAs: "claude-opus-5-5",
    modelUsage: { ...HELPER_ENTRY, "claude-opus-5-5": { contextWindow: 888_000, canonicalModel: "claude-opus-5-5" } },
  };
  const s = store({ model: "default" });
  await runAgent(s);
  assert.equal(s.context?.window, 888_000);
  assert.deepEqual(meterWarned(), []);
});

test("step 2: a short-window alias reads short, not the helper's identical number by luck", async () => {
  // Probe: configured "haiku" → keys ["claude-haiku-4-5-20251001"] only, which
  // is also the helper key. Use a distinct number so the assertion means
  // something rather than matching the helper entry by coincidence.
  script = {
    ranAs: "claude-haiku-4-5-20251001",
    modelUsage: { "claude-haiku-4-5-20251001": { contextWindow: 199_000, canonicalModel: "claude-haiku-4-5" } },
  };
  const s = store({ model: "haiku" });
  await runAgent(s);
  assert.equal(s.context?.window, 199_000);
  assert.deepEqual(meterWarned(), []);
});

test("step 3: neither key matches, so the entry is found by canonicalModel", async () => {
  // A thread stored the bare alias while the CLI echoed the suffixed id: the
  // configured string is absent, the resolved id is absent as a key, and only
  // `canonicalModel` ties the two together.
  script = {
    ranAs: "claude-opus-5",
    modelUsage: { ...HELPER_ENTRY, "claude-opus-5[1m]": { contextWindow: 666_000, canonicalModel: "claude-opus-5" } },
  };
  const s = store({ model: "opus" });
  await runAgent(s);
  assert.equal(s.context?.window, 666_000);
  assert.deepEqual(meterWarned(), []);
});

test("a genuine miss falls back to the table and says so", async () => {
  // Only the helper entry: nothing describes the main model's window. The
  // fallback is the number the table would have produced anyway, so without
  // the warning a miss and a correct table are indistinguishable.
  script = { ranAs: "claude-opus-5-5", modelUsage: { ...HELPER_ENTRY } };
  const s = store({ model: "default" });
  await runAgent(s);
  assert.equal(s.context?.window, 1_000_000, "the static table's answer for `default`");
  assert.equal(meterWarned().length, 1);
  assert.match(meterWarned()[0], /no modelUsage entry for "default"/);
  assert.match(meterWarned()[0], /ran as "claude-opus-5-5"/);
  assert.match(meterWarned()[0], /claude-haiku-4-5-20251001/, "the keys it did see are named");
});

test("a result with no modelUsage at all is a miss, not a crash", async () => {
  script = { modelUsage: undefined };
  const s = store({ model: "haiku" });
  await runAgent(s);
  assert.equal(s.status, "done");
  // Still sized, from the table: haiku is short.
  assert.equal(s.context?.window, 200_000);
  assert.deepEqual(meterWarned(), [], "nothing to warn about: the SDK sent no usage block");
});

test("a nonsense window in the entry is ignored rather than shown", async () => {
  script = {
    ranAs: "claude-opus-5-5",
    modelUsage: { "claude-opus-5-5": { contextWindow: 0, canonicalModel: "claude-opus-5-5" } },
  };
  const s = store({ model: "default" });
  await runAgent(s);
  assert.equal(s.context?.window, 1_000_000);
  assert.equal(meterWarned().length, 1);
});
