import assert from "node:assert/strict";
import test from "node:test";

// The compiled module, not the source: the repository is CommonJS, so a .ts file
// under src/ cannot be imported directly by Node's type stripping. Testing the
// built artifact also means these assertions run against what actually ships.
// `npm test` builds first.
import { resolveModel } from "../dist/model-resolution.js";

// Every case passes its own env, so the suite is hermetic: a machine that
// happens to have ANTHROPIC_MODEL exported cannot change the result.

test("explicit bot model is used as-is", () => {
  assert.equal(resolveModel("claude-haiku-4-5", {}), "claude-haiku-4-5");
  assert.equal(resolveModel("deepseek-v4-flash", {}), "deepseek-v4-flash");

  // The bot's own setting wins over the environment.
  assert.equal(
    resolveModel("bot-choice", { ANTHROPIC_MODEL: "env-choice" }),
    "bot-choice",
  );
});

test("empty bot model falls through to the environment", () => {
  const env = { ANTHROPIC_MODEL: "env-choice" };

  for (const blank of [undefined, "", "   ", null]) {
    assert.equal(resolveModel(blank, env), "env-choice");
  }
});

test("ANTHROPIC_MODEL is used when the bot names no model", () => {
  assert.equal(
    resolveModel(undefined, { ANTHROPIC_MODEL: "deepseek-v4-flash" }),
    "deepseek-v4-flash",
  );

  // Surrounding whitespace is not part of the model name.
  assert.equal(resolveModel("", { ANTHROPIC_MODEL: "  padded  " }), "padded");
});

test("nothing configured yields undefined, not a default model", () => {
  // undefined means the model option is omitted entirely, so the CLI resolves
  // it. Any string here would be gitbot inventing a provider choice.
  const nothingConfigured = [
    [{}, undefined],
    [{ ANTHROPIC_MODEL: "" }, ""],
    [{ ANTHROPIC_MODEL: "   " }, "   "],
  ];

  for (const [env, botModel] of nothingConfigured) {
    assert.equal(resolveModel(botModel, env), undefined);
  }
});

test("gitbot never invents a model name", () => {
  // Regression guard for the removed `?? "claude-sonnet-4-6"` fallback: no
  // unset combination may produce a model the user did not ask for.
  const envs = [{}, { ANTHROPIC_MODEL: "" }, { ANTHROPIC_MODEL: "   " }];

  for (const env of envs) {
    for (const botModel of [undefined, "", "   ", null]) {
      assert.equal(resolveModel(botModel, env), undefined);
    }
  }
});
