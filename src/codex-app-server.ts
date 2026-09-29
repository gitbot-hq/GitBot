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
  EDIT_TOOLS,
  type SessionStore,
} from "./server-common";
import { bindSession, updateThread } from "./bot-store";
import { presetSystemPrompt, recordSetupOutcomeFromEvents } from "./bot-prompt";
// Circular with `start-codex`, which imports `runAppServerTurn` from here. Safe
// under CommonJS because neither module *calls* the other at load time — both
// references are resolved when a turn runs — and it is the right way round: the
// attachment download, the SSRF guard and the manifest format have to be the
// same code on both paths, because `loadTranscript` reads that manifest back.
// Verified on the compiled `dist/` build, not just under tsx.
import { stageAttachments, settleAttachments, type StagedAttachments } from "./start-codex";
import type { ThreadItem, TokenUsageBreakdown, TurnPlanStep, UserInput } from "./codex-app-server-protocol";

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
 * `execCommandApproval` and `applyPatchApproval` are the v1 approvals, and they
 * speak `ReviewDecision` — a different enum from the v2 `accept`/`decline` one.
 * Sending a v2 word on a v1 method (or the reverse) fails to deserialize and the
 * item is marked declined, so the two vocabularies never share a code path here:
 * every card carries its own decision mapper.
 *
 * `approved` is a unit variant on both binaries on this machine, so the approval
 * word needs no version check. `denied` does: `codex app-server generate-ts`
 * emits
 *
 *   0.135.0   … | "denied"                            | "timed_out" | "abort"
 *   0.155.1   … | { "denied": { rejection: string } } | "timed_out" | "abort"
 *
 * — mutually incompatible spellings, so neither one is universally right and
 * the choice has to come from the server itself (`v1DenyFor`).
 */
const V1_APPROVE = "approved";

/**
 * The newest codex whose `ReviewDecision::Denied` was measured as a *unit*
 * variant. Versions above this get the struct spelling.
 *
 * Only 0.135.0 and 0.155.1 were available to measure, so the real cutover is
 * somewhere in the unmeasured 0.136–0.154 band and this boundary is a guess for
 * anything inside it. The guess is cheap: a response app-server cannot
 * deserialize fails *closed* — measured on 0.155.1, it logs
 * `failed to deserialize …: unknown variant`, marks the item `status:"declined"`
 * and still sends `turn/completed`. So a mis-spelled denial is still a denial
 * and still lets the turn finish; it is noisy, not dangerous. (That was measured
 * on a v2 approval; the v1 pair deserializes through the same serde path, but
 * no binary here could be made to raise a v1 request to confirm it directly.)
 */
const LAST_UNIT_DENIED_VERSION: readonly [number, number, number] = [0, 135, 0];

/**
 * `InitializeResponse.userAgent` is `"<clientName>/<codexVersion> (os; arch) …"`.
 * Measured with `clientInfo.name = "probe"`:
 *   0.155.1 → `probe/0.155.1 (Mac OS 26.6.2; arm64) ghostty/1.3.1 (probe; 0.0.0)`
 *   0.135.0 → `probe/0.135.0 (Mac OS 26.6.2; arm64) ghostty/1.3.1 (probe; 0.0.0)`
 */
