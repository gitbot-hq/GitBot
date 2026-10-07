// First: points the data directory at a throwaway one before bot-store loads,
// so running this file on its own (without npm test's --import) never reads
// or writes the real ~/.gitbot or ~/.grass.
import "./temp-data-dir";
import { test, after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { createECDH, randomBytes } from "crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBot, createThread, dataDir, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import { startChildThread } from "../src/jarvis";
import { addProject } from "../src/project-index";
import {
  DEFAULT_PUSH_SUBJECT,
  describeUserAgent,
  listSubscriptions,
  MAX_SUBSCRIPTIONS,
  pushServiceOf,
  subscriptionId,
  parseSubscription,
  pushSender,
  removeSubscriptions,
  resetVapidCache,
  watchPush,
  type PushPayload,
  validPushSubject,
  vapidSubject,
  type StoredSubscription,
} from "../src/push";
import {
  emitEvent,
  notifyPermissionsChanged,
  permissionsEmitter,
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
let sent: Array<{ endpoint: string; payload: PushPayload; urgency?: string; subject?: string }> = [];
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
    sent.push({
      endpoint: sub.endpoint,
      payload: JSON.parse(payload),
      urgency: options.urgency,
      subject: options.vapidDetails?.subject,
    });
  };
  unwatch = watchPush();
});
beforeEach(() => {
  removeSubscriptions(listSubscriptions().map((s) => s.endpoint));
  rmSync(join(dataDir(), "push-deleted.json"), { force: true });
  sent = [];
  failWith = {};
});
afterEach(() => {
  for (const s of runs) sessions.delete(s.gitbotId);
  runs = [];
  delete process.env.GITBOT_PUSH;
  delete process.env.GITBOT_PUSH_SUBJECT;
});
after(() => {
  unwatch();
  pushSender.send = realSend;
  Object.assign(agentRunners, realRunners);
});

const tick = () => new Promise((r) => setImmediate(r));
/** Lets the turn-end listeners run, then the sends they started. */
const settle = async () => { await tick(); await tick(); await tick(); };

/** A request as gitbot's own page sends it; `headers` adds to or (undefined) removes from that. */
async function request(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string | undefined> = {},
): Promise<{ status: number; body: any }> {
  const all: Record<string, string | undefined> = {
    host: "localhost:3000",
    "user-agent": "TestBrowser/1.0",
    ...(method === "POST" ? { "content-type": "application/json" } : {}),
    ...headers,
  };
  for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key];
  const req = Object.assign(new EventEmitter(), { method, url, headers: all }) as unknown as IRequest;
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
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
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
  assert.equal(parseSubscription({ ...good, endpoint: "http://fcm.googleapis.com/fcm/send/a" }), null);
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
  assert.deepEqual(stored.map((s) => s.endpoint), ["https://fcm.googleapis.com/fcm/send/a", "https://fcm.googleapis.com/fcm/send/b"]);
  assert.equal(stored[0].userAgent, "TestBrowser/1.0");
  assert.equal(statSync(join(dataDir(), "push-subscriptions.json")).mode & 0o777, 0o600);

  assert.deepEqual((await request("POST", "/push/unsubscribe", { endpoint: good.endpoint })).body, { removed: true });
  assert.deepEqual((await request("POST", "/push/unsubscribe", { endpoint: good.endpoint })).body, { removed: false });
  assert.equal((await request("POST", "/push/unsubscribe", {})).status, 400);
  assert.deepEqual(listSubscriptions().map((s) => s.endpoint), ["https://fcm.googleapis.com/fcm/send/b"]);
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

test("the VAPID subject is one Apple accepts: GITBOT_PUSH_SUBJECT when valid, else the project's https URL", () => {
  assert.equal(vapidSubject(), DEFAULT_PUSH_SUBJECT);
  assert.ok(validPushSubject(DEFAULT_PUSH_SUBJECT));
  for (const ok of ["mailto:you@example.com", "https://example.com", "https://gitbot.tail1234.ts.net/"]) {
    assert.ok(validPushSubject(ok), ok);
  }
  // Apple answers each of these with 403 BadJwtToken.
  for (const bad of [
    "mailto:me@localhost", "mailto:me@mac.local", "mailto:nobody", "you@example.com",
    "http://example.com", "https://localhost:3000", "https://192.168.1.10", "https://[::1]/", "mailto:a@b.com?x",
  ]) {
    assert.equal(validPushSubject(bad), false, bad);
  }
  process.env.GITBOT_PUSH_SUBJECT = "mailto:you@example.com";
  assert.equal(vapidSubject(), "mailto:you@example.com");
  process.env.GITBOT_PUSH_SUBJECT = "mailto:me@localhost";
  assert.equal(vapidSubject(), DEFAULT_PUSH_SUBJECT);
});

