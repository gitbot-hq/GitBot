import assert from "node:assert/strict";
import test from "node:test";

import { MARKETPLACE_PUBLISH_PROMPT, parseMarketplaceListing } from "../app/lib/marketplace-publish.ts";
import publishGuideLines from "../app/lib/publish-prompt.json" with { type: "json" };

test("the publishing prompt is the Library guide verbatim, with nothing bot-specific added", () => {
  assert.equal(MARKETPLACE_PUBLISH_PROMPT, publishGuideLines.join("\n"));
  assert.doesNotMatch(MARKETPLACE_PUBLISH_PROMPT, /<marketplace-bot>/);
  assert.doesNotMatch(MARKETPLACE_PUBLISH_PROMPT, /already selected/);
});

test("the inlined guide still carries the steps the modal promises", () => {
  const guide = MARKETPLACE_PUBLISH_PROMPT;

  assert.match(guide, /github\.com\/gitbot-hq\/Library/);
  assert.match(guide, /## 0\. Ground rules for the whole session/);
  assert.match(guide, /## 12\. Report/);
  assert.match(guide, /Never edit `index\.json` or `verified\.json`/);
  assert.match(guide, /`Code review`, `Developer workflow`, `Releases`, `Maintenance`/);
  assert.match(guide, /\*\*exactly three\*\* bullets/);
});

test("marketplace listing parser accepts the Library schema and rejects ordinary code", () => {
  const listing = parseMarketplaceListing('{"slug":"pr-guardian","name":"PR Guardian","description":"Reviews PRs","model":"gpt-5","allowedTools":["Read"],"features":["Spot bugs","Explain risks","Suggest fixes"],"examplePrompt":"Review this PR","author":{"github":"maya","name":"Maya"},"mascot":{"body":"bear","color":"brand-sun","activity":"thinking"}}');
  assert.equal(listing?.model, "gpt-5");
  assert.deepEqual(listing?.allowedTools, ["Read"]);
  assert.equal(typeof listing?.mascot === "object" ? listing.mascot.color : undefined, "brand-sun");
  assert.equal(parseMarketplaceListing("name: PR Guardian"), null);
  assert.equal(parseMarketplaceListing('{"name":"PR Guardian","description":"Reviews PRs","capabilities":"everything"}'), null);
});
