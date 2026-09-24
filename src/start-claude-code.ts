import { query, type Options, type PreToolUseHookInput, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createReadStream, existsSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { readdir, stat } from "fs/promises";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import {
  emitEvent,
  scheduleCleanup,
  notifyPermissionsChanged,
  shouldAutoApprove,
  type SessionStore,
} from "./server-common";
import { bindSession } from "./bot-store";
import { presetSystemPrompt, recordSetupOutcome } from "./bot-prompt";

export async function initAgent(): Promise<boolean> {
  try {
    execSync("claude --version", { stdio: "ignore" });
    return true;
  } catch {
    console.warn("  claude CLI not found — claude-code agent unavailable");
    return false;
  }
}

export async function runAgent(store: SessionStore): Promise<void> {
  const abortController = new AbortController();
  store.abortController = abortController;

  // The SDK reports a failed spawn as a bare exit code; the child's stderr is
  // where the actual reason lives, so keep the tail of it for the error event.
  const stderrTail: string[] = [];

  try {
    let modelLogged = false;

    const lastUserEvent = [...store.events].reverse().find(e => e.type === "user_prompt");
    const promptText = (lastUserEvent?.prompt as string) ?? "";
    const attachments = lastUserEvent?.attachments as Array<{ url: string }> | undefined;

    let promptParam: string | AsyncIterable<any>;
    if (attachments && attachments.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (promptText) content.push({ type: "text", text: promptText });
      for (const att of attachments) {
        content.push({ type: "image", source: { type: "url", url: att.url } });
      }
      const sessionId = store.sdkSessionId ?? randomUUID();
      async function* multimodalPrompt() {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }
      promptParam = multimodalPrompt();
    } else {
      promptParam = promptText;
    }

    // A bot is a preset: its instructions ride on top of Claude Code's own system
    // prompt, and its tool lists constrain the run.
    const preset = store.botPreset;
    const append = presetSystemPrompt(preset);

    const q = query({
      prompt: promptParam,
      options: {
        model: store.model ?? "claude-sonnet-4-6",
        permissionMode: store.mode === "plan" ? "plan" : "default",
        abortController,
        includePartialMessages: true,
        cwd: store.repoPath,
        // The SDK loads no filesystem config by default. Opt in so the bot picks up
        // .mcp.json servers (plus CLAUDE.md and permission settings) the way the CLI does.
        settingSources: ["user", "project", "local"],
        stderr: (data: string) => {
          stderrTail.push(data);
          if (stderrTail.length > 20) stderrTail.shift();
        },
        ...(append
          ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append } }
          : {}),
        // Allowed tools are the only tools the bot has. (`allowedTools` in the SDK
        // means something else: tools that skip the permission prompt.) Whether a
        // tool needs approval stays with the permission mode.
        ...(preset?.allowedTools?.length ? { tools: preset.allowedTools } : {}),
        // `tools` only fences the built-in tools. MCP tools come in through the
        // settings loaded above, so a hook turns away anything not on the list —
        // it runs before every tool call, pre-approved ones included. An MCP tool
        // named on the list (mcp__server__tool) still passes.
        ...(preset?.allowedTools?.length ? { hooks: allowListHooks(preset.allowedTools, preset.name) } : {}),
        ...(preset?.disallowedTools?.length ? { disallowedTools: preset.disallowedTools } : {}),
        ...(store.sdkSessionId ? { resume: store.sdkSessionId } : {}),
        canUseTool: (toolName, input, { signal, toolUseID }) => {
          return new Promise((resolve) => {
            console.log(`[canUseTool] tool="${toolName}" mode="${store.permissionMode}" autoApprove=${shouldAutoApprove(store.agent, toolName, store.permissionMode)}`);
            if (shouldAutoApprove(store.agent, toolName, store.permissionMode)) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }

            store.pendingPermissions.set(toolUseID, { resolve, input, toolName, toolUseID });
            notifyPermissionsChanged();
            emitEvent(store, "permission_request", { toolUseID, toolName, input });

            signal.addEventListener("abort", () => {
              const p = store.pendingPermissions.get(toolUseID);
              if (p) {
                store.pendingPermissions.delete(toolUseID);
                notifyPermissionsChanged();
                p.resolve({ behavior: "deny", message: "Request aborted" });
              }
            }, { once: true });
          });
        },
      },
    });

    let receivedResult = false;
    // A setup run says how it went in words; the marker is what the hub reads.
    let assistantText = "";
    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          const newSdkId = (msg as any).session_id;
          if (newSdkId && !store.sdkSessionId) {
            store.sdkSessionId = newSdkId;
            // Bind the hub thread to its transcript the first time we learn the id.
            if (store.threadId) bindSession(store.threadId, newSdkId);
          }
        }

        if (msg.type === "result") receivedResult = true;

        if (!modelLogged && msg.type === "assistant" && (msg as any).message?.model) {
          modelLogged = true;
        }

        if (preset?.setup && msg.type === "assistant") {
          for (const block of (msg as any).message?.content ?? []) {
            if (block?.type === "text" && block.text) assistantText += block.text + "\n";
          }
        }

        const payload = formatMessage(msg);
        if (payload) {
          const items = Array.isArray(payload) ? payload : [payload];
          for (const item of items) {
            emitEvent(store, item.type as string, item);
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || abortController.signal.aborted) {
        console.log("[query] aborted");
        emitEvent(store, "aborted", { message: "Request aborted by user" });
      } else {
        throw err;
      }
    }

    if (preset?.setup) recordSetupOutcome(preset.id, assistantText, store.threadId);

    if (!receivedResult) {
      console.log("[query] stream ended without result message — treating as error");
      emitEvent(store, "error", { message: "Claude process exited unexpectedly" });
      store.status = "error";
      scheduleCleanup(store);
      return;
    }
  } catch (err: any) {
    console.log("[query] outer error:", err?.message, err?.stack);
    const detail = stderrTail.join("").trim();
    emitEvent(store, "error", {
      message: detail ? `${err?.message ?? "Agent failed"}\n\n${detail}` : (err?.message ?? "Unknown error"),
    });
    store.status = "error";
    scheduleCleanup(store);
    return;
  } finally {
    store.abortController = null;
    store.pendingPermissions.clear();
    notifyPermissionsChanged();
  }

  store.status = "done";
  notifyPermissionsChanged();
  emitEvent(store, "done", {});
  scheduleCleanup(store);
}

