import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHttpServer, findAvailablePort, getLocalIP, isLoopbackHost, resolveHost, showQR } from "./server-common";

/** Runs `fn` with console.log captured, and hands back what was printed. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); };
  try { await fn(); } finally { console.log = log; }
  return logs;
}

function connect(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.get({ host, port, path: "/host-check", timeout: 2000 }, res => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("timeout", () => req.destroy(new Error("Connection timed out")));
    req.on("error", reject);
  });
}

/** The CLI, run far enough to parse its flags but never far enough to listen. */
function cli(...args: string[]) {
  return spawnSync(process.execPath, [require.resolve("tsx/cli"), path.join(__dirname, "index.ts"), ...args], { encoding: "utf8" });
}

// A QR code is drawn with block characters; nothing else in the banner uses them.
const hasQR = (logs: string[]) => logs.some(line => /[\u2580-\u259f]/.test(line));

test("no flag binds every interface, -l binds loopback, --host wins over -l", () => {
  assert.equal(resolveHost({}), "0.0.0.0");
  assert.equal(resolveHost({ local: false }), "0.0.0.0");
  assert.equal(resolveHost({ local: true }), "127.0.0.1");
  assert.equal(resolveHost({ host: "192.168.1.5" }), "192.168.1.5");
  assert.equal(resolveHost({ host: "127.0.0.1" }), "127.0.0.1");
  assert.equal(resolveHost({ local: true, host: "100.64.0.7" }), "100.64.0.7");

  assert.ok(isLoopbackHost("127.0.0.1"));
  assert.ok(isLoopbackHost("127.0.0.53"));
  assert.ok(isLoopbackHost("::1"));
  assert.ok(!isLoopbackHost("0.0.0.0"));
  assert.ok(!isLoopbackHost("192.168.1.5"));
});

test("-l keeps the hub unreachable from the network and prints no QR code", async () => {
  const lan = getLocalIP();
  let stop = async () => {};
  const logs = await captureLogs(async () => {
    const { server, PORT } = await createHttpServer({ host: resolveHost({ local: true }), portOverride: 0, caffeinate: false, label: "test" });
    server.on("request", (_req, res) => { if (!res.headersSent) res.end("ok"); });
    stop = () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    await connect("127.0.0.1", PORT);
    if (lan !== "localhost") await assert.rejects(connect(lan, PORT), { code: "ECONNREFUSED" });
  });
  await stop();
  assert.ok(logs.some(line => /Local\s+http:\/\/127\.0\.0\.1:\d+/.test(line)), "prints the local address");
  assert.ok(logs.some(line => line.includes("Only this computer can connect")), "says it is local only");
  assert.ok(!logs.some(line => line.includes("Network")), "prints no network address");
  if (lan !== "localhost") assert.ok(!logs.some(line => line.includes(lan)), "never mentions the LAN address");
  assert.ok(!hasQR(logs), "prints no QR code");
});

test("no flag makes the hub reachable on the LAN address and prints it with a QR code", async () => {
  const lan = getLocalIP();
  let stop = async () => {};
  let port = 0;
  const logs = await captureLogs(async () => {
    const { server, PORT } = await createHttpServer({ host: resolveHost({}), portOverride: 0, caffeinate: false, label: "test" });
    port = PORT;
    server.on("request", (_req, res) => { if (!res.headersSent) res.end("ok"); });
    stop = () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "0.0.0.0");
    await connect("127.0.0.1", PORT); // still works on the computer itself
    if (lan !== "localhost") await connect(lan, PORT);
  });
  await stop();
  assert.ok(logs.some(line => line.includes(`Local    http://127.0.0.1:${port}`)), "still prints the local address");
  assert.ok(logs.some(line => line.includes(`Network  http://${lan}:${port}`)), "prints the network address");
  assert.ok(logs.some(line => line.includes("no login")), "warns that there is no login");
  assert.ok(logs.some(line => line.includes("Run with -l")), "says how to keep it local");
  assert.ok(hasQR(logs), "prints a QR code");
});

test("--host binds exactly the address given", async () => {
  const lan = getLocalIP();
  if (lan === "localhost") return; // no network interface to bind
  let stop = async () => {};
  const logs = await captureLogs(async () => {
    const { server, PORT } = await createHttpServer({ host: resolveHost({ local: true, host: lan }), portOverride: 0, caffeinate: false, label: "test" });
    server.on("request", (_req, res) => { if (!res.headersSent) res.end("ok"); });
    stop = () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await connect(lan, PORT);
    // Bound to one interface, loopback is not that interface.
    await assert.rejects(connect("127.0.0.1", PORT), { code: "ECONNREFUSED" });
  });
  await stop();
  assert.ok(logs.some(line => line.includes(`Network  http://${lan}:`)));
  assert.ok(!logs.some(line => line.includes("Local ")), "does not claim a local address it is not listening on");
  assert.ok(hasQR(logs));
});

test("the CLI offers -l/--local and --host", () => {
  const help = cli("start", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /-l, --local\b/);
  assert.match(help.stdout, /--host <address>/);

  // A bad --host stops the CLI before it listens. Reaching that check proves the
  // flags in front of it were parsed rather than rejected as unknown.
  for (const flags of [["-l"], ["--local"]]) {
    const run = cli("start", ...flags, "--host", "not-an-ip");
    assert.equal(run.status, 1, `${flags.join(" ")} is accepted`);
    assert.match(run.stderr, /--host must be an IPv4 or IPv6 address/);
    assert.doesNotMatch(run.stderr, /unknown option/);
  }
  const unknown = cli("start", "--nope");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown option/);
});

// createHttpServer itself stays loopback unless handed a host; the LAN default is the CLI's choice.
test("createHttpServer binds loopback without a host and every interface when given 0.0.0.0", async () => {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); };
  const lan = getLocalIP();
  try {
    for (const host of [undefined, "0.0.0.0"]) {
      logs.length = 0;
      const { server, PORT } = await createHttpServer({ host, portOverride: 0, caffeinate: false, label: "test" });
      server.on("request", (_req, res) => {
        if (!res.headersSent) res.end("ok");
      });
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        assert.equal(address.address, host ?? "127.0.0.1");
        await connect("127.0.0.1", PORT);
        if (lan !== "localhost") {
          if (host) await connect(lan, PORT);
          else await assert.rejects(connect(lan, PORT), { code: "ECONNREFUSED" });
        }
        assert.ok(logs.some(line => line.includes(`http://${host ? lan : "127.0.0.1"}:${PORT}`)));
        assert.equal(await findAvailablePort(PORT, PORT + 1, host), PORT + 1);
      } finally {
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      }
    }
    logs.length = 0;
    await showQR("::1", 3000);
    assert.ok(logs.some(line => line.includes("http://[::1]:3000")));
  } finally {
    console.log = log;
  }
});
