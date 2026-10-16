import "./temp-data-dir";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import http from "node:http";
import { join } from "path";
import { exitNow, installSignalHandlers, isShuttingDown, setShuttingDown } from "../src/shutdown";
import { abortRunningSessions, isShuttingDown as commonIsShuttingDown, sessions, type SessionStore } from "../src/server-common";

// Stopping gitbot (shutdown.ts): SIGINT and SIGTERM exit in the signal's own
// tick, whatever is still open; the exit handlers kill running agents.

test("exitNow raises the flag, then exits 0 in the same tick", (t) => {
  t.mock.method(console, "log", () => {});
  const codes: number[] = [];
  try {
    exitNow("SIGTERM", (code) => {
      assert.equal(isShuttingDown(), true, "the flag is up before the exit");
      codes.push(code);
    });
    assert.deepEqual(codes, [0], "exited before exitNow returned");
    assert.equal(commonIsShuttingDown(), true, "server-common reads the same flag");
  } finally {
    setShuttingDown(false);
  }
});

test("installSignalHandlers adds one SIGINT and one SIGTERM handler, once", () => {
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  const uninstall = installSignalHandlers();
  try {
    assert.equal(installSignalHandlers(), uninstall, "a second call is the same install");
    assert.equal(process.listenerCount("SIGINT"), before.int + 1);
    assert.equal(process.listenerCount("SIGTERM"), before.term + 1);
  } finally {
    uninstall();
  }
  assert.equal(process.listenerCount("SIGINT"), before.int);
  assert.equal(process.listenerCount("SIGTERM"), before.term);
});

test("abortRunningSessions aborts every turn's controller, past one that throws", () => {
  const good = new AbortController();
  const fake = (id: string, abortController: unknown) =>
    ({ gitbotId: id, status: "running", abortController }) as unknown as SessionStore;
  sessions.set("bad", fake("bad", { abort: () => { throw new Error("boom"); } }));
  sessions.set("idle", fake("idle", null));
  sessions.set("good", fake("good", good));
  try {
    abortRunningSessions();
    assert.equal(good.signal.aborted, true);
  } finally {
    for (const id of ["bad", "idle", "good"]) sessions.delete(id);
  }
});

/** Starts the harness, opens its SSE stream, sends `signal`, and reports what happened. */
async function signalHarness(signal: NodeJS.Signals) {
  const harness = join(__dirname, "shutdown-harness.ts");
  // Not a test-runner child: with NODE_TEST_CONTEXT set, node would take the
  // harness for a test file and hold its output.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", harness], {
    cwd: join(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, sig) => resolve({ code, signal: sig })));

  const ready = await new Promise<{ port: number; agentPid: number; opencodePid: number; sigint: number; sigterm: number; uncaught: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness not ready: ${out} ${err}`)), 20_000);
    child.stdout.on("data", () => {
      const line = out.split("\n").find((l) => l.startsWith("{"));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`harness exited early: ${out} ${err}`)); });
  });

  // An open event stream, as a browser tab holds.
  // (Wrapped: a promise resolved with a promise would wait for it.)
  const { closed: streamClosed } = await new Promise<{ closed: Promise<void> }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: ready.port, path: "/permissions/events" }, (res) => {
      const closed = new Promise<void>((done) => {
        res.on("close", done);
        res.on("error", () => done());
      });
      res.resume();
      resolve({ closed });
    }).on("error", reject);
  });

  const t0 = Date.now();
  child.kill(signal);
  const result = await exited;
  const elapsedMs = Date.now() - t0;
  await streamClosed;

  const agentAlive = await stillAlive(ready.agentPid);
  const opencodeAlive = await stillAlive(ready.opencodePid);
  return { ready, result, elapsedMs, out, agentAlive, opencodeAlive };
}

/** Whether `pid` is alive after a moment's grace (init reaps an orphan once it dies); kills a survivor. */
async function stillAlive(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  process.kill(pid, "SIGKILL");
  return true;
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} mid-startup, with an open event stream, exits at once and kills the agent and a starting opencode server`, { timeout: 30_000 }, async () => {
    const { ready, result, elapsedMs, out, agentAlive, opencodeAlive } = await signalHarness(signal);
    assert.equal(ready.sigint, 1, "one SIGINT handler: exitNow");
    assert.equal(ready.sigterm, 1, "one SIGTERM handler: exitNow");
    assert.equal(ready.uncaught, 0, "caught before setupShutdown ran");
    assert.deepEqual(result, { code: 0, signal: null }, "a clean exit, through our handler");
    assert.ok(elapsedMs < 1_000, `exited in ${elapsedMs}ms`);
    assert.match(out, new RegExp(`Shutting down \\(${signal}\\)`));
    assert.equal(agentAlive, false, "the running turn's agent child was killed");
    assert.equal(opencodeAlive, false, "the opencode server still starting was killed");
  });
}
