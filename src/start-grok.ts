import { spawn, execSync, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { bindSession } from "./bot-store";
import { presetSystemPrompt, recordSetupOutcome } from "./bot-prompt";
import { emitEvent, notifyPermissionsChanged, scheduleCleanup, type SessionStore } from "./server-common";

/**
 * Headless `grok -p` has no channel back to the hub, so a permission mode is a
 * CLI flag chosen once per turn:
 * - plan refuses edits (the turn ends `cancelled` if it tries to write);
 * - ask-permissions is `--permission-mode default`: reads run, writes are
 *   refused, and nothing is shown as an approval in the hub;
 * - auto-approve is `--always-approve`, which is what lets a turn edit files.
 */
export function grokArgs(opts: {
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string | null;
  mode?: "plan" | "build";
  permissionMode: SessionStore["permissionMode"];
  rules?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}): string[] {
  const args = [
    "-p", opts.prompt,
    "--cwd", opts.cwd,
    "--output-format", "streaming-messages-json",
    "--no-alt-screen",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.mode === "plan") args.push("--permission-mode", "plan");
  else if (opts.permissionMode === "yolo") args.push("--always-approve");
  else args.push("--permission-mode", "default");
  if (opts.rules) args.push("--rules", opts.rules);
  if (opts.allowedTools?.length) args.push("--tools", opts.allowedTools.join(","));
  if (opts.disallowedTools?.length) args.push("--disallowed-tools", opts.disallowedTools.join(","));
  return args;
}

export function grokSessionDir(home: string, cwd: string): string {
  const resolved = existsSync(cwd) ? realpathSync(cwd) : cwd;
  return join(home, ".grok", "sessions", encodeURIComponent(resolved));
}

/** Pull the text the user actually typed out of a Grok history entry. */
export function userQueryText(content: unknown): string | null {
  const text = contentText(content);
  if (!text) return null;
  const tagged = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (tagged) return tagged[1].trim() || null;
  if (text.trimStart().startsWith("<")) return null;
  return text.trim() || null;
}

export function messagesFromHistory(raw: string): { role: string; content: { type: string; text?: string }[] }[] {
  const messages: { role: string; content: { type: string; text?: string }[] }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; content?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "assistant") {
      const text = contentText(entry.content);
      if (text) messages.push({ role: "assistant", content: [{ type: "text", text }] });
      continue;
    }
    if (entry.type === "user") {
      const text = userQueryText(entry.content);
      if (text) messages.push({ role: "user", content: [{ type: "text", text }] });
    }
  }
  return messages;
}

export async function initAgent(): Promise<boolean> {
  try {
    execSync("grok --version", { stdio: "ignore" });
    return true;
  } catch {
    console.warn("  grok CLI not found — grok agent unavailable");
    return false;
  }
}

export async function runAgent(store: SessionStore): Promise<void> {
  const abortController = new AbortController();
  store.abortController = abortController;
  const stderrTail: string[] = [];
  let child: ChildProcess | null = null;
  let receivedResult = false;
  let assistantText = "";

  try {
    const lastUserEvent = [...store.events].reverse().find((e) => e.type === "user_prompt");
    const promptText = String(lastUserEvent?.prompt ?? "");
    const attachments = lastUserEvent?.attachments as { url: string }[] | undefined;
    const prompt = attachments?.length
      ? `${promptText}\n\nAttached files:\n${attachments.map((a) => a.url).join("\n")}`.trim()
      : promptText;
    const preset = store.botPreset;
    const args = grokArgs({
      prompt,
      cwd: store.repoPath,
      model: store.model,
      sessionId: store.sdkSessionId,
      mode: store.mode,
      permissionMode: store.permissionMode,
      rules: presetSystemPrompt(preset),
      allowedTools: preset?.allowedTools,
      disallowedTools: preset?.disallowedTools,
    });

    child = spawn("grok", args, { cwd: store.repoPath, stdio: ["ignore", "pipe", "pipe"] });
    const proc = child;
    abortController.signal.addEventListener("abort", () => {
      proc.kill("SIGTERM");
    }, { once: true });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail.push(chunk.toString());
      if (stderrTail.length > 20) stderrTail.shift();
    });

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const closed = new Promise<number | null>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code));
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "system" && msg.subtype === "init") {
        const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
        if (sessionId && !store.sdkSessionId) {
          store.sdkSessionId = sessionId;
          if (store.threadId) bindSession(store.threadId, sessionId);
        }
      }
      if (msg.type === "result") receivedResult = true;
      if (preset?.setup && msg.type === "assistant") {
        assistantText += assistantTextOf(msg);
      }
      const payload = formatGrokMessage(msg);
      if (!payload) continue;
      for (const item of Array.isArray(payload) ? payload : [payload]) {
        emitEvent(store, item.type as string, item);
      }
    }

    const code = await closed;
    if (abortController.signal.aborted) {
      emitEvent(store, "aborted", { message: "Request aborted by user" });
      store.status = "done";
      scheduleCleanup(store);
      return;
    }
    if (preset?.setup) recordSetupOutcome(preset.id, assistantText);
    if (!receivedResult) {
      const detail = stderrTail.join("").trim();
      const message = detail || `grok exited with code ${code ?? "unknown"}`;
      emitEvent(store, "error", { message });
      store.status = "error";
      notifyPermissionsChanged();
      scheduleCleanup(store);
      return;
    }
  } catch (err: any) {
    if (abortController.signal.aborted) {
      emitEvent(store, "aborted", { message: "Request aborted by user" });
      store.status = "done";
      scheduleCleanup(store);
      return;
    }
    const detail = stderrTail.join("").trim();
    emitEvent(store, "error", {
      message: detail ? `${err?.message ?? "Agent failed"}\n\n${detail}` : (err?.message ?? "Unknown error"),
    });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
    return;
  } finally {
    store.abortController = null;
    store.pendingPermissions.clear();
  }

  store.status = "done";
  notifyPermissionsChanged();
  emitEvent(store, "done", {});
  scheduleCleanup(store);
}

