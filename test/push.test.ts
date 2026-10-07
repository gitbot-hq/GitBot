import { test, after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { createECDH, randomBytes } from "crypto";
import { mkdtempSync, realpathSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBot, createThread, dataDir, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import {
  listSubscriptions,
  parseSubscription,
  pushSender,
  removeSubscriptions,
  resetVapidCache,
  watchPush,
  type PushPayload,
  type StoredSubscription,
} from "../src/push";
import {
  emitEvent,
  notifyPermissionsChanged,
  sessions,
  setShuttingDown,
  type IRequest,
  type IResponse,
  type SessionStore,
} from "../src/server-common";
import { handleRequest } from "../src/server";
import { startTurn, agentRunners } from "../src/turns";

const ALL_AGENTS = ["claude-code", "opencode", "codex"];

// --- Stubs at both seams: agents never run, push services are never reached ---

const realRunners = { ...agentRunners };
const realSend = pushSender.send;
let runs: SessionStore[] = [];
let sent: Array<{ endpoint: string; payload: PushPayload; urgency?: string }> = [];
/** Status codes the fake push service answers with, by endpoint. */
let failWith: Record<string, number> = {};
let unwatch: () => void = () => {};

before(() => {
  for (const agent of Object.keys(agentRunners) as SessionStore["agent"][]) {
    agentRunners[agent] = async (store) => { runs.push(store); };
  }
  pushSender.send = async (sub, payload, options) => {
    const status = failWith[sub.endpoint];
    if (status) throw Object.assign(new Error(`status ${status}`), { statusCode: status, body: "" });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), urgency: options.urgency });
  };
  unwatch = watchPush();
});
beforeEach(() => {
  removeSubscriptions(listSubscriptions().map((s) => s.endpoint));
  sent = [];
  failWith = {};
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  delete process.env.GITBOT_PUSH;
});
after(() => {
  unwatch();
  pushSender.send = realSend;
  Object.assign(agentRunners, realRunners);
});

const tick = () => new Promise((r) => setImmediate(r));
/** Lets the turn-end listeners run, then the sends they started. */
const settle = async () => { await tick(); await tick(); await tick(); };

async function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req = Object.assign(new EventEmitter(), { method, url, headers: { "user-agent": "TestBrowser/1.0" } }) as unknown as IRequest;
  let status = 0;
  let out = "";
  const res: IResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) { status = code; },
    write() {},
    end(chunk) { out = chunk ?? ""; },
  };
  const done = handleRequest(req, res, ALL_AGENTS, tmpdir());
  setImmediate(() => {
    if (body !== undefined) (req as unknown as EventEmitter).emit("data", JSON.stringify(body));
    (req as unknown as EventEmitter).emit("end");
  });
  await done;
  return { status, body: JSON.parse(out || "{}") };
}