test("pushes are signed with that subject", async () => {
  process.env.GITBOT_PUSH_SUBJECT = "mailto:you@example.com";
  await subscribe("a");
  await turn(plainThread().id, "Done.");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "mailto:you@example.com");
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
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ["https://fcm.googleapis.com/fcm/send/a", "https://fcm.googleapis.com/fcm/send/b"]);
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
  failWith = { "https://fcm.googleapis.com/fcm/send/gone": 410, "https://fcm.googleapis.com/fcm/send/expired": 404, "https://fcm.googleapis.com/fcm/send/flaky": 500 };
  await turn(plainThread().id, "Done.");
  await settle();
  assert.deepEqual(sent.map((s) => s.endpoint), ["https://fcm.googleapis.com/fcm/send/fine"]);
  assert.deepEqual(listSubscriptions().map((s: StoredSubscription) => s.endpoint), ["https://fcm.googleapis.com/fcm/send/flaky", "https://fcm.googleapis.com/fcm/send/fine"]);
});

test("the test route sends to the browser that asked", async () => {
  assert.equal((await request("POST", "/push/test", {})).status, 404);
  const mine = await subscribe("mine");
  await subscribe("other");
  const res = await request("POST", "/push/test", { endpoint: mine.endpoint });
  assert.deepEqual(res.body, { sent: 1, failed: 0, removed: 0 });
  assert.deepEqual(sent.map((s) => s.endpoint), [mine.endpoint]);
  assert.equal(sent[0].payload.kind, "test");
  assert.equal((await request("POST", "/push/test", { endpoint: "https://fcm.googleapis.com/fcm/send/nobody" })).status, 404);
});

// --- Who may subscribe, and to what ---

test("only endpoints on the known push services are accepted", async () => {
  const ok = [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGx",
    "https://api.push.apple.com/3/device/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ];
  for (const endpoint of ok) assert.ok(pushServiceOf(endpoint), endpoint);
  const bad = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.com/fcm/send/abc",
    "https://evilfcm.googleapis.com/x",
    "https://googleapis.com/x",
    "https://push.services.mozilla.com/x",
    "https://evilpush.services.mozilla.com/x",
    "https://push.apple.com/x",
    "https://web.push.apple.com.attacker.example/x",
    "https://notify.windows.com.evil.com/x",
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",
    "https://evil.example/collect",
    "https://192.168.1.1:8443/push",
    "https://[::1]/push",
    "https://localhost/push",
    "ftp://fcm.googleapis.com/x",
    "not a url",
    // Not in canonical form: WHATWG URL and web-push's url.parse() may read another host.
    "https:fcm.googleapis.com/x",
    "https:/web.push.apple.com/x",
    "https:\\\\updates.push.services.mozilla.com/x",
    "https:\\web.push.apple.com/x",
    "https://FCM.GoogleAPIs.com/fcm/send/abc",
    " https://fcm.googleapis.com/x",
    "https://fcm.googleapis.com/a b",
    // A port, even the default one written out.
    "https://fcm.googleapis.com:8443/x",
    "https://fcm.googleapis.com:443/x",
  ];
  for (const endpoint of bad) assert.equal(pushServiceOf(endpoint), null, endpoint);

  const keys = browserSubscription("x").keys;
  for (const endpoint of [
    "https://evil.example/collect",
    "https://192.168.1.1:8443/push",
    "https://fcm.googleapis.com.evil.com/x",
    "https:fcm.googleapis.com/x",
    "https:/web.push.apple.com/x",
    "https:\\\\updates.push.services.mozilla.com/x",
    "https://fcm.googleapis.com:8443/x",
  ]) {
    const res = await request("POST", "/push/subscribe", { subscription: { endpoint, keys } });
    assert.equal(res.status, 400, endpoint);
  }
  assert.equal(listSubscriptions().length, 0);
});