// Re-entrant: called for subsequent prompts on the same session
export async function continueAgent(store: SessionStore, prompt: string): Promise<void> {
  // Inject the prompt as a stored event for reference (not replayed to SDK)
  // Then run agent — sdkSessionId already set so SDK will resume
  store.events.push({ seq: 0, type: "user_prompt", prompt });
  store.status = "running";
  notifyPermissionsChanged();
  await runAgent(store);
}

/** Denies every tool call that is not on the bot's allow-list. */
function allowListHooks(allowedTools: string[], botName: string): Options["hooks"] {
  const allowed = new Set(allowedTools.map((t) => t.trim().toLowerCase()).filter(Boolean));
  return {
    PreToolUse: [{
      hooks: [async (input) => {
        const toolName = (input as PreToolUseHookInput).tool_name ?? "";
        if (allowed.has(toolName.toLowerCase())) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `${botName} is only allowed these tools: ${allowedTools.join(", ")}`,
          },
        };
      }],
    }],
  };
}

function formatMessage(
  msg: SDKMessage,
): Record<string, unknown> | Record<string, unknown>[] | null {
  switch (msg.type) {
    case "system":
      return { type: "system", subtype: (msg as any).subtype, data: msg };

    case "assistant": {
      const payloads: Record<string, unknown>[] = [];

      // Walk the blocks in order so the client can paint text and tool calls
      // where they actually happened; consecutive text blocks coalesce.
      let text = "";
      const flushText = () => {
        if (text) payloads.push({ type: "assistant", content: text });
        text = "";
      };
      for (const block of msg.message.content as any[]) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "tool_use") {
          flushText();
          payloads.push({
            type: "tool_use",
            tool_name: block.name,
            tool_input: formatToolInput(block.name, block.input),
          });
        }
      }
      flushText();

      return payloads.length === 1 ? payloads[0] : payloads.length > 1 ? payloads : null;
    }

    case "stream_event": {
      const event = (msg as any).event;
      if (event?.type === "content_block_start") {
        if (event.content_block?.type === "thinking") {
          return { type: "status", status: "thinking" };
        }
        if (event.content_block?.type === "tool_use") {
          return { type: "status", status: "tool", tool_name: event.content_block.name };
        }
      }
      return null;
    }

    case "tool_progress": {
      const tp = msg as any;
      return { type: "status", status: "tool", tool_name: tp.tool_name, elapsed: tp.elapsed_time_seconds };
    }

    case "tool_use_summary": {
      const ts = msg as any;
      return { type: "status", status: "tool_summary", summary: ts.summary };
    }

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
        errors: "errors" in msg ? msg.errors : undefined,
        cost: msg.total_cost_usd,
        duration_ms: msg.duration_ms,
      };

    default:
      return null;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}

