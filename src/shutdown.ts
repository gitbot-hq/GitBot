// Stopping gitbot. SIGINT (Ctrl-C) and SIGTERM (kill, systemd) take one path:
// exit at once, in the same tick as the signal. Nothing can run after it — no
// scheduler tick, no request, no turn start — and the kernel closes every
// socket, the UI's open event streams included. Cleanup lives in
// process.on("exit") handlers registered before anything is spawned
// (installExitCleanup in server.ts, maybeCaffeinate in server-common.ts,
// the Claude Agent SDK's own child reaper), so a signal, a normal exit and a
// crash all clean up alike. Running turns are killed, as Ctrl-C always did: a
// reportable child keeps its running mark, and the next start tells its Jarvis.
//
// A leaf module: index.ts installs the handlers before anything else loads.

let shuttingDown = false;

/**
 * True once gitbot has begun shutting down. Turns that end from here on were
 * killed by the shutdown, not finished: they report to no one and keep their
 * running mark, so the next start tells their Jarvis.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** For tests: a shutdown without the process exit. */
export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

/**
 * Stops gitbot now: raises the flag, logs, and exits 0 in this same tick. The
 * exit handlers do the cleanup. `exit` is a seam for tests.
 */
export function exitNow(signal: NodeJS.Signals, exit: (code: number) => void = (code) => process.exit(code)): void {
  shuttingDown = true;
  console.log(`\nShutting down (${signal})...`);
  exit(0);
}

let installed: (() => void) | null = null;

/**
 * Sends SIGINT and SIGTERM to exitNow. Call once, first thing at startup.
 * Idempotent; returns the uninstall (for tests).
 */
export function installSignalHandlers(): () => void {
  if (installed) return installed;
  const onInt = () => exitNow("SIGINT");
  const onTerm = () => exitNow("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const uninstall = () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    if (installed === uninstall) installed = null;
  };
  installed = uninstall;
  return uninstall;
}