test("another site's page can't reach the push routes; gitbot's own can, through a proxy too", async () => {
  const sub = browserSubscription("a");
  const evil = { origin: "https://evil.example" };
  for (const [path, body] of [
    ["/push/subscribe", { subscription: sub }],
    ["/push/unsubscribe", { endpoint: sub.endpoint }],
    ["/push/test", {}],
    ["/push/subscriptions", {}],
    ["/push/subscriptions/delete", { id: "x" }],
  ] as const) {
    assert.equal((await request("POST", path, body, evil)).status, 403, path);
    assert.equal((await request("POST", path, body, { origin: "null" })).status, 403, path);
    // A lookalike port or host is another origin.
    assert.equal((await request("POST", path, body, { origin: "http://localhost:3001" })).status, 403, path);
    assert.equal((await request("POST", path, body, { origin: "http://localhost.evil.example:3000" })).status, 403, path);
  }
  assert.equal(listSubscriptions().length, 0);

  // A form post, or text/plain to dodge the preflight: refused.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", undefined]) {
    assert.equal((await request("POST", "/push/subscribe", { subscription: sub }, { "content-type": type })).status, 415, String(type));
  }
  assert.equal(listSubscriptions().length, 0);
  // Nor does the preflight invite one in.
  const preflight = await rawPreflight("/push/subscribe");
  assert.equal(preflight["access-control-allow-origin"], undefined);

  // Same origin: on localhost; with a charset; with no Origin (curl).
  assert.equal((await request("POST", "/push/subscribe", { subscription: sub }, { origin: "http://localhost:3000" })).status, 200);
  assert.equal((await request("POST", "/push/subscribe", { subscription: sub }, { "content-type": "application/json; charset=utf-8" })).status, 200);
  // Behind an HTTPS proxy that keeps Host (Tailscale Serve, Caddy), with or without ":443".
  const ts = "gitbot.tail1234.ts.net";
  assert.equal((await request("POST", "/push/subscriptions", {}, { origin: `https://${ts}`, host: ts })).status, 200);
  assert.equal((await request("POST", "/push/subscriptions", {}, { origin: `https://${ts}`, host: `${ts}:443` })).status, 200);
  // One that rewrites Host to the upstream and says the original in X-Forwarded-Host (nginx, the Next dev server).
  assert.equal(
    (await request("POST", "/push/subscriptions", {}, { origin: `https://${ts}`, host: "127.0.0.1:3000", "x-forwarded-host": ts })).status,
    200,
  );
  assert.equal(
    (await request("POST", "/push/subscriptions", {}, { origin: "http://localhost:3001", host: "127.0.0.1:3100", "x-forwarded-host": "localhost:3001" })).status,
    200,
  );
  assert.equal(
    (await request("POST", "/push/subscriptions", {}, { origin: "https://evil.example", host: "127.0.0.1:3000", "x-forwarded-host": ts })).status,
    403,
  );
});

/** The preflight's headers, lowercased. */
async function rawPreflight(url: string): Promise<Record<string, string>> {
  const req = Object.assign(new EventEmitter(), { method: "OPTIONS", url, headers: { origin: "https://evil.example" } }) as unknown as IRequest;
  let headers: Record<string, string> = {};
  const res: IResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead(_code, h) { headers = Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v])); },
    write() {},
    end() {},
  };
  await handleRequest(req, res, ALL_AGENTS, tmpdir());
  return headers;
}