export async function loadTranscript(
  sessionId: string,
  cwd: string,
): Promise<{ role: string; content: { type: string; text?: string }[] }[]> {
  const file = join(grokSessionDir(homedir(), cwd), sessionId, "chat_history.jsonl");
  if (!existsSync(file)) return [];
  return messagesFromHistory(readFileSync(file, "utf-8"));
}

export async function listSessions(
  cwd: string,
): Promise<{ id: string; preview: string; updatedAt: string }[]> {
  const dir = grokSessionDir(homedir(), cwd);
  if (!existsSync(dir)) return [];
  const sessions = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const history = join(dir, entry.name, "chat_history.jsonl");
      if (!existsSync(history)) return null;
      const preview = messagesFromHistory(readFileSync(history, "utf-8"))
        .find((message) => message.role === "user")
        ?.content[0]?.text?.slice(0, 80) ?? "";
      return { id: entry.name, preview, updatedAt: statSync(history).mtime.toISOString() };
    })
    .filter((session): session is { id: string; preview: string; updatedAt: string } => session !== null);
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}

export function formatGrokMessage(
  msg: Record<string, unknown>,
): Record<string, unknown> | Record<string, unknown>[] | null {
  switch (msg.type) {
    case "system":
      return { type: "system", subtype: msg.subtype, data: msg };
    case "assistant":
      return formatAssistant(msg);
    case "result":
      if (msg.subtype === "success") {
        return {
          type: "result",
          subtype: "success",
          result: msg.result,
          cost: msg.total_cost_usd,
          duration_ms: msg.duration_ms,
          num_turns: msg.num_turns,
        };
      }
      return {
        type: "result",
        subtype: msg.subtype,
        errors: msg.errors,
        cost: msg.total_cost_usd,
        duration_ms: msg.duration_ms,
      };
    default:
      return null;
  }
}

function formatAssistant(msg: Record<string, unknown>): Record<string, unknown> | Record<string, unknown>[] | null {
  const message = msg.message as { content?: unknown } | undefined;
  const content = message?.content ?? msg.content;
  if (!Array.isArray(content)) {
    const text = contentText(content);
    return text ? { type: "assistant", content: text } : null;
  }
  const payloads: Record<string, unknown>[] = [];
  let text = "";
  const flush = () => {
    if (text) payloads.push({ type: "assistant", content: text });
    text = "";
  };
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: string; text?: string; name?: string; input?: unknown };
    if (typed.type === "text" && typed.text) text += typed.text;
    else if (typed.type === "tool_use") {
      flush();
      payloads.push({ type: "tool_use", tool_name: typed.name, tool_input: typed.input });
    }
  }
  flush();
  if (payloads.length === 1) return payloads[0];
  return payloads.length > 1 ? payloads : null;
}

function assistantTextOf(msg: Record<string, unknown>): string {
  const formatted = formatAssistant(msg);
  const items = formatted ? (Array.isArray(formatted) ? formatted : [formatted]) : [];
  return items
    .filter((item) => item.type === "assistant")
    .map((item) => String(item.content ?? ""))
    .join("");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => !!block && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}
