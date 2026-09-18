import { execSync } from "child_process";
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";
import { createInterface } from "readline";
import { join, extname } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { isIP } from "net";
import type {
  Codex as CodexClass,
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  UserInput,
  Input,
} from "@openai/codex-sdk";
import {
  emitEvent,
  scheduleCleanup,
  notifyPermissionsChanged,
  notifySessionDone,
  type SessionStore,
  type PermissionMode,
} from "./server-common";
import { dataDir } from "./bot-store";

let CodexCtor: typeof CodexClass | null = null;

async function loadCodexSdk(): Promise<typeof CodexClass | null> {
  if (CodexCtor) return CodexCtor;
  try {
    const mod = await import("@openai/codex-sdk");
    CodexCtor = mod.Codex;
    return CodexCtor;
  } catch {
    return null;
  }
}

export async function initAgent(): Promise<boolean> {
  try {
    execSync("codex --version", { stdio: "ignore" });
  } catch {
    console.warn("  codex CLI not found — codex agent unavailable");
    return false;
  }
  const ctor = await loadCodexSdk();
  if (!ctor) {
    console.warn("  @openai/codex-sdk not installed — codex agent unavailable");
    return false;
  }
  return true;
}

interface PendingAttachment {
  path: string;
  basename: string;
  url: string;
}

function permissionToCodex(mode: PermissionMode): {
  approvalPolicy: ThreadOptions["approvalPolicy"];
  sandboxMode: ThreadOptions["sandboxMode"];
} {
  switch (mode) {
    case "yolo":
      return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
    case "allow-all-edits":
      return { approvalPolicy: "never", sandboxMode: "workspace-write" };
    case "ask-permissions":
    default:
      return { approvalPolicy: "on-request", sandboxMode: "read-only" };
  }
}

export async function runAgent(store: SessionStore): Promise<void> {
  const lastUserEvent = [...store.events].reverse().find(e => e.type === "user_prompt");
  const promptText = (lastUserEvent?.prompt as string) ?? "";
  const attachments = (lastUserEvent?.attachments as Array<{ url: string }> | undefined) ?? [];

  const ctor = await loadCodexSdk();
  if (!ctor) {
    emitEvent(store, "error", { message: "Codex SDK not available" });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  }

  let { approvalPolicy, sandboxMode } = permissionToCodex(store.permissionMode);
  if (store.mode === "plan") sandboxMode = "read-only";

  const baseDir = join(dataDir(), "codex-attachments");
  let attachmentDir: string;
  let isStaging = false;
  if (store.sdkSessionId) {
    attachmentDir = join(baseDir, store.sdkSessionId);
  } else {
    attachmentDir = join(baseDir, `_staging-${store.gitbotId}`);
    isStaging = true;
  }

  let downloaded: PendingAttachment[] = [];
  try {
    if (attachments.length > 0) {
      mkdirSync(attachmentDir, { recursive: true });
      downloaded = await downloadAttachments(attachmentDir, attachments);
    }
  } catch (err: any) {
    console.error("[codex] attachment download failed:", err?.message);
    emitEvent(store, "error", { message: `Attachment download failed: ${err?.message ?? "unknown"}` });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  }

  const userInput: UserInput[] = [];
  if (promptText) userInput.push({ type: "text", text: promptText });
  for (const a of downloaded) userInput.push({ type: "local_image", path: a.path });
  if (userInput.length === 0) {
    emitEvent(store, "error", { message: "prompt or attachments is required" });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  }
  const input: Input = userInput;

  const threadOpts: ThreadOptions = {
    workingDirectory: store.repoPath,
    skipGitRepoCheck: true,
    approvalPolicy,
    sandboxMode,
    ...(store.model ? { model: store.model } : {}),
  };

  let thread: Thread;
  try {
    const codex = new ctor({});
    thread = store.sdkSessionId ? codex.resumeThread(store.sdkSessionId, threadOpts) : codex.startThread(threadOpts);
  } catch (err: any) {
    emitEvent(store, "error", { message: `Failed to start codex thread: ${err?.message ?? "unknown"}` });
    store.status = "error";
    store.abortController = null;
    store.pendingPermissions.clear();
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  }

  const abortController = new AbortController();
  store.abortController = abortController;
  let receivedCompletion = false;

  try {
    console.log(`[codex] starting turn (resume=${!!store.sdkSessionId})`);
    const { events } = await thread.runStreamed(input, { signal: abortController.signal });

    try {
      for await (const ev of events) {
        handleEvent(ev, store);
        if (ev.type === "turn.completed") receivedCompletion = true;
        if (ev.type === "turn.failed" || ev.type === "error") receivedCompletion = true;
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || abortController.signal.aborted) {
        console.log("[codex] aborted");
        emitEvent(store, "aborted", { message: "Request aborted by user" });
        store.status = "done";
        receivedCompletion = true;
      } else {
        throw err;
      }
    }
  } catch (err: any) {
    console.log("[codex] outer error:", err?.message, err?.stack);
    emitEvent(store, "error", { message: err?.message ?? "Unknown error" });
    store.status = "error";
  } finally {
    if (isStaging && store.sdkSessionId) {
      const finalDir = join(baseDir, store.sdkSessionId);
      try {
        if (existsSync(finalDir)) {
          if (existsSync(attachmentDir)) {
            moveDirContents(attachmentDir, finalDir);
            try { rmSync(attachmentDir, { recursive: true, force: true }); } catch {}
          }
          if (downloaded.length > 0) appendManifest(finalDir, downloaded);
        } else if (existsSync(attachmentDir)) {
          renameSync(attachmentDir, finalDir);
          if (downloaded.length > 0) writeManifestArray(finalDir, downloaded);
        }
      } catch (err: any) {
        console.error("[codex] failed to promote staging dir:", err?.message);
      }
    } else if (!isStaging && downloaded.length > 0) {
      appendManifest(attachmentDir, downloaded);
    } else if (isStaging && !store.sdkSessionId && existsSync(attachmentDir)) {
      try {
        rmSync(attachmentDir, { recursive: true, force: true });
      } catch (err: any) {
        console.error("[codex] failed to clean up orphan staging dir:", err?.message);
      }
    }
    store.abortController = null;
    store.pendingPermissions.clear();
    notifyPermissionsChanged();
  }

  if (store.status === "error") {
    scheduleCleanup(store);
    return;
  }

  if (!receivedCompletion) {
    console.log("[codex] stream ended without completion event — treating as error");
    emitEvent(store, "error", { message: "Codex process exited unexpectedly" });
    store.status = "error";
    scheduleCleanup(store);
    return;
  }

  store.status = "done";
  notifyPermissionsChanged();
  emitEvent(store, "done", {});
  notifySessionDone(store);
  scheduleCleanup(store);
}

