import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadTranscript, loadTranscriptContext } from "../src/start-claude-code";
import { withJarvisReminder } from "../src/jarvis";

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
  assert.deepEqual(ctx, { used: 1100, window: 1_000_000, model: "claude-opus-5-5", label: "Opus 5.5" });
});

test("the configured model sizes the window, even when the conversation no longer fits it", async () => {
  // `model` here is the one the NEXT turn will run (threadContext passes
  // thread.model), not the one that wrote the transcript. So a conversation
  // larger than that model's window is a real reading — the thread has
  // outgrown what it is set to run — and must survive as one. Promoting it to
  // 1M would hide exactly the condition the picker greys Haiku out on, and
  // would disagree with the live meter, which does not promote.
  transcript("s2", [assistant({ input_tokens: 1, cache_read_input_tokens: 300_000, output_tokens: 1 })]);
  const outgrown = await loadTranscriptContext("s2", cwd, "haiku");
  assert.equal(outgrown?.window, 200_000);
  assert.equal(outgrown?.used, 300_002);

  transcript("s3", [assistant({ input_tokens: 1, output_tokens: 1 })]);
  assert.equal((await loadTranscriptContext("s3", cwd, "claude-opus-5-5[1m]"))?.window, 1_000_000);
  // Haiku and the 4.6 pair are the short windows: a thread inside one reads 200k.
  assert.equal((await loadTranscriptContext("s3", cwd, "haiku"))?.window, 200_000);
  assert.equal((await loadTranscriptContext("s3", cwd, "claude-opus-4-6"))?.window, 200_000);
  // And a thread that fits a long model reads against the long window.
  assert.equal((await loadTranscriptContext("s2", cwd, "sonnet"))?.window, 1_000_000);
});

test("no transcript, or no usage in it, means no reading", async () => {
  assert.equal(await loadTranscriptContext("missing", cwd), null);
  transcript("s4", [{ type: "user", message: { content: "hi" } }]);
  assert.equal(await loadTranscriptContext("s4", cwd), null);
});

test("loadTranscript returns clean text plus scheduled for a tagged user message", async () => {
  const tag = '<gitbot-schedule id="sch-1" name="Ping" run="2"/>';
  const user = (content: unknown, at: string) =>
    ({ type: "user", userType: "external", timestamp: at, message: { role: "user", content } });
  transcript("tagged", [
    // A user's own message: untouched, no scheduled.
    user("hello", "2026-10-14T10:00:00.000Z"),
    // A scheduled turn, as Claude Code records it: a string prompt.
    user(`${tag}\nReply with exactly: pong`, "2026-10-14T10:01:00.000Z"),
    // On a Jarvis thread: the tag first, the reminder last.
    user(withJarvisReminder(`${tag}\nremind me to stretch`), "2026-10-14T10:02:00.000Z"),
    // As content blocks (the attachments path).
    user([{ type: "text", text: `${tag}\nlook at this` }, { type: "image", source: { type: "url", url: "https://x/y.png" } }], "2026-10-14T10:03:00.000Z"),
    // A pending note, then the user's words; and a child's report header: no tag, untouched.
    user(withJarvisReminder("[you stopped PR Validator on Trophy]\n\nhow did it go?"), "2026-10-14T10:04:00.000Z"),
    user("[Tester · demo · thread t1 · done]\nAll green.", "2026-10-14T10:05:00.000Z"),
    // A tag that is not well-formed stays as text.
    user('<gitbot-schedule name="x"/>\nplain', "2026-10-14T10:06:00.000Z"),
    // A user who pastes a tag mid-message gets no chip, and keeps their text.
    user(`look at this: ${tag} odd`, "2026-10-14T10:07:00.000Z"),
    // A compaction summary quotes earlier messages, tags and all: no chip, text kept.
    { ...user(`${tag}\nThis session is being continued. Earlier: ${tag}`, "2026-10-14T10:08:00.000Z"), isCompactSummary: true },
    // Content blocks: only the opening text block can carry it.
    user([{ type: "text", text: "first" }, { type: "text", text: `${tag}\nsecond` }], "2026-10-14T10:09:00.000Z"),
  ]);
  const messages = (await loadTranscript("tagged", cwd)).filter((m) => m.role === "user");
  const shown = messages.map((m) => [m.content.map((b: any) => b.text ?? b.url).join("|"), m.scheduled?.run ?? null]);
  assert.deepEqual(shown, [
    ["hello", null],
    ["Reply with exactly: pong", 2],
    ["remind me to stretch", 2],
    ["look at this|https://x/y.png", 2],
    ["[you stopped PR Validator on Trophy]\n\nhow did it go?", null],
    ["[Tester · demo · thread t1 · done]\nAll green.", null],
    ['<gitbot-schedule name="x"/>\nplain', null],
    [`look at this: ${tag} odd`, null],
    [`${tag}\nThis session is being continued. Earlier: ${tag}`, null],
    [`first|${tag}\nsecond`, null],
  ]);
  assert.deepEqual(messages[1].scheduled, { id: "sch-1", name: "Ping", run: 2 });
  assert.equal(messages[1].at, "2026-10-14T10:01:00.000Z");
  assert.ok(!("scheduled" in messages[0]), "no field at all on a user's own message");
});