/** A subscription as a browser's PushSubscription.toJSON() gives it. */
function browserSubscription(name: string) {
  const ecdh = createECDH("prime256v1");
  return {
    endpoint: `https://push.example/${name}`,
    expirationTime: null,
    keys: { p256dh: ecdh.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

async function subscribe(name: string) {
  const sub = browserSubscription(name);
  const res = await request("POST", "/push/subscribe", { subscription: sub });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return sub;
}

/** Runs a turn on a thread and ends it with the given reply. */
async function turn(threadId: string, reply: string, status: SessionStore["status"] = "done", opts: { abort?: boolean } = {}) {
  const started = startTurn({ threadId, prompt: "hello" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  const store = runs[runs.length - 1];
  await tick();
  emitEvent(store, "assistant", { content: reply });
  if (opts.abort) emitEvent(store, "aborted", { message: "Aborted by user" });
  store.status = status;
  notifyPermissionsChanged();
  await settle();
  return store;
}

function plainThread(name = "Plain") {
  const bot = createBot({ name, agent: "claude-code" });
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-push-")));
  return createThread(bot.id, folder, "Fix the flaky test", "chat", "claude-code");
}

// --- Keys and subscriptions ---

test("the VAPID keys are made once, kept, and readable by the owner only", async () => {
  const first = await request("GET", "/push/key");
  assert.equal(first.status, 200);
  assert.equal(first.body.enabled, true);
  // An uncompressed P-256 public key, base64url.
  assert.equal(Buffer.from(first.body.publicKey, "base64url").length, 65);
  const file = join(dataDir(), "push-vapid.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // Read back from disk, not made again: subscriptions are bound to this key.
  resetVapidCache();
  assert.equal((await request("GET", "/push/key")).body.publicKey, first.body.publicKey);
});

test("a subscription is checked, stored once per browser, owner-only, and removable", async () => {
  assert.equal(parseSubscription(null), null);
  const good = browserSubscription("a");
  assert.ok(parseSubscription(good));
  assert.equal(parseSubscription({ ...good, endpoint: "http://push.example/a" }), null);
  assert.equal(parseSubscription({ ...good, endpoint: "not a url" }), null);
  assert.equal(parseSubscription({ ...good, keys: { ...good.keys, auth: "short" } }), null);
  assert.equal(parseSubscription({ ...good, keys: { p256dh: good.keys.p256dh } }), null);
  assert.equal((await request("POST", "/push/subscribe", { subscription: { endpoint: "https://x" } })).status, 400);

  // The bare toJSON() shape is accepted too; the same browser again replaces itself.
  assert.equal((await request("POST", "/push/subscribe", good)).body.count, 1);
  const again = await request("POST", "/push/subscribe", { subscription: good });
  assert.equal(again.body.count, 1);
  await subscribe("b");
  const stored = listSubscriptions();
  assert.deepEqual(stored.map((s) => s.endpoint), ["https://push.example/a", "https://push.example/b"]);
  assert.equal(stored[0].userAgent, "TestBrowser/1.0");
  assert.equal(statSync(join(dataDir(), "push-subscriptions.json")).mode & 0o777, 0o600);

  assert.deepEqual((await request("POST", "/push/unsubscribe", { endpoint: good.endpoint })).body, { removed: true });
  assert.deepEqual((await request("POST", "/push/unsubscribe", { endpoint: good.endpoint })).body, { removed: false });
  assert.equal((await request("POST", "/push/unsubscribe", {})).status, 400);
  assert.deepEqual(listSubscriptions().map((s) => s.endpoint), ["https://push.example/b"]);
});

test("GITBOT_PUSH=0 turns it all off", async () => {
  await subscribe("a");
  process.env.GITBOT_PUSH = "0";
  assert.deepEqual((await request("GET", "/push/key")).body, { enabled: false, publicKey: null });
  assert.equal((await request("POST", "/push/subscribe", { subscription: browserSubscription("b") })).status, 404);
  assert.equal((await request("POST", "/push/test", {})).status, 404);
  // Nor is anything sent for a turn end, even to a browser subscribed before.
  await turn(plainThread().id, "Done.");
  assert.equal(sent.length, 0);
});

// --- What gets sent ---

test("nothing is sent while no browser is subscribed", async () => {
  await turn(plainThread().id, "All done.");
  assert.equal(sent.length, 0);
});

test("a turn that finished or failed is a push to every browser; one the user stopped is not", async () => {
  await subscribe("a");
  await subscribe("b");
  const thread = plainThread("Tester");
  await turn(thread.id, "## Fixed\n\nThe test was racing the clock.");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ["https://push.example/a", "https://push.example/b"]);
  assert.deepEqual(sent[0].payload, {
    title: "Fix the flaky test",
    body: "Tester finished: Fixed",
    tag: `thread-${thread.id}`,
    url: `/?thread=${thread.id}&bot=${thread.botId}`,
    kind: "done",
    threadId: thread.id,
    botId: thread.botId,
  });
  assert.equal(sent[0].urgency, "normal");

  sent = [];
  await turn(thread.id, "", "error");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.kind, "failed");
  assert.equal(sent[0].payload.body, "Tester hit an error");

  sent = [];
  await turn(thread.id, "half", "error", { abort: true });
  assert.equal(sent.length, 0);
});

test("a turn our shutdown killed is not a push", async () => {
  await subscribe("a");
  const thread = plainThread();
  setShuttingDown(true);
  try {
    await turn(thread.id, "half a thought", "error");
  } finally {
    setShuttingDown(false);
  }
  assert.equal(sent.length, 0);
});

test("a child's turn that reports to Jarvis is not a push of its own", async () => {
  await subscribe("a");
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-push-proj-")));
  const added = addProject(folder);
  assert.ok(added.ok);
  const jarvis = createThread(JARVIS_BOT_ID, jarvisDir(), undefined, "chat", "claude-code");
  const started = startChildThread(jarvis.id, { agent: "claude-code", project: added.project.id, message: "run the tests" }, ALL_AGENTS);
  assert.ok(started.ok, JSON.stringify(started));
  const child = runs[runs.length - 1];
  await tick();
  assert.equal(child.reportOwner, jarvis.id);
  assert.ok(child.reportable);
  emitEvent(child, "assistant", { content: "Tests pass." });
  child.status = "done";
  notifyPermissionsChanged();
  await settle();
  assert.equal(sent.length, 0);
});

test("an approval or a question is a push once, when it appears", async () => {
  await subscribe("a");
  const thread = plainThread("Builder");
  const started = startTurn({ threadId: thread.id, prompt: "build it" }, ALL_AGENTS);
  assert.ok(started.ok);
  const store = runs[runs.length - 1];
  await tick();

  store.pendingPermissions.set("tu-1", { resolve: () => {}, input: { command: "npm ci\nnpm test" }, toolName: "Bash", toolUseID: "tu-1" });
  notifyPermissionsChanged();
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.kind, "approval");
  assert.equal(sent[0].payload.title, "Fix the flaky test");
  assert.equal(sent[0].payload.body, "Builder needs your approval: npm ci");
  assert.equal(sent[0].payload.url, `/?thread=${thread.id}&bot=${thread.botId}`);
  assert.equal(sent[0].urgency, "high");

  // Still waiting: the next broadcast is not news.
  notifyPermissionsChanged();
  await settle();
  assert.equal(sent.length, 1);

  // A question, alongside it.
  store.pendingPermissions.set("tu-2", {
    resolve: () => {},
    toolName: "AskUserQuestion",
    toolUseID: "tu-2",
    input: { questions: [{ question: "Which branch?", header: "Branch", options: [{ label: "main" }, { label: "dev" }] }] },
  });
  notifyPermissionsChanged();
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.kind, "question");
  assert.equal(sent[1].payload.body, "Builder has a question: Which branch?");
  store.pendingPermissions.clear();
  notifyPermissionsChanged();
  await settle();
  assert.equal(sent.length, 2);
});

test("a browser the push service says is gone is dropped; one that merely failed is kept", async () => {
  await subscribe("gone");
  await subscribe("expired");
  await subscribe("flaky");
  await subscribe("fine");
  failWith = { "https://push.example/gone": 410, "https://push.example/expired": 404, "https://push.example/flaky": 500 };
  await turn(plainThread().id, "Done.");
  await settle();
  assert.deepEqual(sent.map((s) => s.endpoint), ["https://push.example/fine"]);
  assert.deepEqual(listSubscriptions().map((s: StoredSubscription) => s.endpoint), ["https://push.example/flaky", "https://push.example/fine"]);
});

test("the test route sends to the browser that asked", async () => {
  assert.equal((await request("POST", "/push/test", {})).status, 404);
  const mine = await subscribe("mine");
  await subscribe("other");
  const res = await request("POST", "/push/test", { endpoint: mine.endpoint });
  assert.deepEqual(res.body, { sent: 1, failed: 0, removed: 0 });
  assert.deepEqual(sent.map((s) => s.endpoint), [mine.endpoint]);
  assert.equal(sent[0].payload.kind, "test");
  assert.equal((await request("POST", "/push/test", { endpoint: "https://push.example/nobody" })).status, 404);
});
