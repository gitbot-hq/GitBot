import { spawn, execSync, type ChildProcess } from "child_process";
import { createRequire } from "module";
import { StringDecoder } from "string_decoder";
import { join, dirname } from "path";
import { existsSync } from "fs";
import {
  emitEvent,
  scheduleCleanup,
  notifyPermissionsChanged,
  shouldAutoApprove,
  type SessionStore,
} from "./server-common";
import { bindSession, updateThread } from "./bot-store";
import { presetSystemPrompt, recordSetupOutcomeFromEvents } from "./bot-prompt";

const PKG_VERSION: string = require("../package.json").version;

/** `codex app-server` is opt-in until CDX-7 retires the SDK path. */
export function appServerEnabled(): boolean {
  return process.env.GITBOT_CODEX_APP_SERVER === "1";
}

// --- Binary resolution (CDX-2 replaces this with the real thing) ---

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function targetTriple(): string | null {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "linux-x64":
    case "android-x64": return "x86_64-unknown-linux-musl";
    case "linux-arm64":
    case "android-arm64": return "aarch64-unknown-linux-musl";
    case "darwin-x64": return "x86_64-apple-darwin";
    case "darwin-arm64": return "aarch64-apple-darwin";
    case "win32-x64": return "x86_64-pc-windows-msvc";
    case "win32-arm64": return "aarch64-pc-windows-msvc";
    default: return null;
  }
}

/** Absolute path of the `codex` on PATH, or null when there is none. */
function codexOnPath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where codex" : "command -v codex";
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    return out.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * The binary bundled with `@openai/codex-sdk` is the one this repo pins, so it
 * is the one whose app-server protocol we have verified. Fall back to the user's
 * own install when the optional dependency was skipped — the same trade the SDK
 * path makes in `createCodex()`, warning included, since the versions can differ.
 */
export function resolveCodexBinary(): string {
  const triple = targetTriple();
  const platformPackage = triple ? PLATFORM_PACKAGE_BY_TARGET[triple] : undefined;
  if (triple && platformPackage) {
    try {
      const codexPackageJson = require.resolve("@openai/codex/package.json");
      const codexRequire = createRequire(codexPackageJson);
      const platformPackageJson = codexRequire.resolve(`${platformPackage}/package.json`);
      const vendorRoot = join(dirname(platformPackageJson), "vendor", triple);
      const name = process.platform === "win32" ? "codex.exe" : "codex";
      for (const candidate of [join(vendorRoot, "bin", name), join(vendorRoot, "codex", name)]) {
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // fall through to PATH
    }
  }
  const onPath = codexOnPath();
  if (onPath) {
    console.warn(`[codex] bundled binary unavailable; using ${onPath} — its version may differ from the SDK's`);
    return onPath;
  }
  throw new Error("codex binary not found (no bundled build and none on PATH)");
}

// --- JSON-RPC client ---

/** `RequestId` is `string | number` on the wire; the maps key on `String(id)`. */
type JsonRpcId = number | string;

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * No request this client sends is long-running — `turn/start` returns as soon as
 * the turn is queued, and completion arrives as a notification. Without a
 * deadline, a server that never answers (a param it rejects silently, an id
 * type it echoes back differently) hangs `start()` for the life of the process.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Ceiling on a single un-terminated line. The protocol really does carry 200KB+
 * messages, so this is generous, but a server that emits no newline at all must
 * not be able to grow the buffer until the hub dies.
 */
const MAX_PENDING_LINE_CHARS = 16 * 1024 * 1024;

/** Windows has no process groups and `detached` there opens a console instead. */
const OWN_PROCESS_GROUP = process.platform !== "win32";

/**
 * Every app-server child this process has spawned and not yet reaped, so
 * shutdown can take the whole tree down (see `reapCodexAppServers`).
 */
const liveChildren = new Set<ChildProcess>();

/** One process the child tree owns: its pid and the group it leads or joined. */
interface TreeProc {
  pid: number;
  pgid: number;
}

/**
 * Snapshot of everything descended from `rootPid`, taken *before* anything is
 * signalled — the moment codex dies its children reparent to init and the
 * parentage that identifies them is gone.
 *
 * Measured on 0.155.1: codex gives every command it runs its *own* process
 * group, so signalling app-server's group reaches app-server and nothing else.
 * The descendants have to be found by walking ppid.
 */
function snapshotTree(rootPid: number): TreeProc[] {
  if (!OWN_PROCESS_GROUP) return [];
  let out: string;
  try {
    out = execSync("ps -Ao pid=,ppid=,pgid=", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  } catch {
    return [];
  }

  const byParent = new Map<number, TreeProc[]>();
  let ownPgid = -1;
  for (const line of out.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(pgid)) continue;
    if (pid === process.pid) ownPgid = pgid;
    const siblings = byParent.get(ppid);
    if (siblings) siblings.push({ pid, pgid });
    else byParent.set(ppid, [{ pid, pgid }]);
  }

  const found: TreeProc[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    for (const kid of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(kid.pid)) continue;
      seen.add(kid.pid);
      // Never signal ourselves, whatever ps says the tree looks like.
      if (kid.pid === process.pid || kid.pgid === ownPgid) continue;
      found.push(kid);
      queue.push(kid.pid);
    }
  }
  return found;
}

