import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent bot-authoring prompt matches the docs source verbatim", async () => {
  const prompt = JSON.parse(await readFile(new URL("../app/lib/bot-author-prompt.json", import.meta.url), "utf8")).join("\n");
  const docs = await readFile(new URL("../../docs/bot-author-prompt.md", import.meta.url), "utf8");

  assert.equal(prompt, docs.replace(/\n+$/, ""));
});

test("agent bot-authoring prompt opens wide, requires approval, and writes the data file safely", async () => {
  const prompt = JSON.parse(await readFile(new URL("../app/lib/bot-author-prompt.json", import.meta.url), "utf8")).join("\n");

  assert.match(prompt, /do\s+not write anything to disk until I have seen the definition and approved it/i);
  assert.match(prompt, /## 1\. Start with one open question/);
  assert.match(prompt, /Do not offer me a menu here/);
  assert.match(prompt, /GITBOT_DATA_DIR/);
  assert.match(prompt, /bots\.json/);
  assert.match(prompt, /command -v claude/);
});
