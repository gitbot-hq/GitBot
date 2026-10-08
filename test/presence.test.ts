// The pure decision behind every push: given where the user's tabs say they
// are, is this notification worth sending? No server, no clock but the one passed in.
import "./temp-data-dir";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearPresence,
  decide,
  liveTabs,
  MAX_PRESENCE_TABS,
  parsePresence,
  PRESENCE_LEASE_MS,
  PresenceLimitError,
  recordPresence,
  type NotificationKind,
  type TabPresence,
} from "../src/presence";

const NOW = 1_000_000;
const tab = (state: TabPresence["state"], threadId: string | null = null, expiresAt = NOW + 1000): TabPresence => ({ state, threadId, expiresAt });
const noOwner = () => null;
const KINDS: NotificationKind[] = ["approval", "question", "failed", "done"];
const send = (kind: NotificationKind, tabs: TabPresence[], ownerOf: (id: string) => string | null = noOwner) =>
  decide(kind, "X", tabs, NOW, ownerOf);

beforeEach(() => clearPresence());

test("no tabs at all (a fresh restart): everything is sent", () => {
  for (const kind of KINDS) assert.equal(send(kind, []), true, kind);
});

test("watching the thread mutes everything about it", () => {
  for (const kind of KINDS) assert.equal(send(kind, [tab("watching", "X")]), false, kind);
});

test("glancing at the thread (side by side) mutes finished and failed, not needs-you", () => {
  const tabs = [tab("glancing", "X")];
  assert.equal(send("done", tabs), false);
  assert.equal(send("failed", tabs), false);
  assert.equal(send("approval", tabs), true);
  assert.equal(send("question", tabs), true);
});

test("in gitbot on another thread: finished is muted; failed and needs-you are sent", () => {
  for (const tabs of [[tab("watching", "Y")], [tab("present")]]) {
    assert.equal(send("done", tabs), false);
    assert.equal(send("failed", tabs), true);
    assert.equal(send("approval", tabs), true);
  }
});

test("glancing at another thread is away for this one", () => {
  for (const kind of KINDS) assert.equal(send(kind, [tab("glancing", "Y")]), true, kind);
});

test("a lapsed report counts for nothing", () => {
  const lapsed = [tab("watching", "X", NOW), tab("present", null, NOW - 1)];
  for (const kind of KINDS) assert.equal(send(kind, lapsed), true, kind);
});

test("any one live tab counts, on any device", () => {
  const tabs = [tab("glancing", "Y"), tab("watching", "X", NOW - 5), tab("watching", "X")];
  for (const kind of KINDS) assert.equal(send(kind, tabs), false, kind);
});

test("a child's needs-you is muted by watching the Jarvis thread it reports to, and only that", () => {
  const ownerOf = (id: string) => (id === "X" ? "J" : null);
  assert.equal(send("approval", [tab("watching", "J")], ownerOf), false);
  assert.equal(send("question", [tab("watching", "J")], ownerOf), false);
  assert.equal(send("approval", [tab("glancing", "J")], ownerOf), true);
  assert.equal(send("approval", [tab("watching", "J")]), true, "no owner");
  // Finished and failed don't follow the owner (a delivered report is muted elsewhere).
  assert.equal(send("failed", [tab("watching", "J")], ownerOf), true);
});

test("a needs-you with no thread is never muted", () => {
  assert.equal(decide("approval", undefined, [tab("watching", "X")], NOW, noOwner), true);
});

test("the hold: a re-check later sees reports made or lapsed meanwhile", () => {
  // Turn end: away. Ten seconds on: back on the thread.
  recordPresence({ tab: "tab-aaaaaaaa", threadId: "X", state: "watching" }, NOW + 5_000);
  assert.equal(decide("done", "X", liveTabs(NOW + 10_000), NOW + 10_000, noOwner), false);
  // Its lease runs out with no renewal: away again.
  const later = NOW + 5_000 + PRESENCE_LEASE_MS;
  assert.equal(liveTabs(later).length, 0);
  assert.equal(decide("done", "X", liveTabs(later), later, noOwner), true);
});

test("away forgets a tab; reports are pruned on read; a new tab past the cap is refused", () => {
  recordPresence({ tab: "tab-aaaaaaaa", threadId: "X", state: "watching" }, NOW);
  recordPresence({ tab: "tab-aaaaaaaa", threadId: null, state: "away" }, NOW);
  assert.equal(liveTabs(NOW).length, 0);
  for (let i = 0; i < MAX_PRESENCE_TABS; i++) recordPresence({ tab: `tab-${i}-xxxxx`, threadId: null, state: "present" }, NOW);
  assert.throws(() => recordPresence({ tab: "tab-new-xxxxx", threadId: null, state: "present" }, NOW), PresenceLimitError);
  recordPresence({ tab: "tab-0-xxxxx", threadId: "X", state: "watching" }, NOW);
  assert.doesNotThrow(() => recordPresence({ tab: "tab-new-xxxxx", threadId: null, state: "present" }, NOW + PRESENCE_LEASE_MS));
  assert.equal(liveTabs(NOW + PRESENCE_LEASE_MS).length, 1);
});

test("a report is parsed strictly; watching or glancing at no thread is just present", () => {
  assert.deepEqual(parsePresence({ tab: "tab-aaaaaaaa", thread: "X", state: "glancing" }), { tab: "tab-aaaaaaaa", threadId: "X", state: "glancing" });
  assert.deepEqual(parsePresence({ tab: "tab-aaaaaaaa", thread: null, state: "watching" }), { tab: "tab-aaaaaaaa", threadId: null, state: "present" });
  for (const bad of [null, "x", { tab: "tab-aaaaaaaa" }, { tab: "tab-aaaaaaaa", state: "idle" }, { tab: "a/b-cdefgh", state: "present" }]) {
    assert.equal(parsePresence(bad), null, JSON.stringify(bad));
  }
});