/**
 * The entries of `tree` that `ps` still reports with the same process group.
 * A snapshot goes stale the moment anything in it exits, and pids are recycled:
 * signalling a stale entry means signalling whoever inherited its pid.
 *
 * An unreadable `ps` returns nothing rather than everything — refusing to kill
 * leaves a stray process, killing blind takes out a stranger.
 */
function verifyTree(tree: TreeProc[]): TreeProc[] {
  if (tree.length === 0) return [];
  let out: string;
  try {
    out = execSync("ps -Ao pid=,pgid=", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  } catch {
    return [];
  }
  const pgidByPid = new Map<number, number>();
  for (const line of out.split("\n")) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(pgid)) pgidByPid.set(pid, pgid);
  }
  // Both halves must match: a recycled pid almost never lands in the same group.
  return tree.filter((proc) => pgidByPid.get(proc.pid) === proc.pgid);
}

/**
 * Signals codex and everything it started. Every approved command — `npm
 * install`, a dev server, a `sleep` — is a grandchild, and app-server makes
 * unsandboxed commands the normal case: killing only codex leaves them
 * reparented to init and running forever.
 *
 * Each descendant is signalled by group as well as by pid, because a command
 * leads a group of its own children.
 */
function killTree(child: ChildProcess, tree: TreeProc[], signal: NodeJS.Signals): void {
  for (const proc of tree) {
    // `process.kill(-0, sig)` signals the *caller's* process group, which is
    // the hub itself. pgid 1 is init's. Neither is ours to kill.
    if (!(proc.pgid > 1)) continue;
    try { process.kill(-proc.pgid, signal); } catch { /* group already gone */ }
    try { process.kill(proc.pid, signal); } catch { /* already gone */ }
  }
  const pid = child.pid;
  // Node holds the pid reserved until it reports the exit, so while
  // `exitCode`/`signalCode` are unset this pid is still ours and cannot have
  // been recycled under us. Once they are set, the group may belong to someone
  // else; `child.kill()` below is a no-op then and is safe either way.
  if (pid !== undefined && OWN_PROCESS_GROUP && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-pid, signal); } catch { /* no group, or already gone */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * Terminates every codex app-server GitBot started, and everything they
 * started. Called from shutdown: `detached` children do not get the terminal's
 * Ctrl-C, so nothing else would take them down.
 */
export function reapCodexAppServers(): void {
  for (const child of [...liveChildren]) {
    liveChildren.delete(child);
    if (child.pid === undefined) continue;
    killTree(child, snapshotTree(child.pid), "SIGTERM");
  }
}

/**
 * Returns the result to answer a ServerRequest with, or `undefined` to let the
 * client fall back to its own refusal. Resolve it whenever you like: the read
 * loop does not wait on it.
 */
export type ServerRequestHandler = (
  method: string,
  params: any,
  id: JsonRpcId,
) => unknown | Promise<unknown>;

export interface CodexAppServerOptions {
  cwd: string;
  onNotification: (method: string, params: any) => void;
  onServerRequest?: ServerRequestHandler;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Overrides binary resolution. Used to drive the client against a stub server. */
  binary?: string;
}

/**
 * A ServerRequest we do not service still has to be answered or the turn waits
 * on it forever. Where the protocol has a "no" that type-checks, say no in its
 * own words; everything else gets a JSON-RPC error, which app-server treats as a
 * refusal (that is how `codex exec` itself declines approvals).
 */
function refusalResult(method: string): unknown | undefined {
  switch (method) {
    // v2 approvals. Proper handling of file changes is CDX-4.
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/tool/call":
      return { contentItems: [{ type: "inputText", text: "GitBot does not service dynamic tool calls." }], success: false };
    // Cheap and answerable truthfully.
    case "currentTime/read":
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    // Legacy v1 approvals speak ReviewDecision, not the v2 decision enum.
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: "GitBot declined this request." } } };
    default:
      // Includes item/permissions/requestApproval (no refusal shape exists),
      // attestation/generate and account/chatgptAuthTokens/refresh.
      return undefined;
  }
}

