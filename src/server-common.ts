import { networkInterfaces } from "os";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync, execFile, spawn } from "child_process";
import http from "node:http";
import { EventEmitter } from "events";
import qrcode from "qrcode-terminal";
import { html } from "./client-html";
import { vendorScripts } from "./client-vendor";
import { listRepos, cloneRepo, createFolder, listDir, readFile, getRepoDetails, browseDirs } from "./workspace";

// --- Transport abstractions ---
// These interfaces cover the exact surface area that route handlers use.
// Both http.IncomingMessage/ServerResponse and the relay adapters satisfy them structurally.

export interface IRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "close", listener: () => void): this;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface IResponse {
  headersSent: boolean;
  writableEnded: boolean;
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  write(chunk: string): void;
  end(chunk?: string): void;
}

const SERVER_VERSION: string = require("../package.json").version;
// Semver range of client app versions this server build can service.
// Raise the floor when a breaking protocol change makes old clients incompatible.
const CLIENT_VERSION_RANGE = ">=1.0.0";

export const PORT_RANGE_START = 32100;
export const PORT_RANGE_END = 32199;

export function findAvailablePort(startPort: number, endPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > endPort) {
        reject(new Error(`No available port found in range ${startPort}–${endPort}`));
        return;
      }
      const server = http.createServer();
      server.listen(port, () => {
        server.close(() => resolve(port));
      });
      server.on("error", () => tryPort(port + 1));
    };
    tryPort(startPort);
  });
}

export function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