test("at the cap a new browser is refused, and none is pushed out; a known one still refreshes", async () => {
  const subs = Array.from({ length: MAX_SUBSCRIPTIONS }, (_, i) => browserSubscription(`s${i}`));
  writeFileSync(
    join(dataDir(), "push-subscriptions.json"),
    JSON.stringify(subs.map((s) => ({ endpoint: s.endpoint, keys: s.keys, createdAt: "2026-01-01T00:00:00.000Z" }))),
  );
  const res = await request("POST", "/push/subscribe", { subscription: browserSubscription("new") });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Delete one/);
  assert.equal(listSubscriptions().length, MAX_SUBSCRIPTIONS);
  assert.equal(listSubscriptions()[0].endpoint, subs[0].endpoint);

  // The first one again, with new keys: updated in place, date kept, user agent filled in.
  const fresh = { ...browserSubscription("s0"), endpoint: subs[0].endpoint };
  assert.equal((await request("POST", "/push/subscribe", { subscription: fresh })).status, 200);
  const first = listSubscriptions()[0];
  assert.deepEqual(first.keys, fresh.keys);
  assert.equal(first.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(first.userAgent, "TestBrowser/1.0");
  assert.equal(listSubscriptions().length, MAX_SUBSCRIPTIONS);
});

test("the settings list shows a safe label per subscription, and deletes by id", async () => {
  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
  const mine = browserSubscription("mine");
  assert.equal((await request("POST", "/push/subscribe", { subscription: mine }, { "user-agent": CHROME_MAC })).status, 200);
  const iphone = {
    ...browserSubscription("phone"),
    endpoint: "https://web.push.apple.com/QGxphone",
  };
  // Saved before this change: no user agent, no date.
  const stored = listSubscriptions();
  writeFileSync(
    join(dataDir(), "push-subscriptions.json"),
    JSON.stringify([...stored, { endpoint: iphone.endpoint, keys: iphone.keys }]),
  );

  const res = await request("POST", "/push/subscriptions", { endpoint: mine.endpoint });
  assert.equal(res.status, 200);
  const list = res.body.subscriptions;
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    id: subscriptionId(mine.endpoint),
    service: "Google",
    device: "Chrome on macOS",
    addedAt: stored[0].createdAt,
    current: true,
  });
  assert.deepEqual(list[1], { id: subscriptionId(iphone.endpoint), service: "Apple", device: null, addedAt: null, current: false });
  // Nothing secret goes to the page: no endpoint, no keys.
  const text = JSON.stringify(res.body);
  for (const secret of [mine.endpoint, iphone.endpoint, mine.keys.auth, mine.keys.p256dh]) {
    assert.ok(!text.includes(secret), secret);
  }
  // Without an endpoint, none is "this device".
  assert.ok((await request("POST", "/push/subscriptions", {})).body.subscriptions.every((s: any) => !s.current));

  assert.deepEqual((await request("POST", "/push/subscriptions/delete", { id: list[1].id })).body, { removed: true });
  assert.deepEqual((await request("POST", "/push/subscriptions/delete", { id: list[1].id })).body, { removed: false });
  assert.equal((await request("POST", "/push/subscriptions/delete", {})).status, 400);
  assert.deepEqual(listSubscriptions().map((s) => s.endpoint), [mine.endpoint]);
});

test("user agents become a browser and a system", () => {
  const cases: Array<[string | undefined, string | null]> = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "Chrome on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    // The installed Home Screen app on iOS: no "Safari/" in it.
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "Safari on iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on macOS"],
    ["TestBrowser/1.0", null],
    [undefined, null],
  ];
  for (const [ua, want] of cases) assert.equal(describeUserAgent(ua), want, String(ua));
});

test("a browser deleted from settings stays deleted until it turns notifications on again", async () => {
  const phone = await subscribe("phone");
  const id = subscriptionId(phone.endpoint);
  assert.deepEqual((await request("POST", "/push/subscriptions/delete", { id })).body, { removed: true });

  // The phone opens gitbot: its page re-sends the subscription it still has, and is told no.
  const refresh = await request("POST", "/push/subscribe", { subscription: phone, refresh: true });
  assert.deepEqual(refresh.body, { subscribed: false, deleted: true });
  assert.equal(listSubscriptions().length, 0);

  // A click on Enable there brings it back, and later refreshes work again.
  assert.equal((await request("POST", "/push/subscribe", { subscription: phone })).body.subscribed, true);
  assert.equal((await request("POST", "/push/subscribe", { subscription: phone, refresh: true })).body.subscribed, true);
  assert.equal(listSubscriptions().length, 1);
});