function handleEvent(ev: ThreadEvent, store: SessionStore): void {
  switch (ev.type) {
    case "thread.started": {
      store.sdkSessionId = ev.thread_id;
      emitEvent(store, "system", { subtype: "init", session_id: ev.thread_id });
      return;
    }
    case "turn.started":
      return;
    case "turn.completed":
      emitEvent(store, "result", { subtype: "success", usage: ev.usage });
      return;
    case "turn.failed":
      emitEvent(store, "error", { message: ev.error?.message ?? "Codex turn failed" });
      store.status = "error";
      return;
    case "error":
      emitEvent(store, "error", { message: ev.message });
      store.status = "error";
      return;
    case "item.started":
    case "item.updated":
    case "item.completed":
      handleItem(ev.type, ev.item, store);
      return;
  }
}

function handleItem(eventType: string, item: ThreadItem, store: SessionStore): void {
  switch (item.type) {
    case "agent_message": {
      if (eventType === "item.completed") {
        emitEvent(store, "assistant", { content: item.text });
      }
      return;
    }
    case "reasoning": {
      if (eventType === "item.started") {
        emitEvent(store, "status", { status: "thinking" });
      }
      return;
    }
    case "command_execution": {
      if (eventType === "item.started") {
        emitEvent(store, "tool_use", {
          tool_name: "Bash",
          tool_input: item.command,
          tool_use_id: item.id,
        });
      } else if (eventType === "item.completed") {
        emitEvent(store, "tool_result", {
          tool_use_id: item.id,
          tool_name: "Bash",
          output: item.aggregated_output ?? "",
          exit_code: item.exit_code ?? null,
          status: item.status ?? "completed",
        });
      }
      return;
    }
    case "file_change": {
      if (eventType === "item.completed") {
        for (const change of item.changes ?? []) {
          const tool = change.kind === "add" ? "Write" : "Edit";
          emitEvent(store, "tool_use", {
            tool_name: tool,
            tool_input: change.path,
            tool_use_id: item.id,
          });
        }
      }
      return;
    }
    case "web_search": {
      if (eventType === "item.completed") {
        emitEvent(store, "tool_use", {
          tool_name: "WebSearch",
          tool_input: item.query,
          tool_use_id: item.id,
        });
      }
      return;
    }
    case "todo_list": {
      if (eventType === "item.completed") {
        const items = item.items ?? [];
        const summary = items.map((t) => `[${t.completed ? "done" : "open"}] ${t.text}`).join(", ");
        emitEvent(store, "tool_use", {
          tool_name: "TodoWrite",
          tool_input: summary,
          tool_use_id: item.id,
        });
      }
      return;
    }
    case "mcp_tool_call": {
      if (eventType === "item.completed") {
        emitEvent(store, "tool_use", {
          tool_name: `mcp__${item.server}__${item.tool}`,
          tool_input: JSON.stringify(item.arguments ?? {}),
          tool_use_id: item.id,
        });
      }
      return;
    }
    case "error": {
      if (eventType === "item.completed") {
        emitEvent(store, "error", { message: item.message });
      }
      return;
    }
  }
}

