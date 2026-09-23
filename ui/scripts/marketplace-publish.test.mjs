import assert from "node:assert/strict";
import test from "node:test";

import { marketplacePublishPrompt, parseMarketplaceListing } from "../app/lib/marketplace-publish.ts";

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
  assert.match(prompt, /fenced `marketplace-listing` code block containing valid JSON/);
});

test("marketplace listing parser accepts complete JSON and rejects ordinary code", () => {
  assert.equal(parseMarketplaceListing('{"name":"PR Guardian","description":"Reviews PRs"}')?.name, "PR Guardian");
  assert.equal(parseMarketplaceListing("name: PR Guardian"), null);
  assert.equal(parseMarketplaceListing('{"name":"PR Guardian","description":"Reviews PRs","capabilities":"everything"}'), null);
});