/** Entries this build does not accept: from an older build, a newer one, or a hand edit. */
function invalidEntries() {
  const keys = browserSubscription("x").keys;
  return [
    { endpoint: "https://evil.example/collect", keys },
    { endpoint: "https:fcm.googleapis.com/x", keys },
    { endpoint: "https:/web.push.apple.com/x", keys },
    { endpoint: "https://fcm.googleapis.com:8443/x", keys },
    // A push service a newer gitbot might know.
    { endpoint: "https://push.example-newer-service.com/abc", keys, createdAt: "2026-01-01T00:00:00.000Z" },
    { endpoint: "https://fcm.googleapis.com/fcm/send/badkeys", keys: { p256dh: "short", auth: keys.auth } },
    { nonsense: true },
  ];
}

test("invalid saved subscriptions are skipped and kept: not sent to, not listed, not counted, not deleted", async () => {
  const bad = invalidEntries();
  const good = Array.from({ length: MAX_SUBSCRIPTIONS - 1 }, (_, i) => browserSubscription(`ok${i}`))
    .map((s) => ({ endpoint: s.endpoint, keys: s.keys, createdAt: "2026-01-01T00:00:00.000Z" }));
  const file = join(dataDir(), "push-subscriptions.json");
  const written = JSON.stringify([...bad.slice(0, 3), ...good, ...bad.slice(3)]);
  writeFileSync(file, written);

  // Reading leaves the file exactly as it was.
  assert.deepEqual(listSubscriptions().map((s) => s.endpoint), good.map((s) => s.endpoint));
  assert.equal((await request("POST", "/push/subscriptions", {})).body.subscriptions.length, good.length);
  assert.equal(readFileSync(file, "utf-8"), written);

  // And nothing is sent to them.
  await request("POST", "/push/test", {});
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), good.map((s) => s.endpoint).sort());

  // The cap counts valid ones only: 49 + 7 invalid in the file, and one more fits...
  const last = browserSubscription("last");
  assert.equal((await request("POST", "/push/subscribe", { subscription: last })).status, 200);
  // ...then it is full.
  assert.equal((await request("POST", "/push/subscribe", { subscription: browserSubscription("over") })).status, 409);

  // Writing for another reason keeps the invalid entries as they were.
  const onDisk = () => JSON.parse(readFileSync(file, "utf-8")) as unknown[];
  const invalidOnDisk = () => onDisk().filter((e) => !parseSubscription(e));
  assert.deepEqual(invalidOnDisk(), bad);
  assert.equal((await request("POST", "/push/subscriptions/delete", { id: subscriptionId(last.endpoint) })).body.removed, true);
  assert.deepEqual(invalidOnDisk(), bad);
  assert.equal(onDisk().length, bad.length + good.length);
});

test("an unwritable data directory doesn't make the approvals listener throw", async (t) => {
  await subscribe("a");
  const file = join(dataDir(), "push-subscriptions.json");
  writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, "utf-8")), ...invalidEntries()]));
  const before = readFileSync(file, "utf-8");

  // A listener registered after push's, like the UI's live updates.
  const seen: number[] = [];
  const later = (permissions: unknown[]) => { seen.push(permissions.length); };
  permissionsEmitter.on("update", later);
  const thread = plainThread("Builder");
  const started = startTurn({ threadId: thread.id, prompt: "build it" }, ALL_AGENTS);
  assert.ok(started.ok);
  const store = runs[runs.length - 1];
  await tick();

  const mode = statSync(dataDir()).mode & 0o777;
  chmodSync(dataDir(), 0o555);
  t.after(() => {
    chmodSync(dataDir(), mode);
    permissionsEmitter.off("update", later);
  });
  store.pendingPermissions.set("tu-ro", { resolve: () => {}, input: { command: "ls" }, toolName: "Bash", toolUseID: "tu-ro" });
  assert.doesNotThrow(() => notifyPermissionsChanged());
  await settle();
  // The later listener got the broadcast with the approval in it.
  assert.equal(seen.at(-1), 1);
  assert.deepEqual(sent.map((s) => s.payload.kind), ["approval"]);
  assert.equal(readFileSync(file, "utf-8"), before);

  store.pendingPermissions.clear();
  assert.doesNotThrow(() => notifyPermissionsChanged());
});
