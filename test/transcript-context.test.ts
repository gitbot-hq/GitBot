import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadTranscriptContext } from "../src/start-claude-code";

// The transcript lives under CLAUDE_CONFIG_DIR, read when the loader runs.
const configDir = mkdtempSync(join(tmpdir(), "gitbot-ctx-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
const cwd = "/work/demo";

function transcript(id: string, entries: unknown[]): void {
  const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
}

const assistant = (usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  ({ type: "assistant", message: { model: "claude-opus-5-5", usage }, ...extra });

test("the meter reads the last main-thread assistant message of a transcript", async () => {
  transcript("s1", [
    { type: "user", message: { content: "hi" } },
    assistant({ input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 90 }),
    // A subagent's usage is not this window's.
    assistant({ input_tokens: 5, cache_read_input_tokens: 150_000, output_tokens: 5 }, { isSidechain: true }),
    assistant({ input_tokens: 0, output_tokens: 0 }),
  ]);
  const ctx = await loadTranscriptContext("s1", cwd);
  assert.deepEqual(ctx, { used: 1100, window: 200_000, model: "claude-opus-5-5", label: "Opus 5.5" });
});

test("the configured model sizes the window; overflowing the default means the long one", async () => {
  transcript("s2", [assistant({ input_tokens: 1, cache_read_input_tokens: 300_000, output_tokens: 1 })]);
  assert.equal((await loadTranscriptContext("s2", cwd))?.window, 1_000_000);
  transcript("s3", [assistant({ input_tokens: 1, output_tokens: 1 })]);
  assert.equal((await loadTranscriptContext("s3", cwd, "claude-opus-5-5[1m]"))?.window, 1_000_000);
});

test("no transcript, or no usage in it, means no reading", async () => {
  assert.equal(await loadTranscriptContext("missing", cwd), null);
  transcript("s4", [{ type: "user", message: { content: "hi" } }]);
  assert.equal(await loadTranscriptContext("s4", cwd), null);
});
