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
    model: "gpt-5",
    allowedTools: ["Read"],
    disallowedTools: ["Write"],
    repoPath: "/Users/person/private-project",
    setupStatus: "complete",
    setupThreadId: "private-thread",
  }, { mascot: "bear", color: "var(--brand-sun)" });

  assert.match(prompt, /"name": "PR Guardian"/);
  assert.match(prompt, /"body": "bear"/);
  assert.match(prompt, /"model": "gpt-5"/);
  assert.match(prompt, /"allowedTools": \[/);
  assert.match(prompt, /github\.com\/gitbot-hq\/Library/);
  assert.match(prompt, /docs\/publish-prompt\.md/);
  assert.match(prompt, /bots\/<slug>\//);
  assert.doesNotMatch(prompt, /under the library\/ folder/);
  assert.match(prompt, /slug, name, description, category, about, features, examplePrompt, author, mascot/);
  assert.doesNotMatch(prompt, /private-id|private-project|private-thread|setupStatus|repoPath/);
  assert.match(prompt, /Do not commit, push, or create a pull request until/);
  assert.match(prompt, /fenced `marketplace-listing` JSON block/);
});

test("marketplace listing parser accepts the Library schema and rejects ordinary code", () => {
  const listing = parseMarketplaceListing('{"slug":"pr-guardian","name":"PR Guardian","description":"Reviews PRs","model":"gpt-5","allowedTools":["Read"],"features":["Spot bugs","Explain risks","Suggest fixes"],"examplePrompt":"Review this PR","author":{"github":"maya","name":"Maya"},"mascot":{"body":"bear","color":"brand-sun","activity":"thinking"}}');
  assert.equal(listing?.model, "gpt-5");
  assert.deepEqual(listing?.allowedTools, ["Read"]);
  assert.equal(typeof listing?.mascot === "object" ? listing.mascot.color : undefined, "brand-sun");
  assert.equal(parseMarketplaceListing("name: PR Guardian"), null);
  assert.equal(parseMarketplaceListing('{"name":"PR Guardian","description":"Reviews PRs","capabilities":"everything"}'), null);
});
