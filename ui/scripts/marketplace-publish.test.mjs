import assert from "node:assert/strict";
import test from "node:test";

import { marketplacePublishPrompt } from "../app/lib/marketplace-publish.ts";

test("marketplace prompt includes public settings and excludes machine state", () => {
  const prompt = marketplacePublishPrompt({
    id: "private-id",
    name: "PR Guardian",
    description: "Reviews pull requests",
    emoji: "🤖",
    agent: "codex",
    instructions: "Review carefully",
    permissionMode: "ask-permissions",
    model: "",
    repoPath: "/Users/person/private-project",
    setupStatus: "complete",
    setupThreadId: "private-thread",
  }, { mascot: "bear", color: "var(--brand-sun)" });

  assert.match(prompt, /"name": "PR Guardian"/);
  assert.match(prompt, /"mascot": "bear"/);
  assert.doesNotMatch(prompt, /private-id|private-project|private-thread|setupStatus|repoPath/);
  assert.match(prompt, /Do not commit, push, or create a pull request until/);
});