function parseServerVersion(userAgent: unknown): [number, number, number] | null {
  if (typeof userAgent !== "string") return null;
  const m = /^[^/\s]+\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The struct spelling carries a reason; the agent reports it back to the user. */
const V1_REJECTION = "The GitBot user declined this request.";

/**
 * The `ReviewDecision` denial this server understands. An unparseable version
 * gets the struct form: it is what the binary this repo pins speaks, and it is
 * what every version newer than the pin will speak.
 */
function v1DenyFor(version: readonly [number, number, number] | null): unknown {
  if (version) {
    for (let i = 0; i < 3; i++) {
      if (version[i] < LAST_UNIT_DENIED_VERSION[i]) return "denied";
      if (version[i] > LAST_UNIT_DENIED_VERSION[i]) return { denied: { rejection: V1_REJECTION } };
    }
    return "denied";
  }
  return { denied: { rejection: V1_REJECTION } };
}

/**
 * A ServerRequest we do not service still has to be answered or the turn waits
 * on it forever. Where the protocol has a "no" that type-checks, say no in its
 * own words; everything else gets a JSON-RPC error, which app-server treats as a
 * refusal (that is how `codex exec` itself declines approvals).
 */
function refusalResult(method: string, serverVersion: readonly [number, number, number] | null): unknown | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    // Not `{decision}`: `PermissionsRequestApprovalResponse` is
    // `{permissions, scope}`. Both members of `GrantedPermissionProfile` are
    // optional, so `{}` is a well-formed "granted nothing" — a real refusal,
    // which is why this no longer falls through to a JSON-RPC error.
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/tool/call":
      return { contentItems: [{ type: "inputText", text: "GitBot does not service dynamic tool calls." }], success: false };
    // Cheap and answerable truthfully.
    case "currentTime/read":
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: v1DenyFor(serverVersion) };
    default:
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
  private serverUserAgent: string | null = null;
  private serverVersion: [number, number, number] | null = null;

  constructor(private opts: CodexAppServerOptions) {}

  /** What `initialize` said this server is, or null before the handshake. */
  get userAgent(): string | null {
    return this.serverUserAgent;
  }

  /** The `ReviewDecision` denial spelling this server understands. */
  get v1Deny(): unknown {
    return v1DenyFor(this.serverVersion);
  }

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

    // Keep the result. `InitializeResponse.userAgent` names the server's own
    // version, and that is the only thing on the wire that says which
    // `ReviewDecision` denial spelling it can deserialize — see `v1DenyFor`.
    // Discarding it would leave the v1 answer a guess forever.
    const init = await this.request("initialize", {
      clientInfo: { name: "gitbot", title: "GitBot", version: PKG_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.serverUserAgent = typeof init?.userAgent === "string" ? init.userAgent : null;
    this.serverVersion = parseServerVersion(this.serverUserAgent);
    console.log(
      `[codex-app-server] userAgent=${JSON.stringify(this.serverUserAgent)} ` +
        `version=${this.serverVersion ? this.serverVersion.join(".") : "unparsed"} ` +
        `v1Deny=${JSON.stringify(this.v1Deny)}`,
    );
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
      const fallback = refusalResult(method, this.serverVersion);
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
 * Tool names `codexAutoApprove` must never answer without a human, whatever the
 * mode says.
 *
 * Two reasons land a name here. Either the request widens what codex is allowed
 * to do rather than doing one thing (`grantRoot`, and
 * `item/permissions/requestApproval`'s network reach and extra paths), or GitBot
 * cannot describe what the request would do, which is the one case where an
 * automatic "yes" is guaranteed to be uninformed.
 *
 * This matters beyond the per-request check: `codexAutoApprove` is also what
 * `PATCH /sessions/:id` uses to clear cards already on screen when the mode
 * changes (`server.ts:459`). Without it, switching a thread to `yolo` while one
 * of these cards is up would answer it as a side effect of a button labelled
 * "Allow all" — an answer the user never read the card to give.
 */
const NEVER_AUTO_APPROVE = new Set<string>();

/**
 * Registers `name` as never-auto-approvable and returns it, so the security key
 * and the card headline are one expression. A tool name is both: `chat.tsx:1520`
 * renders `Allow {toolName}?` from the same string this set is keyed on. Split
 * across two statements, rewording the copy (CDX-8 owns the card) silently
 * unregisters the guard and the card becomes auto-approvable.
 */
function neverAutoApprove(name: string): string {
  NEVER_AUTO_APPROVE.add(name);
  return name;
}

const GRANT_ROOT_TOOL = neverAutoApprove("write access outside the workspace");
const EXTRA_PERMISSIONS_TOOL = neverAutoApprove("extra sandbox permissions");
/** A file change GitBot could not describe — see `describeFileChange`. */
const OPAQUE_CHANGE_TOOL = neverAutoApprove("a file change GitBot cannot show you");

/**
 * Asserts `name` is not an `EDIT_TOOLS` member and returns it, for the card
 * headlines that remove files.
 *
 * `EDIT_TOOLS` is in another module and shared with claude-code and opencode.
 * If one of these names were ever added there, `allow-all-edits` — the mode
 * `botPermissionToSession` gives every codex bot — would start deleting
 * workspace files with no card at all, silently and by default. That is the
 * defect this naming exists to close, so it fails at import rather than in
 * production.
 */
function destructiveChangeTool(name: string): string {
  if (EDIT_TOOLS.has(name)) {
    throw new Error(`[codex] card name "${name}" is in EDIT_TOOLS; allow-all-edits would auto-approve file deletions`);
  }
  return name;
}

const DELETE_TOOL = destructiveChangeTool("Delete");
const EDIT_AND_DELETE_TOOL = destructiveChangeTool("Edit and delete");

/**
 * Put on every never-auto-approve card. The UI offers "Allow all" on any card
 * that is not an edit tool (`chat.tsx:1536-1544`); pressing it PATCHes the mode
 * to `yolo`, `codexAutoApprove` correctly refuses to resolve this card from it,
 * and the card just sits there with the mode silently changed underneath. Until
 * CDX-8 fixes the buttons, say so on the card.
 */
const ONLY_ANSWERABLE_HERE =
  "\"Allow all\" cannot answer this card — it only changes the mode for later requests. Choose Allow or Deny here.";

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
  if (NEVER_AUTO_APPROVE.has(toolName)) return false;
  return shouldAutoApprove(store.agent, toolName, store.permissionMode);
}

// --- Approval cards ---

/**
 * One entry of a `fileChange` item's `changes[]`.
 *
 * Deliberately looser than the generated `FileUpdateChange`
 * (`{path: string, kind: PatchChangeKind, diff: string}`, all three required):
 * `v1PatchApproval` builds values of this shape from v1's path-keyed
 * `fileChanges` map, whose `kind` is a bare string, and a card has to degrade a
 * missing field into honest copy rather than render `undefined`. The generated
 * type is assignable to this one, which is what lets `handleItem` pass its
 * `WireItem<"fileChange">.changes` straight into `fileChangeItems`.
 */
interface FileUpdateChange {
  path?: string;
  kind?: { type?: string; move_path?: string | null } | string;
  diff?: string;
}

/** One `fileChange` item still in flight, and the cards it has raised. */
interface FileChangeEntry {
  /** Replaced wholesale by `item/fileChange/patchUpdated`. */
  changes: FileUpdateChange[];
  /** `toolUseID`s of the approval cards raised for this item. */
  cards: Set<string>;
}

/**
 * The `fileChange` items still in flight, by item id.
 *
 * `FileChangeRequestApprovalParams` is `{threadId, turnId, itemId, startedAtMs,
 * reason?, grantRoot?}` — no path, no diff, nothing to show a human. The detail
 * lives on the `fileChange` *item*, and `itemId` is the only thing joining them.
 *
 * Ordering measured on 0.155.1 and 0.135.0: `item/started` for the item lands
 * ~1ms *before* the approval request, on the same stdout stream, so the entry is
 * always here by the time the request is dispatched. The reverse order is still
 * handled — `describeFileChange` says on the card that the detail is missing
 * rather than rendering a blank one — because that ordering is not promised
 * anywhere in the protocol.
 *
 * The server may also *revise* a patch between `item/started` and
 * `item/completed`, via `item/fileChange/patchUpdated`. `cards` exists for that:
 * a card already on the wire shows the old patch, and accepting it would apply
 * the new one. See `handleFileChangePatchUpdated`.
 *
 * Entries are removed on `item/completed`, which is measured to arrive *after*
 * the approval is answered, so this holds one item in the normal case and is
 * dropped wholesale when the turn ends.
 */
const fileChangeItems = new Map<SessionStore, Map<string, FileChangeEntry>>();

/**
 * A card is the one place a human is the security boundary, and it renders as
 * `JSON.stringify(input)` inside a fixed-height box. Push the Allow button off
 * the screen and the only thing left to do is scroll past it.
 *
 * Both caps are needed. One `apply_patch` touching several files is ONE item,
 * ONE approval and N changes (measured), so a per-string cap bounds nothing:
 * a 30-file patch would be 30 whole files on one card. `MAX_CARD_TEXT_CHARS` is
 * the budget across *every* change on the card; `MAX_CARD_FILES` bounds the list
 * of paths, which is short per entry but unbounded in count. Whatever does not
 * fit is counted, never silently dropped.
 */
const MAX_CARD_TEXT_CHARS = 4000;
const MAX_CARD_FILES = 20;

/** Characters left for diff bodies on the card being built. */
interface CardBudget {
  left: number;
}

function clip(text: string, budget: CardBudget): string {
  if (text.length <= budget.left) {
    budget.left -= text.length;
    return text;
  }
  const head = text.slice(0, Math.max(0, budget.left));
  budget.left = 0;
  return `${head}\n… (${text.length - head.length} more characters not shown)`;
}

/** The operation a change performs, as the card must name it. */
type ChangeKind = "add" | "delete" | "update" | "unrecognised";

function changeKind(change: FileUpdateChange): { kind: ChangeKind; raw: string } {
  const raw = typeof change.kind === "string" ? change.kind : change.kind?.type;
  if (raw === "add" || raw === "delete" || raw === "update") return { kind: raw, raw };
  return { kind: "unrecognised", raw: typeof raw === "string" ? raw : JSON.stringify(change.kind ?? null) };
}

/**
 * What each operation does, in the user's words. `PatchChangeKind` is
 * `{type:"add"} | {type:"delete"} | {type:"update", move_path}`, and the three
 * are not variations on one theme: a `delete` removes the file. Rendered as
 * `{old_string: <content>, new_string: ""}` with no label it reads as "blank the
 * file" — recoverable, in place — when it is `rm`.
 */
const OPERATION_COPY: Record<ChangeKind, string> = {
  add: "CREATE this file",
  delete: "DELETE this file — it is removed from disk. `old_string` is what is lost.",
  update: "EDIT this file in place",
  unrecognised: "",
};

/**
 * One change as the edit card the UI already knows how to read — the shape
 * opencode builds at `start-opencode.ts:461-477`, `{file_path, old_string,
 * new_string}`, so a codex edit renders as a diff rather than as a bare path,
 * plus an `operation` naming what is about to happen to the file.
 *
 * TRAP: `diff` is only a unified diff when `kind` is `update`. For `add` and
 * `delete` codex puts the file's *raw content* there with no `+`/`-` prefixes
 * (measured: `{"kind":{"type":"add"},"diff":"alpha\nbeta\n"}`), so running the
 * unified-diff splitter over it drops every line and produces the empty card
 * this is meant to avoid.
 */
function changeToEditInput(change: FileUpdateChange, budget: CardBudget): Record<string, unknown> {
  const { kind, raw } = changeKind(change);
  const body = typeof change.diff === "string" ? change.diff : "";
  const movePath = typeof change.kind === "object" ? change.kind?.move_path : null;

  const file_path = change.path ?? "(codex did not say which file)";

  if (kind === "unrecognised") {
    // The honesty check has to be per change, not per item: a single change with
    // a `kind` of null or something newer than this code would otherwise render
    // `{old_string:"", new_string:""}` — indistinguishable from a no-op, under a
    // headline that calls it an edit.
    return {
      operation: `Codex called this change "${raw}", which GitBot does not recognise. What it does to this file is UNKNOWN — the text below may not be what happens.`,
      file_path,
      raw_change: clip(body, budget),
    };
  }

  let old_string = "";
  let new_string = "";
  if (kind === "add") {
    new_string = body;
  } else if (kind === "delete") {
    old_string = body;
  } else {
    const lines = body.split("\n");
    // A unified diff's `---`/`+++` file header is the first two lines and
    // nowhere else. Screening every line for it (as the opencode splitter does)
    // silently eats a removed line whose content is `---` — YAML front matter, a
    // markdown rule — because removing it yields `----`. That is asymmetric, too:
    // an *added* `---` survives. Measured, codex `update` diffs start at `@@`
    // with no header at all, so this branch is for v1 `unified_diff` bodies.
    const start = lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ") ? 2 : 0;
    const removed: string[] = [];
    const added: string[] = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("-")) removed.push(line.slice(1));
      else if (line.startsWith("+")) added.push(line.slice(1));
    }
    old_string = removed.join("\n");
    new_string = added.join("\n");
  }

  return {
    operation: OPERATION_COPY[kind],
    file_path,
    old_string: clip(old_string, budget),
    new_string: clip(new_string, budget),
    ...(movePath ? { moved_to: movePath } : {}),
  };
}

/**
 * The card body for a file-change approval, and the tool name that heads it.
 *
 * The name is not cosmetic. It is the card headline (`Allow {toolName}?`), it is
 * what `EDIT_TOOLS` matches — so it decides whether `allow-all-edits` answers
 * this request with no card at all — and it is what the UI keys "Allow all
 * edits" on (`chat.tsx:1527`).
 *
 * Hence four names, not two:
 *
 * - `Write`           every change creates a file. In `EDIT_TOOLS`.
 * - `Edit`            no change removes a file. In `EDIT_TOOLS`.
 * - `Delete`          every change removes a file.
 * - `Edit and delete` some changes remove a file and some do not.
 *
 * The last two are deliberately NOT in `EDIT_TOOLS`, so `allow-all-edits` —
 * which `botPermissionToSession` hands every codex bot — cannot destroy a
 * workspace file without asking. Buying out of per-edit prompts is not buying
 * out of being told a file is about to be removed.
 *
 * `Edit and delete` has to be its own name rather than folding into `Edit`:
 * one `apply_patch` is ONE item with N changes (measured), and a rename is a
 * delete plus an add. Calling a mixed item an edit puts every deletion that
 * travels alongside one straight back on the auto-approve path, where the
 * per-change `operation` lines are never read because no card is ever raised.
 *
 * A change whose `kind` is unrecognised, and an approval with no changes at all,
 * both get `OPAQUE_CHANGE_TOOL`, which is never auto-approved in any mode:
 * having just said it does not know what this does, the code must not then
 * answer for the user.
 */
function describeFileChange(changes: FileUpdateChange[] | undefined, itemId: string): {
  toolName: string;
  input: Record<string, unknown>;
} {
  if (!changes || changes.length === 0) {
    // Honest rather than empty: the request genuinely carries no detail and the
    // item that would have carried it never arrived.
    return {
      toolName: OPAQUE_CHANGE_TOOL,
      input: {
        file_path: "(unknown)",
        note: "Codex asked to change a file but has not said which file or what the change is — the approval request carries neither, and the matching item has not arrived. Allowing this approves a change GitBot cannot show you.",
        itemId,
      },
    };
  }

  const kinds = changes.map((c) => changeKind(c).kind);
  const toolName = kinds.some((k) => k === "unrecognised")
    ? OPAQUE_CHANGE_TOOL
    : kinds.every((k) => k === "delete")
      ? DELETE_TOOL
      : kinds.some((k) => k === "delete")
        ? EDIT_AND_DELETE_TOOL
        : kinds.every((k) => k === "add")
          ? "Write"
          : "Edit";

  const budget: CardBudget = { left: MAX_CARD_TEXT_CHARS };
  const rendered: Record<string, unknown>[] = [];
  for (const change of changes) {
    // Always render the first change, however long it is: a card with nothing on
    // it is worse than a clipped one.
    if (rendered.length > 0 && (rendered.length >= MAX_CARD_FILES || budget.left <= 0)) break;
    rendered.push(changeToEditInput(change, budget));
  }
  const hidden = changes.length - rendered.length;

  if (changes.length === 1) return { toolName, input: rendered[0] };
  return {
    toolName,
    input: {
      files: changes.slice(0, MAX_CARD_FILES).map((c) => c.path ?? "(unknown)"),
      ...(changes.length > MAX_CARD_FILES
        ? { more_files: `… and ${changes.length - MAX_CARD_FILES} more paths not listed` }
        : {}),
      changes: rendered,
      ...(hidden > 0
        ? {
            not_shown: `${hidden} of the ${changes.length} file changes in this patch are not shown above — the card was truncated, not the patch. Allowing applies all ${changes.length}.`,
          }
        : {}),
    },
  };
}

/**
 * Raises a card and resolves once the browser answers. `decide` turns that
 * yes/no into the answer *this* method expects, which is what keeps the v1 and
 * v2 decision enums from ever meeting.
 *
 * `availableDecisions` rides on the event, not in `input`: `input` is what the
 * card renders, and the list is for CDX-8 to build buttons from later.
 */
function askUser(
  store: SessionStore,
  id: JsonRpcId,
  toolName: string,
  input: Record<string, unknown>,
  decide: (approved: boolean) => unknown,
  availableDecisions?: unknown[],
): Promise<unknown> {
  // One itemId can raise several approvals, so the JSON-RPC id is the only
  // identifier that is unique per request. Note codex numbers ids from 0, so the
  // first toolUseID is the string "0": truthy as a string, which is what
  // `server.ts`'s `if (!toolUseID)` and `chat.tsx`'s `if (!d.toolUseID)` need.
  // Passing the id through as a number would make both reject the first card.
  const toolUseID = String(id);
  // Added here rather than at each call site so it cannot be forgotten on a new
  // never-auto-approve card: the set is the single source for both facts.
  if (NEVER_AUTO_APPROVE.has(toolName)) input.answer_here = ONLY_ANSWERABLE_HERE;
  return new Promise<unknown>((resolve) => {
    store.pendingPermissions.set(toolUseID, {
      resolve: (approved: unknown) => resolve(decide(approved === true)),
      input,
      toolName,
      toolUseID,
    });
    notifyPermissionsChanged();
    emitEvent(store, "permission_request", {
      toolUseID,
      toolName,
      input,
      ...(availableDecisions ? { availableDecisions } : {}),
    });
  });
}

/**
 * The decisions worth offering, in the server's own order.
 *
 * An allow-list, not a deny-list. `CommandExecutionApprovalDecision` is
 * `"accept" | "acceptForSession" | {acceptWithExecpolicyAmendment} |
 * {applyNetworkPolicyAmendment} | "decline" | "cancel"` — and the two amendments
 * are the ones that must never become buttons. Accepting
 * `acceptWithExecpolicyAmendment` appends a permanent
 * `prefix_rule(…, decision="allow")` to the user's `~/.codex/rules/default.rules`
 * (`execpolicy/src/amend.rs:65-81`), silencing that command prefix in every
 * future Codex session including their own terminal.
 * `applyNetworkPolicyAmendment` is the same class of standing policy edit rather
 * than a one-off yes — where it is persisted was not traced here, which is
 * itself a reason not to offer it.
 *
 * Screening by shape does not hold them off: `ReviewDecision` already has a bare
 * string amendment (`"approved_mcp_policy_amendment"`, added between 0.135.0 and
 * 0.155.1), so "every plain string is safe" is false today and a future
 * `"acceptWithSomethingPermanent"` would sail through a deny-list unnoticed. The
 * allow-list fails the other way: a decision this code has never seen is simply
 * not offered.
 */
const OFFERABLE_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

function offerableDecisions(available: unknown): unknown[] | undefined {
  if (!Array.isArray(available)) return undefined;
  const kept = available.filter((d) => typeof d === "string" && OFFERABLE_DECISIONS.has(d));
  return kept.length > 0 ? kept : undefined;
}

/**
 * Tells the user about a request GitBot answered on their behalf.
 *
 * `assistant`, not `agent_error`. `agent_error` is React state, not transcript.
 * `chat.tsx:1013` early-returns on rejoin and otherwise only calls
 * `setTurnError`, which `aborted` and `done` clear again (`chat.tsx:1022`,
 * `:1028`) — and both follow within milliseconds of a decline like this one. It
 * also renders as `chat-error` with a Retry button, dressing a deliberate
 * refusal up as a retryable failure. `assistant` is appended to `msgs` and stays
 * there for the rest of the turn.
 *
 * Still not durable: this is GitBot's own line, so it is not in codex's rollout
 * and `loadTranscript` cannot bring it back on reload. Visible while it matters
 * beats invisible, and the alternative — a silent decline — is exactly what a
 * stalled agent looks like.
 */
function reportUnserviceable(store: SessionStore, message: string): void {
  console.log(`[codex-app-server] ${message}`);
  emitEvent(store, "assistant", { content: `**GitBot:** ${message}` });
}

export async function runAppServerTurn(store: SessionStore): Promise<void> {
  // Nothing from a previous turn may still be on screen: `buildPermissionsDump()`
  // walks every session, so one stale card poisons the hub-wide approvals tray
  // and pins this session at `awaiting_permissions` forever.
  denyAllPending(store);

  const lastUserEvent = [...store.events].reverse().find((e) => e.type === "user_prompt");
  const promptText = (lastUserEvent?.prompt as string) ?? "";
  const attachments = (lastUserEvent?.attachments as Array<{ url: string }> | undefined) ?? [];

  if (!promptText && attachments.length === 0) {
    emitEvent(store, "error", { message: "prompt or attachments is required" });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  }

  // Same download, same staging directory, same manifest as the SDK path —
  // `loadTranscript` reads that manifest to put the images back on reload, so
  // the two paths cannot be allowed to write it differently.
  let staged: StagedAttachments;
  try {
    staged = await stageAttachments(store, attachments);
  } catch (err: any) {
    console.error("[codex-app-server] attachment download failed:", err?.message);
    emitEvent(store, "error", { message: `Attachment download failed: ${err?.message ?? "unknown"}` });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
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
  /** This turn's correlation map, so the teardown can tell it from a later one. */
  let turnFileChanges: Map<string, FileChangeEntry> | null = null;
  const mapping: TurnMapping = { usage: null, streaming: new Set(), planUpdates: 0 };

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
        handleNotification(store, method, params, mapping, bindThread, () => {
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
    turnFileChanges = new Map();
    fileChangeItems.set(store, turnFileChanges);

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
      // `UserInput` is the generated type, so a renamed or retyped member of
      // the turn payload is a compile error rather than a silently ignored
      // field. `localImage` is app-server's spelling of the SDK's
      // `local_image`; both hand codex a path on disk, not bytes.
      const input: UserInput[] = [];
      if (promptText) input.push({ type: "text", text: promptText, text_elements: [] });
      for (const a of staged.downloaded) input.push({ type: "localImage", path: a.path });
      const turn = await client.request("turn/start", {
        threadId: threadIdForTurn,
        input,
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
    // Unconditional, and before the supersession check: the staging directory
    // is named after `gitbotId`, so it belongs to the store rather than to this
    // turn, and `thread/started` has by now given it the id the manifest is
    // filed under. Leaving it unpromoted loses the images' original URLs, which
    // is what `loadTranscript` needs to render them again.
    settleAttachments(store, staged);
    // Delete only what this turn owns. `onAbort` sets `store.status = "done"`
    // immediately but defers `finishTurn` by `ABORT_GRACE_MS`, and this block
    // runs later still — while `/chat`'s only guard is
    // `if (store.status === "running")` (server.ts:317). A re-send inside that
    // window starts turn 2 on the same store, and an unconditional teardown here
    // would delete turn 2's correlation map and its live client entry: every
    // approval it raises would then have no path back to the child, and
    // `respondPermission` would 409 the lot.
    const superseded = activeClients.get(store) !== client;
    if (!superseded) {
      activeClients.delete(store);
      denyAllPending(store);
      store.abortController = null;
      store.pendingPermissions.clear();
      notifyPermissionsChanged();
    }
    if (turnFileChanges && fileChangeItems.get(store) === turnFileChanges) fileChangeItems.delete(store);
    // Unconditional: this turn's child must die whoever owns the store now.
    client?.dispose();
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

/**
 * What the mapping has to remember for the length of one turn. Lives in
 * `runAppServerTurn`'s frame rather than in a module-level map keyed on the
 * store, so it cannot outlive the turn or be read by the next one.
 */
interface TurnMapping {
  /**
   * This turn's token usage, accumulated.
   *
   * `turn/completed` carries no usage at all — `Turn` is
   * `{id, items, itemsView, status, error, startedAt, completedAt, durationMs}`
   * — where the SDK's `turn.completed` carries a `Usage`. The numbers only
   * arrive on `thread/tokenUsage/updated`, once per model request, and its
   * `total` is THREAD-cumulative, not turn-scoped: on a resumed thread it
   * already includes every earlier turn. Its `last` is the request that just
   * finished, and summing those over the turn reproduces the turn's share
   * exactly (measured over a 4-request turn: 14773+14890+15010+15105 = 59778,
   * the reported running total).
   */
  usage: Record<string, number> | null;
  /** Item ids already given a streaming status — see `noteStreaming`. */
  streaming: Set<string>;
  /** Counts plan revisions, so each gets its own `tool_use_id`. */
  planUpdates: number;
}

/**
 * A `TurnError` as one line.
 *
 * `message` alone loses the cause. Measured on 0.155.1, the same failure that
 * `codex exec` reports as
 * `"Reconnecting... 2/5 (stream disconnected before completion: Connection
 * refused (os error 61))"` arrives here split in two —
 * `message: "Reconnecting... 2/5"` and
 * `additionalDetails: "stream disconnected before completion: Connection
 * refused (os error 61)"` — so joining them is what makes the two paths say the
 * same thing. `codexErrorInfo` is left out: it is a machine code
 * (`responseStreamDisconnected`) that adds nothing a user can read.
 */
function turnErrorMessage(error: unknown, fallback: string): string {
  const e = error as { message?: unknown; additionalDetails?: unknown } | null;
  const message = typeof e?.message === "string" && e.message.trim() ? e.message : fallback;
  const details = typeof e?.additionalDetails === "string" && e.additionalDetails.trim() ? e.additionalDetails : "";
  return details ? `${message} (${details})` : message;
}

/** Adds one `thread/tokenUsage/updated` delta to the turn's running total. */
function addUsage(mapping: TurnMapping, last: Partial<TokenUsageBreakdown> | undefined): void {
  if (!last || typeof last !== "object") return;
  const acc = mapping.usage ?? {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const add = (key: string, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) acc[key] += value;
  };
  // snake_case on purpose: this is the SDK's `Usage`, which is what the
  // flag-off path already puts on `result.usage`. One shape, not two.
  add("input_tokens", last.inputTokens);
  add("cached_input_tokens", last.cachedInputTokens);
  add("cache_write_input_tokens", last.cacheWriteInputTokens);
  add("output_tokens", last.outputTokens);
  add("reasoning_output_tokens", last.reasoningOutputTokens);
  mapping.usage = acc;
}

/**
 * Says "something is happening" once per streaming item instead of once per
 * token.
 *
 * Measured on one ordinary turn: 107 `item/agentMessage/delta` notifications,
 * and 316 `item/plan/delta` on a plan-mode turn. The UI has nowhere to put the
 * tokens — `chat.tsx` fakes streaming from whole `assistant` messages and
 * explicitly does not want real deltas (`ui/AGENTS.md`) — so forwarding them
 * would be hundreds of SSE frames carrying a label that never changes. The
 * label itself is worth having: without it the composer sits on the previous
 * activity for the several seconds before the message lands.
 */
function noteStreaming(store: SessionStore, mapping: TurnMapping, itemId: unknown, summary: string): void {
  const key = typeof itemId === "string" ? itemId : "";
  if (!key || mapping.streaming.has(key)) return;
  mapping.streaming.add(key);
  // `tool_summary` is the only `status` subtype `chat.tsx` renders free text
  // for (`chat.tsx:996`); `thinking` and `tool` both have fixed wording.
  emitEvent(store, "status", { status: "tool_summary", summary });
}

/**
 * Notifications this code has read, understood and deliberately drops, so the
 * `default` branch's log keeps meaning "something new turned up".
 *
 * - `thread/status/changed`: `ThreadStatus` is
 *   `notLoaded | idle | systemError | active{activeFlags}`. The turn lifecycle
 *   is already reported by `turn/started`/`turn/completed`, and the two flags
 *   (`waitingOnApproval`, `waitingOnUserInput`) duplicate the
 *   `permission_request` that raised the card. `systemError` carries no message
 *   of its own, so there would be nothing to show the user: the reason arrives
 *   as an `error` notification or as `turn/completed` with `status:"failed"`,
 *   both handled above.
 * - `account/rateLimits/updated`, `account/updated`, `turn/moderationMetadata`,
 *   `remoteControl/status/changed`, `thread/goal/updated`,
 *   `thread/goal/cleared`, `thread/queue/changed`, `project/changed`,
 *   `thread/project/updated`, `fs/changed`: account, device-pairing and
 *   IDE-panel state with no GitBot surface to put it on.
 * - `turn/diff/updated`: an aggregated `git diff` of the turn. The UI has its
 *   own diff view served from `GET /diffs`, which runs git against the real
 *   working tree; a second, staler copy on the event stream is not better.
 * - `item/commandExecution/outputDelta`: the command's output as it appears.
 *   `tool_use` has already put "Running Bash…" on screen and `tool_result`
 *   carries the whole `aggregatedOutput` at the end, so a per-chunk event
 *   would only be a second copy of text the transcript already gets.
 * - `item/reasoning/summaryPartAdded`: a boundary marker with no text on it.
 * - `rawResponseItem/completed`, `rawResponse/completed`: opt-in raw Responses
 *   API echoes; GitBot never sets `experimentalRawEvents`.
 */
const IGNORED_NOTIFICATIONS = new Set([
  "thread/status/changed",
  "account/rateLimits/updated",
  "account/updated",
  "turn/moderationMetadata",
  "remoteControl/status/changed",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/queue/changed",
  "project/changed",
  "thread/project/updated",
  "fs/changed",
  "turn/diff/updated",
  "item/commandExecution/outputDelta",
  "item/reasoning/summaryPartAdded",
  "rawResponseItem/completed",
  "rawResponse/completed",
]);

function handleNotification(
  store: SessionStore,
  method: string,
  params: any,
  mapping: TurnMapping,
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
        emitEvent(store, "error", { message: turnErrorMessage(params?.turn?.error, "Codex turn failed") });
        store.status = "error";
      } else if (status === "interrupted") {
        // When the user pressed Stop we already said so and set the status;
        // a still-running session means the server cut the turn short itself.
        if (store.status === "running") {
          emitEvent(store, "aborted", { message: "Codex stopped this turn before it finished" });
          store.status = "done";
        }
      } else {
        emitEvent(store, "result", {
          subtype: "success",
          ...(mapping.usage ? { usage: mapping.usage } : {}),
        });
      }
      onTurnEnded();
      return;
    }
    case "thread/tokenUsage/updated":
      addUsage(mapping, params?.tokenUsage?.last);
      return;
    case "error": {
      // `ErrorNotification` carries `willRetry`. codex reports retries and
      // transport fallbacks here and then carries on, so a retryable error must
      // not end the turn — but one it will not retry is the end of the turn, and
      // treating it as noise leaves the session waiting on a child that is done.
      const message = turnErrorMessage(params?.error, "Codex reported an error");
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
    case "item/fileChange/patchUpdated":
      handleFileChangePatchUpdated(store, params);
      return;
    case "turn/plan/updated": {
      // The counterpart of the SDK's `todo_list` item — the `update_plan` tool.
      // NOT the `plan` ITEM, which is a markdown document with no per-step
      // state (measured: `{"type":"plan","id":"…-plan","text":"# Add Output
      // Path Flag…"}`); a `[done]/[open]` list cannot be built from that, so
      // `handleItem` renders it as prose instead.
      //
      // SHAPE IS FROM THE GENERATED TYPES, NOT FROM A MEASUREMENT. No model
      // reachable on this account offers `update_plan` on 0.155.1 — gpt-5.5 and
      // gpt-6-sol both answered that they have no such tool, with
      // `tools.update_plan = {state = "enabled"}` set, so the notification
      // could not be provoked. Kept because the SDK path has the same handler
      // for `todo_list`, and parity is the point of this issue; written so that
      // a missing `plan`, a missing `step` or an unknown `status` degrades
      // rather than throws.
      const steps: Array<Partial<TurnPlanStep>> = Array.isArray(params?.plan) ? params.plan : [];
      if (steps.length === 0) return;
      // `TurnPlanStepStatus` is pending | inProgress | completed, against the
      // SDK's boolean `completed` — so inProgress reads as open, which is what
      // the SDK reported for it too.
      const summary = steps
        .map((s) => `[${s?.status === "completed" ? "done" : "open"}] ${s?.step ?? "(unnamed step)"}`)
        .join(", ");
      emitEvent(store, "tool_use", {
        tool_name: "TodoWrite",
        tool_input: summary,
        // The notification carries no item id, and a revised plan is a new
        // card in the SDK path (a fresh `todo_list` item each time), so number
        // them rather than reuse one id for every revision.
        tool_use_id: `${params?.turnId ?? "turn"}#plan-${++mapping.planUpdates}`,
      });
      return;
    }
    case "item/agentMessage/delta":
    case "item/plan/delta":
      noteStreaming(store, mapping, params?.itemId, "Writing…");
      return;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      // A `reasoning` item/started already said "Thinking…" (measured: one
      // fires per reasoning item). This only matters when the summary text
      // starts arriving without one, which the protocol does not forbid.
      noteStreaming(store, mapping, params?.itemId, "Thinking…");
      return;
    case "mcpServer/startupStatus/updated": {
      // `McpServerStartupState` is starting | ready | failed | cancelled, and
      // codex boots three of its own servers per thread (`codex_apps`,
      // `node_repl`, `cua_repl`) — ~6-9 notifications a turn, all noise except
      // a failure. A server that did not come up is a set of tools the model
      // silently no longer has, which is worth one line and is not fatal.
      if (params?.status !== "failed") return;
      const name = typeof params?.name === "string" ? params.name : "an MCP server";
      const detail = typeof params?.error === "string" && params.error.trim() ? `: ${params.error}` : "";
      emitEvent(store, "agent_error", {
        message: `Codex could not start the MCP server "${name}"${detail}. Its tools are unavailable for this turn.`,
      });
      return;
    }
    case "warning":
    case "guardianWarning": {
      // Codex's own non-fatal notices about this thread's work. `agent_error`
      // is where this path already puts everything codex says went wrong but
      // survived (`ErrorNotification` with `willRetry`), so they share it.
      //
      // Only these two. `configWarning` and `deprecationNotice` are a
      // DIFFERENT SHAPE — `{summary, details}`, not `{message}` — and are about
      // the config file and the API GitBot itself called, neither of which the
      // user can act on from a chat. They go to the console below.
      const message = typeof params?.message === "string" ? params.message : "";
      if (!message.trim()) return;
      console.log(`[codex-app-server] ${method}: ${message}`);
      emitEvent(store, "agent_error", { message });
      return;
    }
    case "configWarning":
    case "deprecationNotice":
      console.log(
        `[codex-app-server] ${method}: ${params?.summary ?? "(no summary)"}` +
          (params?.details ? ` — ${params.details}` : ""),
      );
      return;
    default:
      if (IGNORED_NOTIFICATIONS.has(method)) return;
      console.log(`[codex-app-server] ignoring notification ${method}`);
      return;
  }
}

/**
 * `FileChangePatchUpdatedNotification` — `{threadId, turnId, itemId, changes}`.
 * The server has revised a patch it already announced. (Live on 0.155.1: its
 * sibling `item/fileChange/outputDelta` is marked deprecated in the generated
 * types, this one is not.)
 *
 * Two things have to happen, and they are not the same thing.
 *
 * The correlation entry is replaced, so a card raised *after* this point shows
 * the patch that would actually be applied.
 *
 * A card already on the wire is auto-declined. It was built from the
 * `item/started` snapshot, and the UI refuses to update a `toolUseID` it has
 * already rendered (`chat.tsx:1003` returns `prev` unchanged), so there is no
 * way to correct it in place before CDX-8. Leaving it up would mean the user
 * reads diff A and `{decision:"accept"}` applies diff B — the exact
 * misrepresentation this whole issue exists to prevent. Declining costs a
 * re-ask; accepting silently costs the user's trust in every card.
 */
function handleFileChangePatchUpdated(store: SessionStore, params: any): void {
  const itemId = typeof params?.itemId === "string" ? params.itemId : "";
  const entry = itemId ? fileChangeItems.get(store)?.get(itemId) : undefined;
  const changes: FileUpdateChange[] = Array.isArray(params?.changes) ? params.changes : [];
  if (!entry) {
    // No card and no snapshot: record it so a later approval has the detail.
    if (itemId) fileChangeItems.get(store)?.set(itemId, { changes, cards: new Set() });
    return;
  }
  entry.changes = changes;

  const open = [...entry.cards].filter((toolUseID) => store.pendingPermissions.has(toolUseID));
  entry.cards = new Set(open);
  if (open.length === 0) return;

  console.log(`[codex-app-server] patch for item ${itemId} changed under ${open.length} open card(s); declining them`);
  for (const toolUseID of open) respondPermission(store, toolUseID, false);
  entry.cards.clear();
  reportUnserviceable(
    store,
    "Codex changed this patch after asking about it, so the approval you were shown no longer describes what would be applied. It was declined. If Codex asks again, the card will show the new patch.",
  );
}

/**
 * One arm of the generated `ThreadItem` union, as it is safe to read off the
 * wire.
 *
 * The generated type says what the *pinned* 0.155.1 binary promises. Nothing
 * here validates the JSON against it, and `resolveCodexBinary()` deliberately
 * falls back to whatever `codex` is on PATH — so only the discriminant, which
 * `handleItem` has just tested, is assumed to be there. `Partial` is what makes
 * the difference load-bearing: every field NAME and TYPE below is still checked
 * against the real protocol (a renamed `aggregatedOutput` fails to compile),
 * while every read still has to cope with the field being absent.
 */
type WireItem<T extends ThreadItem["type"]> = Partial<Extract<ThreadItem, { type: T }>> & { type: T };

/**
 * `item/started` and `item/completed` are the only two item notifications v2
 * has — there is no `item/updated` in `ServerNotification` on 0.155.1, so the
 * "an update arrives after completion" case cannot happen and nothing here
 * guards against it. Every arm still tests `method` explicitly rather than
 * using `else`, so adding a third forwarded method later cannot silently
 * double-emit.
 */
function handleItem(store: SessionStore, method: string, item: any): void {
  if (!item || typeof item.type !== "string") return;
  const started = method === "item/started";
  const completed = method === "item/completed";
  switch (item.type as ThreadItem["type"]) {
    case "agentMessage": {
      const it = item as WireItem<"agentMessage">;
      // Every phase, not just `final_answer`: `commentary` messages are the
      // agent narrating as it works, and the SDK path showed them too.
      if (completed) emitEvent(store, "assistant", { content: it.text ?? "" });
      return;
    }
    case "plan": {
      const it = item as WireItem<"plan">;
      // A markdown plan document, NOT a checklist — measured on 0.155.1:
      // `{"type":"plan","id":"…-plan","text":"# Add Output Path Flag…"}`. So it
      // is prose, and `assistant` is the only event that renders prose as
      // markdown. `turn/plan/updated` is the checklist, and that is what
      // becomes `TodoWrite`.
      //
      // Reachable only under `collaborationMode: {mode:"plan"}`, which this
      // path does not request yet (CDX-5 owns modes); mapped anyway because
      // dropping a whole plan on the floor is the worse failure.
      if (completed && typeof it.text === "string" && it.text.trim()) {
        emitEvent(store, "assistant", { content: it.text });
      }
      return;
    }
    case "reasoning":
      // A status, not content: `summary` and `content` arrived as empty arrays
      // on every reasoning item measured here, at `item/started` and at
      // `item/completed` alike, so there is nothing to render but the fact that
      // it is thinking — which is exactly what the SDK path emitted.
      if (started) emitEvent(store, "status", { status: "thinking" });
      return;
    case "commandExecution": {
      const it = item as WireItem<"commandExecution">;
      if (started) {
        emitEvent(store, "tool_use", {
          tool_name: "Bash",
          tool_input: it.command ?? "",
          tool_use_id: it.id,
        });
      } else if (completed) {
        emitEvent(store, "tool_result", {
          tool_use_id: it.id,
          tool_name: "Bash",
          output: it.aggregatedOutput ?? "",
          exit_code: it.exitCode ?? null,
          status: it.status ?? "completed",
        });
      }
      return;
    }
    case "fileChange": {
      const it = item as WireItem<"fileChange">;
      if (started) {
        // The only carrier of the path and the diff that this item's approval
        // request will not have. See `fileChangeItems`.
        if (Array.isArray(it.changes) && typeof it.id === "string") {
          const items = fileChangeItems.get(store);
          const existing = items?.get(it.id);
          // Keep any cards already registered against this id rather than
          // replacing the entry: `item/fileChange/patchUpdated` needs them.
          if (existing) existing.changes = it.changes;
          else items?.set(it.id, { changes: it.changes, cards: new Set() });
        }
      } else if (completed) {
        if (typeof it.id === "string") fileChangeItems.get(store)?.delete(it.id);
        // Same events the SDK path emits (`start-codex.ts` handleItem): one
        // tool_use per file. Without it an auto-approved edit changes a file and
        // the transcript says nothing happened. The names match the approval
        // card's, so a deletion is not filed in the transcript as an edit either.
        for (const change of it.changes ?? []) {
          // v2 spells the kind as a tagged object; the SDK's ThreadItem had a
          // bare string. `changeKind` reads either and names anything else.
          const { kind } = changeKind(change ?? {});
          emitEvent(store, "tool_use", {
            tool_name: kind === "add" ? "Write" : kind === "delete" ? DELETE_TOOL : "Edit",
            tool_input: change?.path ?? "",
            tool_use_id: it.id,
          });
        }
      }
      return;
    }
    case "webSearch": {
      const it = item as WireItem<"webSearch">;
      // `item/completed` only: at `item/started` the query is the empty string
      // and `action` is `{"type":"other"}` (measured), so an early card would
      // say "WebSearch" with nothing in it. The SDK path also emitted on
      // completion.
      if (!completed) return;
      emitEvent(store, "tool_use", {
        tool_name: "WebSearch",
        tool_input: it.query?.trim() ? it.query : describeSearchAction(it.action),
        tool_use_id: it.id,
      });
      return;
    }
    case "mcpToolCall": {
      const it = item as WireItem<"mcpToolCall">;
      // `mcp__<server>__<tool>` is the claude-code spelling the UI and
      // `shouldAutoApprove` already understand, and what the SDK path built
      // from `item.server`/`item.tool`. Measured: `server:"node_repl"`,
      // `tool:"js"` → `mcp__node_repl__js`.
      const toolName = `mcp__${it.server ?? "unknown"}__${it.tool ?? "unknown"}`;
      if (started) {
        emitEvent(store, "tool_use", {
          tool_name: toolName,
          tool_input: JSON.stringify(it.arguments ?? {}),
          tool_use_id: it.id,
        });
      } else if (completed) {
        // More than the SDK path had: it emitted one `tool_use` on completion
        // and nothing else, so a failed MCP call read exactly like a successful
        // one. `status` is inProgress | completed | failed and `error` is
        // `{message}`; both belong in the transcript.
        emitEvent(store, "tool_result", {
          tool_use_id: it.id,
          tool_name: toolName,
          output: it.error?.message ?? mcpResultText(it.result),
          status: it.status ?? "completed",
        });
      }
      return;
    }
    case "userMessage":
      // GitBot's own prompt, echoed back as the first item of every turn
      // (measured: `content` is the exact `{type:"text"}` sent to `turn/start`).
      // The browser already rendered it before the request went out, so
      // emitting anything here would show the user their own message twice.
      return;
    default:
      // `ThreadItem` has 19 arms; the rest are hooks, sub-agents, dynamic
      // tools, review mode, image generation and compaction, none of which
      // GitBot enables. Logged rather than listed, because unlike the
      // notification list this one is quiet — at most a handful a turn.
      console.log(`[codex-app-server] ignoring ${method} for item type ${item.type}`);
      return;
  }
}

/**
 * What a `webSearch` item was doing when its `query` is empty.
 *
 * `query` was measured empty at `item/started` and filled at `item/completed`
 * for a plain search, so this is not the normal path. It exists because
 * `WebSearchAction` is `search{query,queries} | openPage{url} |
 * findInPage{url,pattern} | other`, and only the first of those has a query to
 * put there at all — a card reading `WebSearch: ""` says less than nothing.
 */
function describeSearchAction(action: unknown): string {
  const a = action as { type?: string; url?: string | null; pattern?: string | null; queries?: string[] | null } | null;
  switch (a?.type) {
    case "search": return a.queries?.filter((q) => typeof q === "string").join(", ") || "(no query)";
    case "openPage": return a.url ?? "(opened a page)";
    case "findInPage": return [a.pattern, a.url].filter(Boolean).join(" in ") || "(searched within a page)";
    default: return "(codex did not say what it searched for)";
  }
}

/**
 * The text of an `McpToolCallResult`. `content` is `Array<JsonValue>` —
 * deliberately opaque at the app-server boundary so new MCP content types pass
 * through — so the text blocks are pulled out and anything else is named by its
 * type rather than dumped as JSON into the transcript.
 */
function mcpResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (typeof block?.text === "string" ? block.text : `(${block?.type ?? "unknown"} content)`))
    .join("\n");
}

/**
 * Returns the JSON-RPC result, or `undefined` to let the client refuse. An
 * approval returns a promise that settles when the browser answers — the read
 * loop is not waiting on it.
 *
 * Every arm answers in its own method's vocabulary. The v2 approvals say
 * `accept`/`decline`, `item/permissions/requestApproval` answers with a granted
 * profile and no decision at all, and the v1 pair speaks `ReviewDecision`.
 */
function handleServerRequest(
  store: SessionStore,
  method: string,
  params: any,
  id: JsonRpcId,
): unknown | Promise<unknown> | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval": return commandApproval(store, params, id);
    case "item/fileChange/requestApproval": return fileChangeApproval(store, params, id);
    case "item/permissions/requestApproval": return permissionsApproval(store, params, id);
    case "item/tool/requestUserInput": return declineUserInput(store, params);
    case "mcpServer/elicitation/request": return declineElicitation(store, params);
    case "execCommandApproval": return v1CommandApproval(store, params, id);
    case "applyPatchApproval": return v1PatchApproval(store, params, id);
    default: return undefined;
  }
}

function commandApproval(store: SessionStore, params: any, id: JsonRpcId): unknown | Promise<unknown> {
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

  const autoApprove = codexAutoApprove(store, toolName);
  console.log(`[codex-app-server] approval id=${id} tool="${toolName}" mode="${store.permissionMode}"${store.mode === "plan" ? " (plan)" : ""} autoApprove=${autoApprove}`);
  if (autoApprove) return { decision: "accept" };

  return askUser(store, id, toolName, input, v2Decision, offerableDecisions(params?.availableDecisions));
}

/**
 * A denial is always "decline", even though 0.155.1 leaves it out of
 * `availableDecisions` (that list is a hint for which buttons to draw, not a
 * whitelist — "decline" is accepted regardless, measured). "cancel" is not a
 * synonym: it ends the turn as `interrupted` with no closing word from the
 * agent, where "decline" completes the turn and the agent explains the refusal.
 */
function v2Decision(approved: boolean): unknown {
  return { decision: approved ? "accept" : "decline" };
}

/**
 * Copy for a `grantRoot` card. Shared by the v2 and v1 patch approvals so the
 * two cannot drift apart.
 *
 * `hasEdit` gates the "wider than the change below" line: with no correlated
 * item there is no change below, and the card would be pointing at nothing.
 *
 * The protocol's own doc for `grantRoot` says "[UNSTABLE] … (unclear if this is
 * honored today)". The copy still states the session scope as fact, on purpose:
 * over-warning about a grant that turns out to be inert costs the user a click,
 * under-warning about one that is honoured costs them the sandbox.
 */
function grantRootInput(grantRoot: unknown, reason: string | null, hasEdit: boolean): Record<string, unknown> {
  return {
    action: "Give Codex permission to write anywhere under this directory",
    directory: grantRoot,
    lasts: "The rest of this session — every later file change under that directory, not just this one.",
    // `FileChangeApprovalDecision` is one field. There is no way to take the
    // file change and refuse the standing grant, so say that rather than let the
    // user believe Allow only covers what the card shows.
    both_or_neither: hasEdit
      ? "One answer covers both: Allow approves the change below AND the standing grant; Deny refuses both. The protocol has no way to split them."
      : "Allow grants this standing permission. Deny refuses it.",
    ...(hasEdit
      ? { warning: "This is wider than the change below: it lets Codex write outside the folder it was confined to." }
      : { warning: "This lets Codex write outside the folder it was confined to." }),
    ...(reason ? { reason } : {}),
  };
}

function fileChangeApproval(store: SessionStore, params: any, id: JsonRpcId): unknown | Promise<unknown> {
  const itemId = typeof params?.itemId === "string" ? params.itemId : "";
  const items = fileChangeItems.get(store);
  let entry = itemId ? items?.get(itemId) : undefined;
  const changes = entry?.changes;
  const hasDetail = !!changes && changes.length > 0;
  const reason = typeof params?.reason === "string" && params.reason.trim() ? params.reason : null;
  // Remember which cards this item raised, so `item/fileChange/patchUpdated` can
  // find the ones it has just invalidated. The entry is created when it is
  // missing — the approval can in principle outrun its `item/started`, and a
  // card that is not registered here is one `patchUpdated` cannot retract.
  const remember = () => {
    if (!itemId || !items) return;
    if (!entry) {
      entry = { changes: [], cards: new Set() };
      items.set(itemId, entry);
    }
    entry.cards.add(String(id));
  };

  // `grantRoot` is not an edit. It asks to write under a root "for the
  // remainder of the session" — a standing escalation out of the workspace that
  // no permission mode ever promised. It is never auto-answered, not even under
  // `yolo`: `allow-all-edits` (which `botPermissionToSession` gives every codex
  // bot) bought the user out of per-edit prompts, not out of being told the
  // sandbox is about to be widened for good.
  if (params?.grantRoot != null) {
    console.log(`[codex-app-server] fileChange approval id=${id} asks for session-wide write access under ${JSON.stringify(params.grantRoot)}`);
    const input: Record<string, unknown> = {
      ...grantRootInput(params.grantRoot, reason, hasDetail),
      ...describeFileChange(changes, itemId).input,
    };
    // `GRANT_ROOT_TOOL` is registered never-auto-approvable, so neither
    // `allow-all-edits` nor the UI's "Allow all" can answer this.
    remember();
    return askUser(store, id, GRANT_ROOT_TOOL, input, v2Decision);
  }

  const { toolName, input } = describeFileChange(changes, itemId);
  // Honour the mode that already says edits need no asking (CDX-5's table:
  // "auto-accept fileChange when grantRoot == null"), or a bot in
  // `allow-all-edits` could not edit at all. `codexAutoApprove` is what keeps
  // plan mode — nominally `yolo` — from accepting here, what keeps
  // `allow-all-edits` off a `Delete`, and what keeps every mode off a change
  // `describeFileChange` could not read.
  const autoApprove = codexAutoApprove(store, toolName);
  console.log(`[codex-app-server] fileChange approval id=${id} tool="${toolName}" item=${itemId} detail=${hasDetail ? "yes" : "no"} mode="${store.permissionMode}"${store.mode === "plan" ? " (plan)" : ""} autoApprove=${autoApprove}`);
  if (autoApprove) return { decision: "accept" };

  if (reason) input.reason = reason;
  // `FileChangeRequestApprovalParams` has no `availableDecisions` — the server
  // offers none for this method, on either binary measured.
  remember();
  return askUser(store, id, toolName, input, v2Decision);
}

/**
 * Codex asking to step outside its sandbox for this turn — extra network reach
 * or extra readable/writable paths.
 *
 * The answer is `{permissions, scope}`, not `{decision}`: the client says what
 * it *grants*, and granting nothing is the refusal. Always a card, for the same
 * reason `grantRoot` is: an auto-answer here would hand over the sandbox escape
 * that the approval exists to ask about.
 */
function permissionsApproval(store: SessionStore, params: any, id: JsonRpcId): unknown | Promise<unknown> {
  const requested = params?.permissions ?? {};
  const input: Record<string, unknown> = {
    action: "Let Codex step outside its sandbox for this turn",
    ...(requested.network ? { network: requested.network } : {}),
    ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
    cwd: params?.cwd ?? store.repoPath,
    ...(typeof params?.reason === "string" && params.reason.trim() ? { reason: params.reason } : {}),
  };
  console.log(`[codex-app-server] permissions approval id=${id} requested=${JSON.stringify(requested)}`);

  return askUser(store, id, EXTRA_PERMISSIONS_TOOL, input, (approved) => ({
    // `RequestPermissionProfile` and `GrantedPermissionProfile` carry the same
    // two members; the request spells absence as null and the grant by omission.
    permissions: approved
      ? {
          ...(requested.network ? { network: requested.network } : {}),
          ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        }
      : {},
    // Never "session". A single click must not outlive the turn it was given
    // for; `PermissionGrantScope` is the only place that choice is made.
    scope: "turn",
  }));
}

/**
 * `item/tool/requestUserInput` is a question, not an approval — free text or a
 * choice from `options`, which an Allow/Deny card cannot express. Declining is
 * the only honest answer today, so say so in the transcript with the question
 * attached: a silent `{answers:{}}` is indistinguishable from the agent stalling
 * and then quietly changing its mind.
 */
function declineUserInput(store: SessionStore, params: any): unknown {
  const questions: any[] = Array.isArray(params?.questions) ? params.questions : [];
  const asked = questions
    .map((q) => {
      // `isSecret` marks a question whose *answer* is a secret (an API key, a
      // password). The question text is the prompt, never the answer, and GitBot
      // never collects one — so echoing it back to the user who would have typed
      // the secret leaks nothing, and hiding it would leave them unable to tell
      // what codex is stuck on. Deliberate, not an oversight.
      const text = [q?.header, q?.question].filter((s) => typeof s === "string" && s.trim()).join(" — ");
      const options: string[] = Array.isArray(q?.options)
        ? q.options.map((o: any) => o?.label).filter((l: any) => typeof l === "string")
        : [];
      return options.length > 0 ? `${text} (${options.join(" / ")})` : text;
    })
    .filter(Boolean);
  reportUnserviceable(
    store,
    `Codex asked you a question, and GitBot has no way to pass an answer back yet, so it was left unanswered${asked.length > 0 ? `:\n\n${asked.map((q) => `- ${q}`).join("\n")}` : "."}`,
  );
  return { answers: {} };
}

/**
 * An MCP server asking the user for something directly. Declined on purpose:
 * the three modes are a `form` (a JSON-schema form GitBot has no renderer for),
 * a `url` (sending the user off to an external page mid-turn) and
 * `openai/userVerification` (a challenge that must be read by a human) — none
 * survives being reduced to Allow/Deny, and guessing an answer on the user's
 * behalf is worse than saying no. Visible, so the turn does not look stuck.
 */
function declineElicitation(store: SessionStore, params: any): unknown {
  const server = typeof params?.serverName === "string" ? params.serverName : "an MCP server";
  const message = typeof params?.message === "string" && params.message.trim() ? ` It asked: ${params.message}` : "";
  reportUnserviceable(store, `Declined a request from ${server} for input GitBot cannot collect (${params?.mode ?? "unknown"} mode).${message}`);
  return { action: "decline", content: null, _meta: null };
}

/** v1 `ExecCommandApprovalParams`: `command` is argv, not a string. */
function v1CommandApproval(store: SessionStore, params: any, id: JsonRpcId): unknown | Promise<unknown> {
  const argv: string[] = Array.isArray(params?.command) ? params.command.map((a: any) => String(a)) : [];
  const input: Record<string, unknown> = {
    command: argv.join(" ") || "(codex did not say which command it wants to run)",
    cwd: params?.cwd ?? store.repoPath,
    ...(typeof params?.reason === "string" && params.reason.trim() ? { reason: params.reason } : {}),
  };
  const autoApprove = codexAutoApprove(store, "Bash");
  console.log(`[codex-app-server] v1 execCommandApproval id=${id} autoApprove=${autoApprove}`);
  if (autoApprove) return { decision: V1_APPROVE };
  return askUser(store, id, "Bash", input, v1Decision(store));
}

/**
 * v1 `ApplyPatchApprovalParams`. Unlike its v2 replacement it carries the patch
 * inline — `fileChanges` is a path-keyed map of `{type:"add"|"delete",content}`
 * or `{type:"update",unified_diff,move_path}` — so nothing has to be correlated.
 */
function v1PatchApproval(store: SessionStore, params: any, id: JsonRpcId): unknown | Promise<unknown> {
  const changes: FileUpdateChange[] = Object.entries(params?.fileChanges ?? {}).map(([path, change]: [string, any]) => ({
    path,
    kind: { type: change?.type, move_path: change?.move_path ?? null },
    diff: change?.type === "update" ? change?.unified_diff : change?.content,
  }));
  const reason = typeof params?.reason === "string" && params.reason.trim() ? params.reason : null;
  const { toolName, input } = describeFileChange(changes.length > 0 ? changes : undefined, String(params?.callId ?? ""));
  if (reason) input.reason = reason;

  if (params?.grantRoot != null) {
    console.log(`[codex-app-server] v1 applyPatchApproval id=${id} asks for session-wide write access under ${JSON.stringify(params.grantRoot)}`);
    return askUser(store, id, GRANT_ROOT_TOOL, {
      ...grantRootInput(params.grantRoot, reason, changes.length > 0),
      ...input,
    }, v1Decision(store));
  }

  const autoApprove = codexAutoApprove(store, toolName);
  console.log(`[codex-app-server] v1 applyPatchApproval id=${id} tool="${toolName}" autoApprove=${autoApprove}`);
  if (autoApprove) return { decision: V1_APPROVE };
  return askUser(store, id, toolName, input, v1Decision(store));
}

/**
 * Bound to the client servicing `store`, because the denial spelling is a
 * property of the server that asked — see `v1DenyFor`. Resolved now rather than
 * when the user answers: the client is alive at request time and may not be by
 * the time the browser replies.
 */
function v1Decision(store: SessionStore): (approved: boolean) => unknown {
  const deny = activeClients.get(store)?.v1Deny ?? v1DenyFor(null);
  return (approved: boolean) => ({ decision: approved ? V1_APPROVE : deny });
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
