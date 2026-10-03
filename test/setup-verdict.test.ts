import { TEST_DATA_DIR } from "./temp-data-dir";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBot, dataDir, getBot } from "../src/bot-store";
import { recordSetupOutcome, recordSetupOutcomeFromEvents } from "../src/bot-prompt";
import type { SessionStore } from "../src/server-common";

function newSetupBot(): string {
  const bot = createBot({ name: "Setup test", setupInstructions: "ffmpeg must be on PATH" });
  assert.equal(bot.setupStatus, "pending");
  return bot.id;
}

const statusOf = (id: string) => getBot(id)?.setupStatus;

test("the store lives in a per-run temp dir, not ~/.gitbot", () => {
  assert.equal(dataDir(), TEST_DATA_DIR);
  assert.ok(TEST_DATA_DIR.startsWith(join(tmpdir(), "gitbot-test-")));
  newSetupBot();
  assert.ok(existsSync(join(TEST_DATA_DIR, "bots.json")));
});

test("SETUP_COMPLETE marks the bot complete", () => {
  const id = newSetupBot();
  recordSetupOutcome(id, "ffmpeg 6.1 is installed.\nSETUP_COMPLETE");
  assert.equal(statusOf(id), "complete");
});

test("SETUP_FAILED marks the bot failed", () => {
  const id = newSetupBot();
  recordSetupOutcome(id, "Homebrew is missing.\nSETUP_FAILED: brew is not installed");
  assert.equal(statusOf(id), "failed");
});

test("the last marker wins", () => {
  const failedThenFixed = newSetupBot();
  recordSetupOutcome(failedThenFixed, "SETUP_FAILED: no brew\n...installed brew...\nSETUP_COMPLETE");
  assert.equal(statusOf(failedThenFixed), "complete");

  const completeThenBroken = newSetupBot();
  recordSetupOutcome(completeThenBroken, "SETUP_COMPLETE\nlater...\nSETUP_FAILED: ffmpeg removed");
  assert.equal(statusOf(completeThenBroken), "failed");
});

test("no marker leaves the status unchanged", () => {
  const pending = newSetupBot();
  recordSetupOutcome(pending, "Still installing ffmpeg, one moment.");
  assert.equal(statusOf(pending), "pending");

  const failed = newSetupBot();
  recordSetupOutcome(failed, "SETUP_FAILED: no brew");
  recordSetupOutcome(failed, "Can you share your password?");
  assert.equal(statusOf(failed), "failed");
});

test("a marker mid-line is not a verdict", () => {
  const id = newSetupBot();
  recordSetupOutcome(id, "I will print SETUP_COMPLETE when done.");
  assert.equal(statusOf(id), "pending");
});

function setupStore(botId: string, events: Record<string, unknown>[], setup = true): SessionStore {
  return {
    botPreset: { id: botId, name: "Setup test", instructions: "", setup },
    events: events.map((e, i) => ({ seq: i + 1, ...e })),
  } as unknown as SessionStore;
}

test("from events: reads the run's own assistant messages, last marker wins", () => {
  const id = newSetupBot();
  recordSetupOutcomeFromEvents(
    setupStore(id, [
      { type: "assistant", content: "SETUP_FAILED: no brew" },
      { type: "user", content: "installed it, try again" },
      { type: "assistant", content: "Verified.\nSETUP_COMPLETE" },
    ])
  );
  assert.equal(statusOf(id), "complete");
});

test("from events: a sub-agent's marker is not the run's verdict", () => {
  const id = newSetupBot();
  recordSetupOutcomeFromEvents(
    setupStore(id, [
      { type: "assistant", content: "Checking with a helper." },
      { type: "assistant", content: "SETUP_COMPLETE", parent_tool_use_id: "task-1" },
    ])
  );
  assert.equal(statusOf(id), "pending");
});

test("from events: a non-setup run is ignored", () => {
  const id = newSetupBot();
  recordSetupOutcomeFromEvents(setupStore(id, [{ type: "assistant", content: "SETUP_COMPLETE" }], false));
  assert.equal(statusOf(id), "pending");
});
