import assert from "node:assert/strict";
import test from "node:test";

import { parseShare, shareCode } from "../app/lib/share.ts";

test("share codes preserve validated agent and denied tools", () => {
  const parsed = parseShare(shareCode({
    name: "Guard",
    agent: "codex",
    disallowedTools: ["Bash", "Write"],
  }));

  assert.equal(parsed?.agent, "codex");
  assert.deepEqual(parsed?.disallowedTools, ["Bash", "Write"]);
  assert.equal(parseShare(shareCode({ name: "Guard", agent: "unknown" }))?.agent, undefined);
});