async function downloadAttachments(
  dir: string,
  attachments: Array<{ url: string }>,
): Promise<PendingAttachment[]> {
  const out: PendingAttachment[] = [];
  for (const a of attachments) {
    if (!a || typeof a.url !== "string") continue;
    const result = await fetchToFile(a.url, dir);
    if (result) out.push({ path: result.path, basename: result.basename, url: a.url });
  }
  return out;
}

const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  const ipKind = isIP(host);
  if (ipKind === 4) {
    const parts = host.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (ipKind === 6) {
    const expanded = host;
    if (expanded === "::1" || expanded === "::" || expanded === "0:0:0:0:0:0:0:1" || expanded === "0:0:0:0:0:0:0:0") return false;

    let v4Parts: number[] | null = null;
    const v4MappedDotted = expanded.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4MappedDotted) {
      v4Parts = v4MappedDotted[1].split(".").map(Number);
    } else {
      const v4MappedHex = expanded.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (v4MappedHex) {
        const hi = parseInt(v4MappedHex[1], 16);
        const lo = parseInt(v4MappedHex[2], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo) && hi >= 0 && hi <= 0xffff && lo >= 0 && lo <= 0xffff) {
          v4Parts = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
        }
      }
    }
    if (v4Parts) {
      if (v4Parts.length !== 4 || v4Parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
      const [a, b] = v4Parts;
      if (a === 10) return false;
      if (a === 127) return false;
      if (a === 0) return false;
      if (a === 169 && b === 254) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      return true;
    }

    // Other ::xxxx-prefixed addresses we don't explicitly understand: block.
    if (expanded.startsWith("::")) return false;

    const first = expanded.split(":")[0];
    const firstNum = parseInt(first, 16);
    if (Number.isFinite(firstNum)) {
      // fc00::/7 — unique-local (fc00–fdff)
      if ((firstNum & 0xfe00) === 0xfc00) return false;
      // fe80::/10 — link-local (fe80–febf)
      if ((firstNum & 0xffc0) === 0xfe80) return false;
    }
    return true;
  }
  // Non-IP hostname — block bare-IP-looking-as-DNS edge cases handled above.
  return true;
}

