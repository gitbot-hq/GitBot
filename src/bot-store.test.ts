import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("changing agent replaces an unfinished setup thread", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gitbot-store-"));
  process.env.GITBOT_DATA_DIR = dir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = await import("./bot-store.js");
  const { recordSetupOutcome } = await import("./bot-prompt.js");
  const bot = store.createBot({
    name: "Setup bot",
    agent: "claude-code",
    setupInstructions: "Check the tool",
  });
  const first = store.ensureSetupThread(bot.id, dir)!;
  store.updateThread(first.id, { agent: "claude-code" });

  const changed = store.updateBot(bot.id, { agent: "codex" })!;
  assert.equal(changed.setupStatus, "pending");

  const replacement = store.ensureSetupThread(bot.id, dir)!;
  assert.notEqual(replacement.id, first.id);
  assert.equal(store.getThread(first.id), undefined);
  recordSetupOutcome(bot.id, "SETUP_COMPLETE", first.id);
  assert.equal(store.getBot(bot.id)?.setupStatus, "pending");
  recordSetupOutcome(bot.id, "SETUP_COMPLETE", replacement.id);
  assert.equal(store.getBot(bot.id)?.setupStatus, "complete");
});
