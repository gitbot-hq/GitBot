import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent bot-authoring prompt requires approval and preserves existing bots", async () => {
  const prompt = await readFile(new URL("../public/prompts/create-gitbot-bot.md", import.meta.url), "utf8");

  assert.match(prompt, /do not write anything to disk\s+until I have seen the definition and approved it/i);
  assert.match(prompt, /preserving every bot already in the file/i);
  assert.match(prompt, /copyFileSync\(file, file \+ "\.bak"\)/);
});