export class CodexAppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  /** Set after discarding an over-long line: skip through the next newline. */
  private resyncing = false;
  private stderrTail: string[] = [];
  private exited = false;
  private exitReason: string | null = null;

  constructor(private opts: CodexAppServerOptions) {}

  /** Spawns the child and completes the handshake. */
  async start(): Promise<void> {
    const binary = this.opts.binary ?? resolveCodexBinary();
    const child = spawn(binary, ["app-server"], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // Its own process group, so `dispose()` can signal the commands codex
      // spawned as well as codex itself. See `killProcessGroup`.
      detached: OWN_PROCESS_GROUP,
    });
    this.child = child;
    liveChildren.add(child);

    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    // A last line with no trailing newline is still a message.
    child.stdout?.on("end", () => this.flushStdout());
    child.stdout?.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });

    child.on("error", (err) => {
      liveChildren.delete(child);
      this.die(`codex app-server failed to start: ${err.message}`, null, null);
    });
    // `close`, not `exit`: `exit` can fire while stdio is still draining, and
    // reporting the exit sets `turnClosed`, which would discard a `turn/completed`
    // still in the pipe and turn a clean run into "exited unexpectedly".
    child.on("close", (code, signal) => {
      liveChildren.delete(child);
      const detail = this.stderrTail.join("").trim();
      this.die(
        `codex app-server exited (code=${code} signal=${signal})${detail ? `\n\n${detail}` : ""}`,
        code,
        signal,
      );
    });

    await this.request("initialize", {
      clientInfo: { name: "gitbot", title: "GitBot", version: PKG_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  /** Settles every outstanding request and reports the exit once. */
  private die(message: string, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitReason = message;
    const err = new Error(message);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.opts.onExit?.(code, signal);
  }

  get lastError(): string | null {
    return this.exitReason;
  }

  /** False once there is nowhere left to write an answer to. */
  get isRunning(): boolean {
    const stdin = this.child?.stdin;
    return !this.exited && !!stdin && !stdin.destroyed && stdin.writable;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    liveChildren.delete(child);

    // Detach the reader before signalling. Between SIGTERM and SIGKILL codex
    // keeps writing, and anything dispatched from that window lands on a turn
    // that is already over — a ServerRequest there would raise an approval card
    // nothing can ever clear.
    child.stdout?.removeAllListeners("data");
    child.stdout?.removeAllListeners("end");
    child.stdout?.destroy();
    child.stderr?.removeAllListeners("data");
    child.stderr?.destroy();
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }

    if (child.exitCode !== null || child.signalCode !== null) return;
    // Snapshot first: after SIGTERM the tree has already come apart.
    const tree = child.pid === undefined ? [] : snapshotTree(child.pid);
    killTree(child, tree, "SIGTERM");
    // A wedged child — or a command it spawned — must not outlive the turn.
    // Given the chance codex tidies up its own commands on SIGTERM; this is for
    // when it is not given the chance. Two seconds is long enough for a pid in
    // the snapshot to have died and been handed to something else, so the tree
    // is re-checked rather than reused.
    const timer = setTimeout(() => killTree(child, verifyTree(tree), "SIGKILL"), 2000);
    timer.unref?.();
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.exited) return Promise.reject(new Error(this.exitReason ?? "codex app-server is not running"));
    const id = this.nextId++;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(key)) return;
        reject(new Error(`${method} got no response from codex app-server within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(key, { method, resolve, reject, timer });
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(key);
        clearTimeout(timer);
        reject(new Error(`failed to send ${method} to codex app-server`));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(JSON.stringify(msg) + "\n");
      return true;
    } catch (err: any) {
      console.error(`[codex-app-server] write failed: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Line framing. StringDecoder holds back the tail of a multi-byte character
   * split across chunks, so a UTF-8 payload never decodes into replacement
   * characters mid-message.
   */
  private onStdout(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (this.resyncing) this.resyncing = false;
      else if (trimmed) this.onLine(trimmed);
      nl = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_PENDING_LINE_CHARS) {
      console.error(`[codex-app-server] discarding ${this.buffer.length} buffered chars with no newline in sight`);
      this.buffer = "";
      // Whatever follows is the tail of a message we already threw away.
      this.resyncing = true;
    }
  }

  /** Drains whatever stdout left behind when it ended without a newline. */
  private flushStdout(): void {
    this.buffer += this.decoder.end();
    const trailing = this.buffer.trim();
    this.buffer = "";
    if (this.resyncing) {
      this.resyncing = false;
      return;
    }
    if (trailing) this.onLine(trailing);
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // app-server also prints the odd human-readable line; it is not fatal.
      console.error(`[codex-app-server] non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // Responses from this server omit `jsonrpc`, so classify on shape alone.
    const hasMethod = typeof msg.method === "string";
    const hasId = msg.id !== undefined && msg.id !== null;

    if (hasMethod && hasId) {
      this.dispatchServerRequest(msg.id as JsonRpcId, msg.method as string, msg.params);
      return;
    }
    if (hasMethod) {
      try {
        this.opts.onNotification(msg.method as string, msg.params);
      } catch (err: any) {
        console.error(`[codex-app-server] notification handler threw on ${msg.method}: ${err?.message ?? err}`);
      }
      return;
    }
    if (hasId) {
      // `RequestId` is `string | number` and nothing promises the server echoes
      // back the type it was sent, so both sides key on the string form.
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (!p) {
        console.error(`[codex-app-server] response for unknown id ${msg.id}`);
        return;
      }
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`${p.method} failed: ${msg.error?.message ?? JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    console.error(`[codex-app-server] unclassifiable message: ${line.slice(0, 200)}`);
  }

  /**
   * Every inbound ServerRequest leaves here answered exactly once, whatever the
   * handler does — unknown method, malformed params, throw, never resolving
   * because the turn was aborted. Nothing here awaits, so the read loop keeps
   * draining while a human thinks about an approval.
   */
  private dispatchServerRequest(id: JsonRpcId, method: string, params: any): void {
    let settled = false;

    const answer = (result: unknown): void => {
      if (settled) return;
      settled = true;
      this.write({ jsonrpc: "2.0", id, result });
    };

    const refuse = (reason: string): void => {
      if (settled) return;
      settled = true;
      const fallback = refusalResult(method);
      console.log(`[codex-app-server] default-answering ${method} (id=${id}): ${reason}`);
      if (fallback === undefined) {
        this.write({
          jsonrpc: "2.0",
          id,
          // -32000 is the server-defined range. Not -32601 ("method not found"):
          // we understood the request and refused it, which is a different thing
          // and is the code `codex exec` itself answers approvals with.
          error: { code: -32000, message: `gitbot does not handle ${method}: ${reason}` },
        });
      } else {
        this.write({ jsonrpc: "2.0", id, result: fallback });
      }
    };

    const handler = this.opts.onServerRequest;
    if (!handler) {
      refuse("no handler installed");
      return;
    }

    let outcome: unknown;
    try {
      outcome = handler(method, params, id);
    } catch (err: any) {
      refuse(`handler threw: ${err?.message ?? err}`);
      return;
    }
    if (outcome === undefined) {
      refuse("unhandled method");
      return;
    }
    Promise.resolve(outcome).then(
      (result) => {
        if (result === undefined) refuse("handler returned nothing");
        else answer(result);
      },
      (err: any) => refuse(`handler rejected: ${err?.message ?? err}`),
    );
  }
}

// --- Adapter: one codex turn over app-server ---

/**
 * Answers every card still on screen as a denial. Clearing the map alone would
 * leave the approval promises — and so the JSON-RPC responses they write —
 * dangling forever.
 */
function denyAllPending(store: SessionStore): void {
  if (store.pendingPermissions.size === 0) return;
  for (const [key, perm] of store.pendingPermissions) {
    store.pendingPermissions.delete(key);
    try { perm.resolve(false); } catch { /* handler already gone */ }
  }
  notifyPermissionsChanged();
}

/**
 * The client servicing each running session, so a late answer from the browser
 * can tell whether there is still anything to answer to. Entries live exactly
 * as long as the turn.
 */
const activeClients = new Map<SessionStore, CodexAppServerClient>();

/**
 * How long abort waits between `turn/interrupt` and killing the child. Without
 * it SIGTERM lands microseconds after the interrupt and codex never gets to act
 * on it — the commands it started would be killed rather than wound down.
 */
const ABORT_GRACE_MS = 300;

/**
 * The only policy that actually gates every tool. Under `on-request` it is the
 * *model* that decides whether to ask at all — `echo hello` runs with no prompt
 * and only a self-declared escalation reaches the user, which is not an approval
 * step. `untrusted` asks before every command execution and every file edit,
 * independent of the sandbox.
 *
 * TRAP: `untrusted` is rejected when it arrives as configuration — `config.toml`
 * or a `-c approval_policy=untrusted` flag makes app-server refuse the config and
 * never answer `initialize`, so the turn hangs on the handshake. It is fully
 * supported as a `thread/start` / `thread/resume` / `turn/start` /
 * `thread/settings/update` *param*. Keep it here, in params, only.
 *
 * Mapping the hub's permission modes onto policy/sandbox/reviewer is CDX-5; this
 * constant only makes the tracer bullet's per-tool approval honest.
 */
const APPROVAL_POLICY = "untrusted";

type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/**
 * The sandbox a session runs in. Mirrors the SDK path's mapping; policy work
 * proper is CDX-5. Plan mode is read-only whatever the permission mode says —
 * `botPermissionToSession("plan")` hands it `permissionMode: "yolo"`, so the
 * mode alone is not the truth about what this session may do.
 */
function sandboxFor(store: SessionStore): CodexSandbox {
  if (store.mode === "plan") return "read-only";
  switch (store.permissionMode) {
    case "yolo": return "danger-full-access";
    case "allow-all-edits": return "workspace-write";
    case "ask-permissions":
    default: return "read-only";
  }
}

/**
 * Whether an approval may be answered without a human.
 *
 * The sandbox decides, not `permissionMode` on its own. Under `untrusted` an
 * approval request is exactly where codex asks to act *outside* its sandbox —
 * `additionalPermissions: {network, fileSystem}` and `grantRoot` are on those
 * params for that purpose — so auto-accepting one in a read-only session is
 * auto-granting the escape. Plan mode reaches here as `permissionMode: "yolo"`
 * with a read-only sandbox, and its UI promises "Explore without making edits";
 * `shouldAutoApprove()` read in isolation says yes to everything and breaks
 * that promise.
 *
 * Read-only is also what `ask-permissions` runs in, where `shouldAutoApprove()`
 * already refuses everything, so this only ever tightens plan mode.
 */
export function codexAutoApprove(store: SessionStore, toolName: string): boolean {
  if (sandboxFor(store) === "read-only") return false;
  return shouldAutoApprove(store.agent, toolName, store.permissionMode);
}

export async function runAppServerTurn(store: SessionStore): Promise<void> {
  // Nothing from a previous turn may still be on screen: `buildPermissionsDump()`
  // walks every session, so one stale card poisons the hub-wide approvals tray
  // and pins this session at `awaiting_permissions` forever.
  denyAllPending(store);

  const lastUserEvent = [...store.events].reverse().find((e) => e.type === "user_prompt");
  const promptText = (lastUserEvent?.prompt as string) ?? "";
  const attachments = (lastUserEvent?.attachments as Array<{ url: string }> | undefined) ?? [];

  if (!promptText) {
    emitEvent(store, "error", { message: "prompt is required" });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  }
  if (attachments.length > 0) {
    emitEvent(store, "agent_error", {
      message: "Image attachments are not supported on the experimental codex app-server path; the text prompt was sent on its own.",
    });
  }

  const unenforceableTools = [
    ...(store.botPreset?.allowedTools ?? []),
    ...(store.botPreset?.disallowedTools ?? []),
  ];
  if (unenforceableTools.length > 0) {
    emitEvent(store, "agent_error", {
      message: `Tool limits are not enforced on Codex. ${store.botPreset?.name ?? "This bot"} runs with every tool its sandbox allows.`,
    });
  }

  const sandbox = sandboxFor(store);

  const abortController = new AbortController();
  store.abortController = abortController;

  let turnId: string | null = null;
  let settleTurn: (() => void) | null = null;
  // Set the moment the turn is reported over. The child keeps streaming until
  // it is actually reaped, and those late items must not land after `done`.
  let turnClosed = false;
  const turnDone = new Promise<void>((resolve) => { settleTurn = resolve; });
  const finishTurn = () => { turnClosed = true; settleTurn?.(); settleTurn = null; };

  let receivedCompletion = false;
  let client: CodexAppServerClient | null = null;

  const bindThread = (threadId: string) => {
    if (!threadId || store.sdkSessionId === threadId) return;
    // `thread/resume` can hand back a different id than the one it was asked
    // for, so rebind whenever it changes, not only the first time. `bindSession`
    // refuses to overwrite an existing mapping, hence the explicit update.
    if (store.threadId) {
      if (store.sdkSessionId) updateThread(store.threadId, { sdkSessionId: threadId });
      else bindSession(store.threadId, threadId);
    }
    store.sdkSessionId = threadId;
    emitEvent(store, "system", { subtype: "init", session_id: threadId });
  };

  try {
    client = new CodexAppServerClient({
      cwd: store.repoPath,
      onNotification: (method, params) => {
        if (turnClosed) {
          console.log(`[codex-app-server] dropping ${method} after the turn closed`);
          return;
        }
        handleNotification(store, method, params, bindThread, () => {
          receivedCompletion = true;
          finishTurn();
        });
      },
      onServerRequest: (method, params, id) => {
        // The request path needs the same guard as notifications, and for a
        // worse reason: a ServerRequest accepted after the turn closed would
        // store a permission nothing ever removes — `denyAllPending()` has
        // already run, and `serverRequest/resolved`, the only retraction, is
        // dropped by the guard above. Returning `undefined` hands it to the
        // client's own `refuse()`, so the server still gets a proper answer.
        if (turnClosed) {
          console.log(`[codex-app-server] refusing ${method} after the turn closed`);
          return undefined;
        }
        return handleServerRequest(store, method, params, id);
      },
      onExit: () => {
        // `dispose()` detaches the reader but leaves `close` attached, and the
        // child is only SIGKILLed two seconds after SIGTERM — so this fires long
        // after the turn ended. It closes over `store`, not the turn, and
        // `denyAllPending` clears whatever is on screen *now*: a client left
        // over from the previous turn would deny the new turn's cards.
        if (turnClosed) return;
        // Pending cards can never be answered once the child is gone.
        denyAllPending(store);
        finishTurn();
      },
    });
    activeClients.set(store, client);

    const activeClient = client;
    const onAbort = () => {
      console.log("[codex-app-server] aborting turn");
      // Settle the cards first: once `turn/interrupt` is in flight the child is
      // moments from SIGTERM, and an approval promise left outstanding keeps a
      // card on screen that nothing will ever answer.
      denyAllPending(store);
      if (turnId && store.sdkSessionId) {
        activeClient.request("turn/interrupt", { threadId: store.sdkSessionId, turnId }).catch(() => {});
      }
      emitEvent(store, "aborted", { message: "Request aborted by user" });
      store.status = "done";
      receivedCompletion = true;
      // The turn is over now. Waiting for the grace timer to say so leaves a
      // window in which a ServerRequest still raises a card — on a turn the
      // user has stopped, into the hub-wide approvals tray, with nothing left
      // to answer it.
      turnClosed = true;
      // Settling is what unblocks the `finally` that disposes the child, so
      // give codex a beat to act on the interrupt before it is killed.
      // Not unref'd: the turn cannot finish until this fires.
      setTimeout(finishTurn, ABORT_GRACE_MS);
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    await client.start();

    const developerInstructions = presetSystemPrompt(store.botPreset);
    console.log(`[codex-app-server] starting turn (resume=${!!store.sdkSessionId}) sandbox=${sandbox}`);

    // Aborting during the handshake already reported the turn; starting a
    // thread now would emit events after the client stopped listening.
    let threadIdForTurn: string | null = null;
    if (abortController.signal.aborted) {
      // nothing to start
    } else if (store.sdkSessionId) {
      const resumed = await client.request("thread/resume", {
        threadId: store.sdkSessionId,
        cwd: store.repoPath,
        excludeTurns: true,
        sandbox,
        approvalPolicy: APPROVAL_POLICY,
        // The default routes approvals to an LLM subagent, not to the user.
        approvalsReviewer: "user",
        ...(store.model ? { model: store.model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      });
      threadIdForTurn = resumed?.thread?.id ?? store.sdkSessionId;
    } else {
      const started = await client.request("thread/start", {
        cwd: store.repoPath,
        sandbox,
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: "user",
        ...(store.model ? { model: store.model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      });
      threadIdForTurn = started?.thread?.id ?? null;
      if (!threadIdForTurn) throw new Error("codex app-server returned no thread id");
    }
    if (threadIdForTurn) bindThread(threadIdForTurn);

    if (threadIdForTurn && !abortController.signal.aborted) {
      const turn = await client.request("turn/start", {
        threadId: threadIdForTurn,
        input: [{ type: "text", text: promptText, text_elements: [] }],
      });
      turnId = turn?.turn?.id ?? null;
      await turnDone;
    }
  } catch (err: any) {
    if (!abortController.signal.aborted) {
      console.log("[codex-app-server] outer error:", err?.message);
      emitEvent(store, "error", { message: err?.message ?? "Unknown error" });
      store.status = "error";
    }
  } finally {
    activeClients.delete(store);
    denyAllPending(store);
    client?.dispose();
    store.abortController = null;
    store.pendingPermissions.clear();
    notifyPermissionsChanged();
  }

  if (store.status === "error") {
    scheduleCleanup(store);
    return;
  }

  if (!receivedCompletion) {
    console.log("[codex-app-server] stream ended without turn completion — treating as error");
    emitEvent(store, "error", { message: client?.lastError ?? "Codex process exited unexpectedly" });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  }

  recordSetupOutcomeFromEvents(store);
  store.status = "done";
  notifyPermissionsChanged();
  emitEvent(store, "done", {});
  scheduleCleanup(store);
}

function handleNotification(
  store: SessionStore,
  method: string,
  params: any,
  bindThread: (threadId: string) => void,
  onTurnEnded: () => void,
): void {
  switch (method) {
    case "thread/started": {
      const id = params?.thread?.id;
      if (typeof id === "string") bindThread(id);
      return;
    }
    case "turn/started":
      return;
    case "turn/completed": {
      // `TurnStatus` is completed | interrupted | failed | inProgress. Only
      // `completed` is a success; reporting an interrupted turn as one would
      // claim work happened that codex abandoned.
      const status = params?.turn?.status;
      if (status === "failed") {
        emitEvent(store, "error", { message: params?.turn?.error?.message ?? "Codex turn failed" });
        store.status = "error";
      } else if (status === "interrupted") {
        // When the user pressed Stop we already said so and set the status;
        // a still-running session means the server cut the turn short itself.
        if (store.status === "running") {
          emitEvent(store, "aborted", { message: "Codex stopped this turn before it finished" });
          store.status = "done";
        }
      } else {
        emitEvent(store, "result", { subtype: "success" });
      }
      onTurnEnded();
      return;
    }
    case "error": {
      // `ErrorNotification` carries `willRetry`. codex reports retries and
      // transport fallbacks here and then carries on, so a retryable error must
      // not end the turn — but one it will not retry is the end of the turn, and
      // treating it as noise leaves the session waiting on a child that is done.
      const message = params?.error?.message ?? "Codex reported an error";
      console.log(`[codex-app-server] ${message} (willRetry=${params?.willRetry})`);
      if (params?.willRetry === false) {
        emitEvent(store, "error", { message });
        store.status = "error";
        onTurnEnded();
      } else {
        emitEvent(store, "agent_error", { message });
      }
      return;
    }
    case "serverRequest/resolved": {
      // The server settled a request itself (cancelled, timed out, superseded).
      // Drop the card and settle its promise: clearing the map alone strands the
      // dispatch promise and its closure forever. The client's `settled` flag
      // makes the resulting write a no-op, so this cannot double-answer.
      const key = String(params?.requestId);
      const perm = store.pendingPermissions.get(key);
      if (!perm) return;
      store.pendingPermissions.delete(key);
      try { perm.resolve(false); } catch { /* handler already gone */ }
      notifyPermissionsChanged();
      return;
    }
    case "item/started":
    case "item/completed":
      handleItem(store, method, params?.item);
      return;
    default:
      // CDX-3 maps the rest.
      console.log(`[codex-app-server] ignoring notification ${method}`);
      return;
  }
}

function handleItem(store: SessionStore, method: string, item: any): void {
  if (!item || typeof item.type !== "string") return;
  switch (item.type) {
    case "agentMessage":
      if (method === "item/completed") emitEvent(store, "assistant", { content: item.text ?? "" });
      return;
    case "reasoning":
      if (method === "item/started") emitEvent(store, "status", { status: "thinking" });
      return;
    case "commandExecution":
      if (method === "item/started") {
        emitEvent(store, "tool_use", {
          tool_name: "Bash",
          tool_input: item.command ?? "",
          tool_use_id: item.id,
        });
      } else {
        emitEvent(store, "tool_result", {
          tool_use_id: item.id,
          tool_name: "Bash",
          output: item.aggregatedOutput ?? "",
          exit_code: item.exitCode ?? null,
          status: item.status ?? "completed",
        });
      }
      return;
    case "fileChange":
      // Same events the SDK path emits (`start-codex.ts` handleItem): one
      // tool_use per file, `Write` for a new file and `Edit` for the rest.
      // Without it an auto-approved edit changes a file and the transcript says
      // nothing happened.
      if (method === "item/completed") {
        for (const change of item.changes ?? []) {
          // v2 spells the kind as a tagged object; the SDK's ThreadItem had a
          // bare string. Read either.
          const kind = typeof change?.kind === "string" ? change.kind : change?.kind?.type;
          emitEvent(store, "tool_use", {
            tool_name: kind === "add" ? "Write" : "Edit",
            tool_input: change?.path ?? "",
            tool_use_id: item.id,
          });
        }
      }
      return;
    default:
      console.log(`[codex-app-server] ignoring ${method} for item type ${item.type}`);
      return;
  }
}

/**
 * Returns the JSON-RPC result, or `undefined` to let the client refuse. Command
 * approvals return a promise that settles when the browser answers — the read
 * loop is not waiting on it.
 */
function handleServerRequest(
  store: SessionStore,
  method: string,
  params: any,
  id: JsonRpcId,
): unknown | Promise<unknown> | undefined {
  if (method === "item/fileChange/requestApproval") {
    // `untrusted` gates edits as well as commands, so this request — which
    // `on-request` left almost entirely to the model — now arrives on every
    // edit. `FileChangeRequestApprovalParams` carries no paths and no diff, so
    // there is nothing here to inspect except `grantRoot`.
    //
    // `grantRoot` is not an edit. It asks to write under a root "for the
    // remainder of the session" — a standing escalation out of the workspace,
    // which `allow-all-edits` never granted and which every codex bot would get
    // by default (`botPermissionToSession` puts them all in that mode). Decline
    // it and leave a line in the log: CDX-4 turns it into a card.
    if (params?.grantRoot != null) {
      console.log(`[codex-app-server] declining item/fileChange/requestApproval (id=${id}): asks for session-wide write access under ${JSON.stringify(params.grantRoot)}${params?.reason ? ` — ${params.reason}` : ""}`);
      return { decision: "decline" };
    }
    // An ordinary edit. Honour the mode that already says edits need no asking
    // (CDX-5's table: "auto-accept fileChange when grantRoot == null"), or a
    // bot in `allow-all-edits` could not edit at all. `codexAutoApprove` is what
    // keeps plan mode — nominally `yolo` — from accepting here. The edit itself
    // is reported by the `fileChange` item, so an accepted one is not silent.
    const autoApprove = codexAutoApprove(store, "Edit");
    console.log(`[codex-app-server] fileChange approval id=${id} mode="${store.permissionMode}"${store.mode === "plan" ? " (plan)" : ""} autoApprove=${autoApprove}`);
    return autoApprove ? { decision: "accept" } : undefined;
  }

  if (method !== "item/commandExecution/requestApproval") return undefined;

  // `CommandExecutionApprovalKind` is "command" | "writeStdin"; older servers
  // omit it and mean "command". `writeStdin` is not a command to run, it is text
  // injected into a terminal that is already running, and `command` is null for
  // it — a card that says `{"command":""}` asks the user to allow a blank thing.
  const kind = params?.kind === "writeStdin" ? "writeStdin" : "command";
  const rawCommand = typeof params?.command === "string" ? params.command : "";
  // `toolName` is the card's headline ("Allow <toolName>?"), so the two kinds
  // must not share one. Neither is an edit tool, so `shouldAutoApprove` treats
  // them identically.
  const toolName = kind === "writeStdin" ? "Terminal input" : "Bash";

  // Everything the request carries that bears on the decision. This card is the
  // one place a human is the security boundary, so a request for network access
  // must not render as a bare command string.
  const input: Record<string, unknown> = {
    command: rawCommand || (kind === "writeStdin"
      ? "(codex did not say what it wants to send)"
      : "(codex did not say which command it wants to run)"),
    cwd: params?.cwd ?? store.repoPath,
    kind,
  };
  if (kind === "writeStdin") {
    input.action = "Send this input to a command already running in the terminal";
  }
  if (typeof params?.reason === "string" && params.reason.trim()) input.reason = params.reason;
  // { host, protocol } — the managed-network prompt's whole justification.
  if (params?.networkApprovalContext) input.networkAccess = params.networkApprovalContext;
  // { network, fileSystem } — sandbox escapes this command is asking for.
  if (params?.additionalPermissions) input.additionalPermissions = params.additionalPermissions;

  // `availableDecisions` is deliberately not surfaced. Besides accept/decline it
  // offers `acceptWithExecpolicyAmendment`, which permanently appends an `allow`
  // rule to the user's ~/.codex/rules/default.rules — a global change affecting
  // their own terminal, far beyond "allow this once".

  // One itemId can raise several approvals, so the JSON-RPC id is the only
  // identifier that is unique per request. Note codex numbers ids from 0, so the
  // first toolUseID is the string "0": truthy as a string, which is what
  // `server.ts`'s `if (!toolUseID)` and `chat.tsx`'s `if (!d.toolUseID)` need.
  // Passing the id through as a number would make both reject the first card.
  const toolUseID = String(id);

  const autoApprove = codexAutoApprove(store, toolName);
  console.log(`[codex-app-server] approval id=${toolUseID} tool="${toolName}" mode="${store.permissionMode}"${store.mode === "plan" ? " (plan)" : ""} autoApprove=${autoApprove}`);
  if (autoApprove) return { decision: "accept" };

  // A denial is always "decline", even though 0.155.1 omits it from
  // `availableDecisions` (that list is a hint for which buttons to draw, not a
  // whitelist — "decline" is accepted regardless). "cancel" is not a synonym:
  // measured on 0.155.1, it ends the turn as `interrupted` and the agent never
  // gets to say it was refused, where "decline" completes the turn normally.
  return new Promise<unknown>((resolve) => {
    store.pendingPermissions.set(toolUseID, {
      resolve: (approved: unknown) => resolve({ decision: approved === true ? "accept" : "decline" }),
      input,
      toolName,
      toolUseID,
    });
    notifyPermissionsChanged();
    emitEvent(store, "permission_request", { toolUseID, toolName, input });
  });
}

/**
 * Answers a pending codex approval from `POST /sessions/:id/permission`. False
 * means the answer went nowhere — the card is unknown, or the child that asked
 * is gone. The route must not report success then: the stored resolve writes a
 * JSON-RPC response, and with no child the write is a silent no-op while the UI
 * happily renders "Allowed Bash" over a command that never ran.
 */
export function respondPermission(store: SessionStore, toolUseID: string, approved: boolean): boolean {
  const pending = store.pendingPermissions.get(toolUseID);
  if (!pending) return false;
  const live = activeClients.get(store)?.isRunning === true;
  store.pendingPermissions.delete(toolUseID);
  notifyPermissionsChanged();
  if (!live) {
    console.log(`[codex-app-server] dropping answer for ${toolUseID}: no live app-server to answer`);
    try { pending.resolve(false); } catch { /* handler already gone */ }
    return false;
  }
  pending.resolve(approved === true);
  return true;
}