async function fetchToFile(url: string, dir: string): Promise<{ path: string; basename: string } | null> {
  if (!isPublicHttpUrl(url)) {
    throw new Error(`refusing to fetch non-public or non-http(s) URL: ${url}`);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch ${url} returned ${res.status}`);

  const declared = res.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > ATTACHMENT_MAX_BYTES) {
      throw new Error(`attachment too large (${n} bytes > ${ATTACHMENT_MAX_BYTES}): ${url}`);
    }
  }

  let ext = extname(new URL(url).pathname);
  if (!ext) {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("png")) ext = ".png";
    else if (ct.includes("gif")) ext = ".gif";
    else if (ct.includes("webp")) ext = ".webp";
    else if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
    else ext = ".jpg";
  }

  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = (res.body as any).getReader?.();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > ATTACHMENT_MAX_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new Error(`attachment exceeded ${ATTACHMENT_MAX_BYTES} bytes: ${url}`);
        }
        chunks.push(chunk);
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > ATTACHMENT_MAX_BYTES) {
        throw new Error(`attachment exceeded ${ATTACHMENT_MAX_BYTES} bytes: ${url}`);
      }
      chunks.push(buf);
      total = buf.length;
    }
  }

  const fileName = `${randomUUID()}${ext}`;
  const filePath = join(dir, fileName);
  writeFileSync(filePath, Buffer.concat(chunks, total));
  return { path: filePath, basename: fileName };
}

function moveDirContents(src: string, dest: string): void {
  let names: string[];
  try {
    names = readdirSync(src);
  } catch {
    return;
  }
  for (const name of names) {
    const from = join(src, name);
    const to = join(dest, name);
    try {
      renameSync(from, to);
    } catch {
      // ignore individual move failures
    }
  }
}

interface ManifestEntry { filename: string; url: string }

function readManifestArray(manifestPath: string): ManifestEntry[] {
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (Array.isArray(parsed)) return parsed.filter((e) => e && typeof e.filename === "string" && typeof e.url === "string");
    return [];
  } catch {
    return [];
  }
}

function writeManifestArray(dir: string, attachments: PendingAttachment[]): void {
  const manifestPath = join(dir, "manifest.json");
  const entries: ManifestEntry[] = attachments.map((a) => ({ filename: a.basename, url: a.url }));
  writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
}

function appendManifest(dir: string, attachments: PendingAttachment[]): void {
  const manifestPath = join(dir, "manifest.json");
  const existing = readManifestArray(manifestPath);
  for (const a of attachments) existing.push({ filename: a.basename, url: a.url });
  writeFileSync(manifestPath, JSON.stringify(existing, null, 2));
}

const cwdCache = new Map<string, string | null>();
const previewCache = new Map<string, string>();

function normalizePath(p: string): string {
  let s = p.replace(/\/+$/, "") || "/";
  try {
    s = realpathSync(s);
  } catch {
    // path doesn't exist — keep the trimmed form
  }
  return s;
}

export async function listSessions(
  cwd: string,
): Promise<{ id: string; preview: string; updatedAt: string }[]> {
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  const sessionsRoot = join(homedir(), ".codex", "sessions");

  const normCache = new Map<string, string>();
  const normalize = (p: string): string => {
    const hit = normCache.get(p);
    if (hit !== undefined) return hit;
    const n = normalizePath(p);
    normCache.set(p, n);
    return n;
  };
  const normCwd = normalize(cwd);

  const entries: Array<{ id: string; preview: string; updatedAt: string }> = [];
  const seen = new Set<string>();

  if (existsSync(indexPath)) {
    try {
      const rl = createInterface({
        input: createReadStream(indexPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      const records: Array<{ id: string; thread_name?: string; updated_at?: string }> = [];
      for await (const line of rl) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec?.id) records.push(rec);
        } catch {
          // ignore malformed lines
        }
      }

      for (const rec of records) {
        seen.add(rec.id);
        let recCwd = cwdCache.get(rec.id);
        if (recCwd === undefined) {
          const filePath = await findSessionFile(rec.id);
          if (filePath) {
            const meta = await readSessionMetaAndPreview(filePath);
            recCwd = meta.cwd;
            if (recCwd !== null) cwdCache.set(rec.id, recCwd);
            if (meta.preview) previewCache.set(rec.id, meta.preview);
          } else {
            recCwd = null;
          }
        }
        if (recCwd === null) continue;
        if (normalize(recCwd) !== normCwd) continue;
        const threadName = typeof rec.thread_name === "string" ? rec.thread_name.trim() : "";
        const cachedPreview = previewCache.get(rec.id);
        const preview = threadName || cachedPreview || `${rec.id.slice(0, 8)}…`;
        entries.push({
          id: rec.id,
          preview,
          updatedAt: rec.updated_at || new Date(0).toISOString(),
        });
      }
    } catch (err: any) {
      console.error("Error reading codex session index:", err.message);
    }
  }

  // Fallback: codex CLI 0.130.0 does not always append fresh threads to the index.
  // Walk the rollout files directly so freshly-created threads still show up.
  if (existsSync(sessionsRoot)) {
    try {
      const rollouts = await collectRollouts(sessionsRoot, 200);
      for (const r of rollouts) {
        const id = extractIdFromRolloutName(r.name);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const meta = await readSessionMetaAndPreview(r.path);
        if (meta.id === null || meta.cwd === null) continue;
        cwdCache.set(meta.id, meta.cwd);
        if (meta.preview) previewCache.set(meta.id, meta.preview);
        if (normalize(meta.cwd) !== normCwd) continue;
        const cachedPreview = previewCache.get(meta.id);
        const preview = cachedPreview || `${meta.id.slice(0, 8)}…`;
        entries.push({
          id: meta.id,
          preview,
          updatedAt: new Date(r.mtimeMs).toISOString(),
        });
      }
    } catch (err: any) {
      console.error("Error walking codex sessions:", err.message);
    }
  }

  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return entries;
}

function extractIdFromRolloutName(name: string): string | null {
  // rollout-<timestamp>-<uuid>.jsonl  →  the uuid is the last 5 dash-separated chunks before .jsonl
  const m = name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

async function collectRollouts(root: string, limit: number): Promise<Array<{ path: string; name: string; mtimeMs: number }>> {
  const out: Array<{ path: string; name: string; mtimeMs: number }> = [];
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await walk(full);
      } else if (name.endsWith(".jsonl") && name.startsWith("rollout-")) {
        out.push({ path: full, name, mtimeMs: s.mtimeMs });
      }
    }
  }
  await walk(root);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

async function readSessionMetaAndPreview(
  filePath: string,
): Promise<{ id: string | null; cwd: string | null; preview: string }> {
  let id: string | null = null;
  let cwd: string | null = null;
  const parts: string[] = [];
  let totalLen = 0;
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "session_meta") {
        if (typeof entry?.payload?.cwd === "string") cwd = entry.payload.cwd;
        if (typeof entry?.payload?.id === "string") id = entry.payload.id;
        continue;
      }
      if (entry?.type === "response_item" && entry?.payload?.type === "message") {
        const role = entry.payload.role;
        if (role !== "user" && role !== "assistant") continue;
        for (const block of entry.payload.content ?? []) {
          if (
            typeof block?.text === "string" &&
            (block.type === "input_text" || block.type === "output_text" || block.type === "text")
          ) {
            const cleaned = stripEnvelopes(block.text).replace(/<[^>]*>/g, "").trim();
            if (!cleaned) continue;
            parts.push(cleaned);
            totalLen += (parts.length > 1 ? 3 : 0) + cleaned.length;
            if (totalLen >= 80) {
              rl.close();
              break;
            }
          }
        }
        if (totalLen >= 80) break;
      }
    }
    let preview = parts.join(" — ");
    if (preview.length > 80) {
      let cut = 80;
      const code = preview.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut = 79;
      preview = preview.slice(0, cut) + "...";
    }
    return { id, cwd, preview };
  } catch (err: any) {
    return { id: null, cwd: null, preview: "" };
  }
}

async function findSessionFile(threadId: string): Promise<string | null> {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  return walkForId(root, threadId);
}

async function walkForId(dir: string, id: string): Promise<string | null> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const found = await walkForId(full, id);
      if (found) return found;
    } else if (name.endsWith(`-${id}.jsonl`)) {
      return full;
    }
  }
  return null;
}

const ENVELOPE_PATTERNS: RegExp[] = [
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<image name=[^>]*>[\s\S]*?<\/image>/g,
  /<apps_instructions>[\s\S]*?<\/apps_instructions>/g,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/g,
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/g,
  /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g,
  /^# AGENTS\.md instructions for [^\n]*\n*/g,
];

// codex splits the image envelope across separate content blocks. Drop block-only markers.
const STANDALONE_MARKERS: RegExp[] = [
  /^<image name=[^>]*>$/,
  /^<\/image>$/,
];

function stripEnvelopes(text: string): string {
  let out = text;
  for (const re of ENVELOPE_PATTERNS) {
    out = out.replace(re, "");
  }
  const trimmed = out.trim();
  for (const re of STANDALONE_MARKERS) {
    if (re.test(trimmed)) return "";
  }
  return trimmed;
}

export async function loadTranscript(
  threadId: string,
  _repoPath: string,
): Promise<{ role: string; content: any[] }[]> {
  const filePath = await findSessionFile(threadId);
  if (!filePath) return [];

  const manifestPath = join(dataDir(), "codex-attachments", threadId, "manifest.json");
  let manifest: ManifestEntry[] = [];
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf-8"));
      if (Array.isArray(parsed)) {
        manifest = parsed.filter((e: any) => e && typeof e.filename === "string" && typeof e.url === "string");
      }
    } catch {
      manifest = [];
    }
  }

  let imageIdx = 0;
  const messages: { role: string; content: any[] }[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "response_item") continue;
      const payload = entry.payload;
      if (!payload || payload.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const blocks: any[] = [];
      for (const c of payload.content ?? []) {
        if (typeof c?.text === "string" && (c.type === "input_text" || c.type === "output_text" || c.type === "text")) {
          const cleaned = stripEnvelopes(c.text);
          if (cleaned) blocks.push({ type: "text", text: cleaned });
        } else if (c?.type === "input_image" || c?.type === "image") {
          const entryAt = manifest[imageIdx++];
          if (entryAt) {
            blocks.push({ type: "image_url", url: entryAt.url });
          } else {
            blocks.push({ type: "text", text: "[image]" });
          }
        }
      }
      if (blocks.length > 0) messages.push({ role, content: blocks });
    }
    return messages;
  } catch (err: any) {
    console.error("Error reading codex transcript:", err.message);
    return [];
  }
}