// Mirrors how the Claude Code SDK locates a cwd's transcripts: CLAUDE_CONFIG_DIR
// (NFC-normalized) or ~/.claude, then "projects", then the cwd with every
// non-alphanumeric character replaced by a dash. Diverging from either half
// (e.g. leaving spaces or dots intact) makes transcripts unreadable.
function projectDir(cwd: string): string {
  const configDir = (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")).normalize("NFC");
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export async function loadTranscript(
  sessionId: string,
  cwd: string
): Promise<{ role: string; content: any[] }[]> {
  const transcriptPath = join(projectDir(cwd), `${sessionId}.jsonl`);

  // Callers only ask for sessions that have already run, so a missing file means
  // we resolved the path wrongly rather than that there is nothing to show.
  if (!existsSync(transcriptPath)) {
    console.warn(`  no claude-code transcript at ${transcriptPath} (session ${sessionId}, cwd ${cwd})`);
    return [];
  }

  const messages: { role: string; content: any[] }[] = [];

  try {
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: "utf-8" }),
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

      if (entry.type === "user" && entry.userType === "external" && !entry.isMeta) {
        const rawContent = entry.message?.content;
        const blocks: any[] = [];
        if (typeof rawContent === "string") {
          if (rawContent) blocks.push({ type: "text", text: rawContent });
        } else if (Array.isArray(rawContent)) {
          for (const b of rawContent) {
            if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
            else if (b.type === "image" && b.source?.url) blocks.push({ type: "image_url", url: b.source.url });
          }
        }
        if (blocks.length) messages.push({ role: "user", content: blocks });
      }

      if (entry.type === "assistant") {
        const rawContent = entry.message?.content;
        const blocks: any[] = [];
        if (Array.isArray(rawContent)) {
          for (const b of rawContent) {
            if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
            else if (b.type === "tool_use") {
              let tool_input: string;
              try {
                tool_input = formatToolInput(b.name, b.input);
              } catch {
                tool_input = JSON.stringify(b.input) ?? "";
              }
              blocks.push({ type: "tool_use", tool_name: b.name, tool_input });
            }
          }
        }
        if (blocks.length) messages.push({ role: "assistant", content: blocks });
      }

      if (entry.type === "result" && entry.subtype === "success" && typeof entry.result === "string" && entry.result.trim()) {
        messages.push({ role: "assistant", content: [{ type: "text", text: entry.result }] });
      }
    }

    return messages;
  } catch (err: any) {
    console.error("Error reading transcript:", err.message);
    return [];
  }
}

async function getSessionPreview(filePath: string): Promise<string> {
  try {
    try {
      const line = execFileSync("grep", ["-m1", '"custom-title"', filePath], { encoding: "utf-8" }).trim();
      const entry = JSON.parse(line);
      if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) {
        return entry.customTitle.trim();
      }
    } catch {
      // no custom-title entry found, fall through to preview
    }

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    const parts: string[] = [];
    let totalLen = 0;

    for await (const line of rl) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        (entry.type === "user" && entry.userType === "external" && !entry.isMeta) ||
        entry.type === "assistant"
      ) {
        const raw = extractText(entry.message?.content).trim();
        const text = raw.replace(/<[^>]*>/g, "").trim();
        if (!text) continue;
        parts.push(text);
        totalLen += (parts.length > 1 ? 3 : 0) + text.length;
        if (totalLen >= 80) {
          rl.close();
          break;
        }
      }
    }

    const preview = parts.join(" — ");
    return preview.length > 80 ? preview.slice(0, 80) + "..." : preview;
  } catch {
    return "";
  }
}

export async function listSessions(
  cwd: string
): Promise<{ id: string; preview: string; updatedAt: string }[]> {
  const dir = projectDir(cwd);

  if (!existsSync(dir)) return [];

  try {
    const files = await readdir(dir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    const sessionList = await Promise.all(
      jsonlFiles.map(async (f) => {
        const filePath = join(dir, f);
        const id = f.replace(/\.jsonl$/, "");
        const [preview, fileStat] = await Promise.all([
          getSessionPreview(filePath),
          stat(filePath),
        ]);
        return { id, preview, updatedAt: fileStat.mtime.toISOString() };
      })
    );

    sessionList.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessionList;
  } catch (err: any) {
    console.error("Error listing sessions:", err.message);
    return [];
  }
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return input.description
        ? `${input.description}: ${input.command}`
        : `${input.command}`;
    case "Read":
      return `${input.file_path}`;
    case "Write":
      return `${input.file_path} (${typeof input.content === "string" ? input.content.length : "?"} chars)`;
    case "Edit":
      return `${input.file_path}`;
    case "Glob":
      return input.path ? `${input.pattern} in ${input.path}` : `${input.pattern}`;
    case "Grep":
      return input.path ? `/${input.pattern}/ in ${input.path}` : `/${input.pattern}/`;
    case "Task":
      return `[${input.subagent_type}] ${input.description}`;
    case "WebFetch":
      return `${input.url}`;
    case "WebSearch":
      return `"${input.query}"`;
    case "NotebookEdit":
      return `${input.notebook_path} (${input.edit_mode || "replace"})`;
    case "TodoWrite": {
      const todos = input.todos as { content: string; status: string }[] | null | undefined;
      if (!Array.isArray(todos)) return JSON.stringify(input);
      return todos.map((t) => `[${t.status}] ${t.content}`).join(", ");
    }
    default:
      return JSON.stringify(input);
  }
}
