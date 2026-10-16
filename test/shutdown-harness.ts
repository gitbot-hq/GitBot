// Run as a child process by test/shutdown.test.ts (not a test itself): a
// stand-in gitbot wired as start() wires it — signal handlers first, then the
// exit cleanup — and caught mid-startup: setupShutdown has not run, and the
// opencode server it spawned has not said it is listening yet. It holds what
// used to keep a "stopped" gitbot alive or leave children behind:
//   - an open SSE stream, as a browser tab holds;
//   - a ref'd timer;
//   - a running turn whose agent is a child spawned with its controller's
//     signal, as codex's is;
//   - a spawned "opencode serve" still starting (a stand-in at the SDK seam,
//     spawned with the signal gitbot passes, never resolving).
// It prints one JSON line when ready, and should die at once on SIGTERM or
// SIGINT, taking both children with it.
import { installSignalHandlers } from "../src/shutdown";
installSignalHandlers();

import http from "node:http";
import { spawn } from "child_process";
import { sessions, sseHeaders, type SessionStore } from "../src/server-common";
import { installExitCleanup } from "../src/server";
import { opencodeServer, spawnServer } from "../src/start-opencode";

installExitCleanup();

let opencodePid: number | undefined;
opencodeServer.create = ({ signal }) => {
  const proc = spawn("sleep", ["61"], { signal, stdio: "ignore" });
  proc.on("error", () => {});
  opencodePid = proc.pid;
  return new Promise(() => {}); // Never says it is listening.
};
void spawnServer();

const ac = new AbortController();
const agent = spawn("sleep", ["60"], { signal: ac.signal, stdio: "ignore" });
agent.on("error", () => {});
sessions.set("harness", { gitbotId: "harness", status: "running", abortController: ac } as unknown as SessionStore);

// A ref'd timer: on its own it would keep the process alive for good.
setInterval(() => {}, 1_000);

const server = http.createServer((req, res) => {
  res.writeHead(200, sseHeaders());
  res.write(": open\n\n");
  // Never ended, like /permissions/events with a tab open.
});
server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({
    ready: true,
    port: (server.address() as { port: number }).port,
    agentPid: agent.pid,
    opencodePid,
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
    uncaught: process.listenerCount("uncaughtException"),
  }));
});