export function getPublicIP(): Promise<string | null> {
  return new Promise((resolve) => {
    http.get("http://api.ipify.org", (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data.trim() || null));
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

export function getTailscaleIP(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("tailscale", ["status"], { timeout: 2000 }, (err) => {
      if (err) return resolve(null);
      execFile("tailscale", ["ip", "-4"], { timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(null);
        const ip = stdout.trim().split("\n")[0];
        resolve(ip || null);
      });
    });
  });
}

export async function showQR(network: string, port: number): Promise<void> {
  let ip: string;
  let label: string;

  if (network === "tailscale") {
    const tsIP = await getTailscaleIP();
    if (!tsIP) {
      console.error("  Tailscale IP not found. Is Tailscale running?");
      process.exit(1);
    }
    ip = tsIP;
    label = "Tailscale";
  } else if (network === "remote-ip") {
    const publicIP = await getPublicIP();
    if (!publicIP) {
      console.error("  Could not determine public IP address.");
      process.exit(1);
    }
    ip = publicIP;
    label = "Public";
  } else if (network === "local") {
    ip = getLocalIP();
    label = "Local Network";
  } else {
    ip = network;
    label = "Custom";
  }

  const url = `http://${ip}:${port}`;
  console.log(`\n  ${label}  ${url}\n`);

  const qrCode = await new Promise<string>((resolve) => {
    qrcode.generate(url, { small: true }, (code: string) => {
      resolve(code.trimEnd());
    });
  });

  console.log(qrCode);
}

export async function showRelayQR(relayBaseUrl: string, token: string): Promise<void> {
  // Convert ws(s):// to http(s):// for the app-facing URL
  const appUrl = relayBaseUrl.replace(/^ws(s?):\/\//, "http$1://") + `/s/${token}`;
  console.log(`\n  Relay  ${appUrl}\n`);
  const qrCode = await new Promise<string>((resolve) => {
    qrcode.generate(appUrl, { small: true }, (code: string) => {
      resolve(code.trimEnd());
    });
  });
  console.log(qrCode);
}

export function maybeCaffeinate(enabled: boolean): number | null {
  if (!enabled) return null;
  try {
    execSync("which caffeinate", { stdio: "ignore" });
  } catch {
    return null;
  }
  const hours = 8;
  const seconds = hours * 60 * 60;
  const child = spawn("caffeinate", ["-t", String(seconds)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`  caffeinate: running for ${hours}h (pid ${child.pid})`);
  return child.pid ?? null;
}

export function killCaffeinate(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

// --- Session Store ---

export interface StoredEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

export interface PendingPermission {
  resolve: (result: any) => void;
  input: any;
  toolName: string;
  toolUseID: string;
  // sdk session that originally raised the permission. Differs from store.sdkSessionId
  // when an opencode subagent (child session) asked it.
  askedBySdkSessionId?: string;
}

export type PermissionMode = "ask-permissions" | "allow-all-edits" | "yolo";

export const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export const TOOL_BLACKLIST: Record<"claude-code" | "opencode" | "codex", Set<string>> = {
  "claude-code": new Set(["ExitPlanMode", "AskUserQuestion"]),
  "opencode": new Set(),
  "codex": new Set(),
};

/**
 * Bot presets describe permissions in the hub's words; sessions want a
 * PermissionMode (and, for plan, a run mode). Keep the two vocabularies in sync
 * here — a preset value with no translation silently ends up asking for
 * everything.
 */
export function botPermissionToSession(
  botMode: "ask-permissions" | "auto-approve" | "plan"
): { permissionMode: PermissionMode; mode?: "plan" | "build" } {
  switch (botMode) {
    case "auto-approve": return { permissionMode: "yolo" };
    case "plan": return { permissionMode: "yolo", mode: "plan" };
    default: return { permissionMode: "ask-permissions" };
  }
}

export function shouldAutoApprove(
  agent: "claude-code" | "opencode" | "codex",
  toolName: string,
  mode: PermissionMode
): boolean {
  if (mode === "ask-permissions") return false;
  if (TOOL_BLACKLIST[agent].has(toolName)) return false;
  if (mode === "yolo") return true;
  if (mode === "allow-all-edits") return EDIT_TOOLS.has(toolName);
  return false;
}

export interface SessionStore {
  gitbotId: string;
  sdkSessionId: string | null;
  agent: "claude-code" | "opencode" | "codex";
  repoPath: string;
  model?: string;
  mode?: "plan" | "build";
  permissionMode: PermissionMode;
  seq: number;
  events: StoredEvent[];
  status: "running" | "done" | "error";
  emitter: EventEmitter;
  abortController: AbortController | null;
  pendingPermissions: Map<string, PendingPermission>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  // Most recent in-flight Task tool callID. Child-session events route here as parent_tool_use_id.
  lastTaskToolUseId?: string;
  // Bot hub: the thread this session belongs to, and the preset driving it.
  threadId?: string;
  botPreset?: BotPreset;
}

/** The parts of a bot that shape the agent run. Mirrors fields on Bot in bot-store. */
export interface BotPreset {
  id: string;
  name: string;
  instructions: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Set only on a setup thread: what this bot needs the machine to have. */
  setupInstructions?: string;
  /** True while this run is the machine-preparation run rather than the bot's job. */
  setup?: boolean;
}

export const sessions = new Map<string, SessionStore>();

// --- Global permissions stream ---

export const permissionsEmitter = new EventEmitter();

export interface PermissionDumpItem {
  sessionId: string;
  sdkSessionId: string | null;
  agent: "claude-code" | "opencode" | "codex";
  repoPath: string;
  repoName: string;
  toolUseID: string;
  toolName: string;
  input: any;
}

export function buildPermissionsDump(): PermissionDumpItem[] {
  const items: PermissionDumpItem[] = [];
  for (const store of sessions.values()) {
    const repoName = store.repoPath.split("/").filter(Boolean).pop() ?? store.repoPath;
    for (const perm of store.pendingPermissions.values()) {
      items.push({
        sessionId: store.gitbotId,
        sdkSessionId: store.sdkSessionId,
        agent: store.agent,
        repoPath: store.repoPath,
        repoName,
        toolUseID: perm.toolUseID,
        toolName: perm.toolName,
        input: perm.input,
      });
    }
  }
  return items;
}

export type SessionStatus = "running" | "awaiting_permissions" | "done" | "error";

export interface SessionSummaryItem {
  gitbotId: string;
  sessionId: string | null;
  status: SessionStatus;
}

export function buildSessionsDump(): SessionSummaryItem[] {
  return [...sessions.values()].map(store => ({
    gitbotId: store.gitbotId,
    sessionId: store.sdkSessionId,
    status: store.pendingPermissions.size > 0 ? "awaiting_permissions" : store.status,
  }));
}

export function notifyPermissionsChanged(): void {
  permissionsEmitter.emit("update", buildPermissionsDump(), buildSessionsDump());
}

// --- Push notification bridge (avoids circular import with relay-client) ---

let _pushSender: ((title: string, body: string, data: Record<string, unknown>) => void) | null = null;

export function setPushNotificationSender(
  fn: ((title: string, body: string, data: Record<string, unknown>) => void) | null
): void {
  _pushSender = fn;
}

export function sendPushViaRelay(title: string, body: string, data: Record<string, unknown>): void {
  _pushSender?.(title, body, data);
}

export function notifyNewPermission(toolName: string): void {
  notifyPermissionsChanged();
  if (permissionsEmitter.listenerCount("update") === 0) {
    sendPushViaRelay(
      "Permission required",
      `gitbot wants to use ${toolName}. Tap to review.`,
      { type: "permission" }
    );
  } else {
    // SSE listener exists but may be stale (iOS keeps connections alive after backgrounding).
    // Wait 5s — if the permission is still pending the user hasn't responded, so push.
    setTimeout(() => {
      if (buildPermissionsDump().length > 0) {
        sendPushViaRelay(
          "Permission required",
          `gitbot wants to use ${toolName}. Tap to review.`,
          { type: "permission" }
        );
      }
    }, 10000);
  }
}

export function notifySessionDone(store: SessionStore): void {
  const repoName = store.repoPath.split("/").filter(Boolean).pop() ?? store.repoPath;
  const send = () => sendPushViaRelay(
    "Task complete",
    `gitbot finished working on ${repoName}. Tap to see the response.`,
    { type: "task_complete", sessionId: store.gitbotId }
  );

  if (store.emitter.listenerCount("event") === 0) {
    send();
  } else {
    setTimeout(send, 2000);
  }
}

export function createSession(
  gitbotId: string,
  agent: "claude-code" | "opencode" | "codex",
  repoPath: string,
  model?: string,
  mode?: SessionStore["mode"],
  permissionMode?: PermissionMode,
  bot?: { threadId?: string; preset?: BotPreset }
): SessionStore {
  const store: SessionStore = {
    gitbotId,
    sdkSessionId: null,
    agent,
    repoPath,
    model,
    mode,
    permissionMode: permissionMode ?? "ask-permissions",
    seq: 0,
    events: [],
    status: "running",
    emitter: new EventEmitter(),
    abortController: null,
    pendingPermissions: new Map(),
    cleanupTimer: null,
    threadId: bot?.threadId,
    botPreset: bot?.preset,
  };
  sessions.set(gitbotId, store);
  return store;
}

export function scheduleCleanup(_store: SessionStore): void {
  // Session cleanup disabled — sessions are kept in memory indefinitely
  // if (store.cleanupTimer) clearTimeout(store.cleanupTimer);
  // store.cleanupTimer = setTimeout(() => {
  //   sessions.delete(store.gitbotId);
  // }, 60 * 60 * 1000);
}

export function emitEvent(store: SessionStore, type: string, data: Record<string, unknown>): void {
  const seq = ++store.seq;
  const event: StoredEvent = { seq, type, ...data };
  store.events.push(event);
  store.emitter.emit("event", event);
}


/**
 * Where the relay token lives for a workspace. `.grass-relay-token` is the
 * pre-rename name: keep honouring it when it is the only one present, so an
 * upgrade doesn't hand the relay a brand-new identity.
 */
export function relayTokenPath(cwd: string): string {
  const current = join(cwd, ".gitbot-relay-token");
  const legacy = join(cwd, ".grass-relay-token");
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

let _keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let _activeSessionCount = 0;

function _pingActivity(): void {
  const apiUrl = "https://api.codeongrass.com/v1";
  if (!apiUrl) return;
  let token: string;
  try {
    token = readFileSync(relayTokenPath(process.cwd()), "utf8").trim();
  } catch { return; }
  if (!token) return;
  fetch(`${apiUrl}/containers/activity`, {
    method: "POST",
    headers: { "x-relay-token": token },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

export function notifySessionStarted(): void {
  _activeSessionCount++;
  if (_keepAliveInterval === null) {
    _pingActivity();
    _keepAliveInterval = setInterval(_pingActivity, 2 * 60 * 1000);
  }
}

export function notifySessionEnded(): void {
  _activeSessionCount = Math.max(0, _activeSessionCount - 1);
  if (_activeSessionCount === 0 && _keepAliveInterval !== null) {
    clearInterval(_keepAliveInterval);
    _keepAliveInterval = null;
  }
}

// --- HTTP Server ---

export async function createHttpServer(opts: {
  portOverride?: number;
  caffeinate: boolean;
  network: string;
  label: string;
}): Promise<{ server: http.Server; PORT: number; caffeinatePid: number | null }> {
  const caffeinatePid = maybeCaffeinate(opts.caffeinate);
  console.log(`  workspace: ${process.cwd()}`);

  let PORT: number;
  if (opts.portOverride !== undefined) {
    PORT = opts.portOverride;
    console.log(`  port: ${PORT} (specified)`);
  } else {
    try {
      PORT = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
      console.log(`  port: ${PORT} (auto-selected from ${PORT_RANGE_START}–${PORT_RANGE_END})`);
    } catch {
      console.error(`\n  No available port found in range ${PORT_RANGE_START}–${PORT_RANGE_END}.`);
      console.error(`  Try stopping other gitbot sessions, or run with -p to specify a port.\n`);
      process.exit(1);
    }
  }

  const server = http.createServer();

  // Serve the SPA for GET /
  server.on("request", (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Function replacement: the vendor bundles contain `$&`-style sequences
      // that a string replacement would interpret.
      res.end(html.replace("<!--vendor-->", () => vendorScripts()));
    }
    // All other routes handled by server.ts listener
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  Port ${PORT} is not available.`);
      if (opts.portOverride !== undefined) {
        console.error(`  Please choose a different port with -p, or run without -p to auto-select one.\n`);
      } else {
        console.error(`  Try stopping other gitbot sessions, or run with -p to specify a port.\n`);
      }
      process.exit(1);
    }
    throw err;
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, async () => {
      await showQR(opts.network, PORT);
      resolve();
    });
  });

  return { server, PORT, caffeinatePid };
}

export function setupShutdown(cleanup: () => void, caffeinatePid: number | null): void {
  const shutdown = () => {
    console.log("\nShutting down...");
    killCaffeinate(caffeinatePid);
    cleanup();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => killCaffeinate(caffeinatePid));
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    killCaffeinate(caffeinatePid);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[gitbot] unhandledRejection — process kept alive:", reason);
  });
}

// --- SSE helper ---

export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  };
}

export function writeSseEvent(
  res: IResponse,
  event: StoredEvent
): void {
  if (res.writableEnded) return;
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// --- Route helpers ---

export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1))) {
    params[k] = v;
  }
  return params;
}

export function parsePathParam(url: string, prefix: string): string | null {
  const path = url.split("?")[0];
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length) || null;
}

export function jsonOk(res: IResponse, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(data);
}

/** `extra` rides alongside the message for errors the client acts on, not just shows. */
export function jsonError(
  res: IResponse,
  status: number,
  message: string,
  extra?: Record<string, unknown>
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message, ...extra }));
}

export function readBody(req: IRequest): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

// --- Workspace REST handlers ---

export async function handleWorkspaceRoutes(
  req: IRequest,
  res: IResponse,
  workspaceCwd: string,
  availableAgents: string[],
): Promise<boolean> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const path = url.split("?")[0];
  const query = parseQuery(url);

  if (method === "GET" && path === "/health") {
    _pingActivity();
    jsonOk(res, { status: "ok", cwd: workspaceCwd, serverVersion: SERVER_VERSION, clientVersionRange: CLIENT_VERSION_RANGE });
    return true;
  }

  if (method === "GET" && path === "/agents") {
    jsonOk(res, { agents: availableAgents });
    return true;
  }

  if (method === "GET" && path === "/repos") {
    const repos = await listRepos(workspaceCwd);
    jsonOk(res, { repos });
    return true;
  }

  if (method === "GET" && path === "/repos/details") {
    const repoPath = query.repoPath;
    if (!repoPath) { jsonError(res, 400, "repoPath is required"); return true; }
    try {
      const details = getRepoDetails(repoPath);
      jsonOk(res, details);
    } catch (err: any) {
      jsonError(res, 500, err?.message ?? "Failed to get repo details");
    }
    return true;
  }

  if (method === "POST" && path === "/repos/clone") {
    const body = await readBody(req);
    const { url: cloneUrl } = body;
    if (!cloneUrl) { jsonError(res, 400, "url is required"); return true; }
    try {
      const clonedPath = cloneRepo(cloneUrl, workspaceCwd);
      const { basename } = await import("path");
      jsonOk(res, { path: clonedPath, name: basename(clonedPath) });
    } catch (err: any) {
      jsonError(res, 500, err?.message ?? "Clone failed");
    }
    return true;
  }

  if (method === "POST" && path === "/folders") {
    const body = await readBody(req);
    const { name } = body;
    if (!name) { jsonError(res, 400, "name is required"); return true; }
    try {
      const createdPath = await createFolder(name, workspaceCwd);
      const { basename } = await import("path");
      jsonOk(res, { path: createdPath, name: basename(createdPath) });
    } catch (err: any) {
      jsonError(res, 500, err?.message ?? "Create failed");
    }
    return true;
  }

  // GET /browse?path= — subdirectories only, for the folder picker. Defaults to
  // the workspace, but roams the whole filesystem from there.
  if (method === "GET" && path === "/browse") {
    try {
      jsonOk(res, await browseDirs(query.path ?? workspaceCwd, workspaceCwd));
    } catch (err: any) {
      jsonError(res, 400, err?.message ?? "Failed to browse directory");
    }
    return true;
  }

  if (method === "GET" && path === "/dir") {
    const repoPath = query.repoPath;
    if (!repoPath) { jsonError(res, 400, "repoPath is required"); return true; }
    const targetPath = query.path ?? repoPath;
    try {
      const entries = await listDir(targetPath, repoPath);
      jsonOk(res, { entries });
    } catch (err: any) {
      jsonError(res, 400, err?.message ?? "Failed to list directory");
    }
    return true;
  }

  if (method === "GET" && path === "/file") {
    const repoPath = query.repoPath;
    const filePath = query.path;
    if (!repoPath) { jsonError(res, 400, "repoPath is required"); return true; }
    if (!filePath) { jsonError(res, 400, "path is required"); return true; }
    try {
      const { content, size } = await readFile(filePath, repoPath);
      jsonOk(res, { content, size });
    } catch (err: any) {
      jsonError(res, 400, err?.message ?? "Failed to read file");
    }
    return true;
  }

  if (method === "GET" && path === "/diffs") {
    const repoPath = query.repoPath ?? workspaceCwd;
    let diff = "";
    try {
      diff = execSync("git diff HEAD", { cwd: repoPath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    } catch {
      diff = "";
    }

    // Append untracked (never-committed) files as synthetic diffs
    try {
      const { readFileSync, statSync } = await import("fs");
      const { join } = await import("path");
      const untrackedRaw = execSync("git ls-files --others --exclude-standard", {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();
      for (const file of untrackedRaw.split("\n").filter(Boolean)) {
        try {
          const fullPath = join(repoPath, file);
          if (statSync(fullPath).size > 1024 * 1024) continue; // skip files > 1 MB
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          const hunkLines = lines.map((l) => `+${l}`).join("\n");
          diff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${hunkLines}\n`;
        } catch {
          // binary or unreadable — skip
        }
      }
    } catch {
      // git ls-files unavailable — skip untracked
    }

    jsonOk(res, { diff });
    return true;
  }

  return false;
}
