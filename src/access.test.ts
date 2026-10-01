import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createAccessGuard, generateToken, isLoopbackAddress, SESSION_COOKIE } from "./access";
import { createHttpServer, getLocalIP } from "./server-common";

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(host: string, port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, headers, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

test("helpers", () => {
  assert.equal(generateToken().length, 32);
  assert.notEqual(generateToken(), generateToken());
  assert.ok(isLoopbackAddress("127.0.0.1"));
  assert.ok(isLoopbackAddress("::1"));
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1"));
  assert.ok(!isLoopbackAddress("192.168.1.20"));
  assert.ok(!isLoopbackAddress(undefined));
});

test("without -t the guard is off and the URL is untouched", () => {
  const off = createAccessGuard({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.bootstrapToken, null);
  assert.equal(off.urlFor("http://10.0.0.5:3000"), "http://10.0.0.5:3000");
  const on = createAccessGuard({ enabled: true });
  assert.ok(on.bootstrapToken && on.bootstrapToken.length === 32);
  assert.equal(on.urlFor("http://10.0.0.5:3000"), `http://10.0.0.5:3000/?token=${on.bootstrapToken}`);
  assert.equal(on.bootstrapUsed, false);
});

test("-t: one-time bootstrap link, session cookie, denial, loopback exemption", async () => {
  const lan = getLocalIP();
  if (lan === "localhost") { console.log("  (no LAN address on this machine; skipping network checks)"); return; }
  const log = console.log; console.log = () => {};
  const { server, PORT, access } = await createHttpServer({ host: "0.0.0.0", portOverride: 0, caffeinate: false, token: true, label: "test" });
  const boot = access.bootstrapToken!;
  let reached = 0;
  server.on("request", (_req, res) => { if (!res.headersSent) { reached++; res.end("ok"); } });
  try {
    // Nothing from the network gets through before the link is used.
    assert.equal((await request(lan, PORT, "/")).status, 401);
    const html = await request(lan, PORT, "/", { accept: "text/html" });
    assert.equal(html.status, 401);
    assert.match(html.body, /access link/);
    for (const path of ["/bots", "/events?sessionId=x", "/marketplace/v1/bots", "/_next/static/x.js"]) {
      assert.equal((await request(lan, PORT, path)).status, 401, path);
    }
    assert.equal((await request(lan, PORT, "/?token=not-the-right-one-at-all")).status, 403);
    assert.equal(reached, 0);

    // The link: a session cookie, a redirect to the same page minus the token.
    const swap = await request(lan, PORT, `/marketplace?token=${boot}&bot=lumie`);
    assert.equal(swap.status, 303);
    assert.equal(swap.headers.location, "/marketplace?bot=lumie");
    const setCookie = String(swap.headers["set-cookie"]);
    const m = setCookie.match(new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]+); Path=/; HttpOnly; SameSite=Strict`));
    assert.ok(m, setCookie);
    const session = m![1];
    assert.notEqual(session, boot);
    assert.equal(access.bootstrapUsed, true);
    assert.equal(reached, 0);

    // The bootstrap token is spent: as a link, and never as a cookie.
    assert.equal((await request(lan, PORT, `/?token=${boot}`)).status, 403);
    assert.equal((await request(lan, PORT, "/bots", { cookie: `${SESSION_COOKIE}=${boot}` })).status, 401);

    // The session cookie admits every route, exactly once each.
    for (const path of ["/bots", "/events?sessionId=x", "/marketplace/v1/bots"]) {
      const ok = await request(lan, PORT, path, { cookie: `${SESSION_COOKIE}=${session}` });
      assert.equal(ok.status, 200, path);
      assert.equal(ok.body, "ok", path);
    }
    assert.equal(reached, 3);
    // The page itself is served by the static listener once signed in.
    assert.equal((await request(lan, PORT, "/", { cookie: `${SESSION_COOKIE}=${session}` })).status, 200);
    assert.equal((await request(lan, PORT, "/bots", { cookie: `${SESSION_COOKIE}=some-other-value-entirely` })).status, 401);

    // Loopback never needs any of it, before or after the exchange.
    assert.equal((await request("127.0.0.1", PORT, "/bots")).status, 200);
    assert.equal(reached, 4);
  } finally {
    console.log = log;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("without -t a network client is served as before", async () => {
  const lan = getLocalIP();
  if (lan === "localhost") return;
  const log = console.log; console.log = () => {};
  const { server, PORT, access } = await createHttpServer({ host: "0.0.0.0", portOverride: 0, caffeinate: false, label: "test" });
  server.on("request", (_req, res) => { if (!res.headersSent) res.end("ok"); });
  try {
    assert.equal(access.enabled, false);
    assert.equal((await request(lan, PORT, "/bots")).status, 200);
  } finally {
    console.log = log;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("-t prints the link with the bootstrap token", async () => {
  const lan = getLocalIP();
  if (lan === "localhost") return;
  const logs: string[] = [];
  const log = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
  const { server, PORT, access } = await createHttpServer({ host: "0.0.0.0", portOverride: 0, caffeinate: false, token: true, label: "test" });
  try {
    assert.ok(logs.some((l) => l.includes(`http://${lan}:${PORT}/?token=${access.bootstrapToken}`)));
    assert.ok(logs.some((l) => l.includes("works once")));
  } finally {
    console.log = log;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
