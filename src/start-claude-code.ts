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
import { isJarvisTool, jarvisQueryOptions, stripJarvisReminder, withJarvisReminder } from "./jarvis";
import { contextUsage, tokensInContext, DEFAULT_CLAUDE_MODEL, type ContextUsage } from "./context-window";
import { captureSupportedModels, DEFAULT_CLAUDE_EFFORT } from "./claude-models";
import { ASK_USER_QUESTION, askRecord, askResult, askUserQuestionLabel, parseAskUserQuestion, type AskRecord } from "./ask-user-question";

/**
 * How a turn reaches the SDK. A seam, like `agentRunners` in turns.ts: a test
 * swaps `run` for a stub and reads the `options` object the turn built —
 * `model`, `effort` and `resume` are only true of a run if they are in there,
 * and asserting them anywhere earlier asserts the plumbing rather than the
 * result. Not for production use: nothing but tests should replace it.
 */
export const claudeQuery: { run: typeof query } = { run: query };

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
    const shownText = (lastUserEvent?.prompt as string) ?? "";
    // Jarvis's turn reminder goes to the agent, not into the shown message.
    const promptText = store.botPreset?.jarvis ? withJarvisReminder(shownText) : shownText;
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

    // Settle the model and effort before the run so the context meter can name
    // the model and size its window correctly from the first assistant message.
    store.model = store.model ?? DEFAULT_CLAUDE_MODEL;
    store.effort = store.effort ?? DEFAULT_CLAUDE_EFFORT;

    const q = claudeQuery.run({
      prompt: promptParam,
      options: {
        // Both are sent on every turn, `resume` included, which is the whole
        // mechanism behind "a pick applies to the next turn": nothing has to be
        // pushed into the running session. Sending `effort` explicitly also
        // means a user's settings.json `effortLevel` and CLAUDE_CODE_EFFORT_LEVEL
        // no longer reach a gitbot thread — the picker is the only source.
        //
        // No `fallbackModel`: a model the account cannot run has to fail where
        // it can be seen, since the picker would otherwise keep showing a model
        // that is not the one that ran.
        model: store.model,
        effort: store.effort,
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
        // Jarvis's gitbot tools: a fresh in-process server per turn, for Jarvis only.
        ...jarvisQueryOptions(preset),
        canUseTool: (toolName, input, { signal, toolUseID }) => {
          return new Promise((resolve) => {
            // Jarvis's own tools only read gitbot's state; they never ask.
            if (preset?.jarvis && isJarvisTool(toolName)) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            console.log(`[canUseTool] tool="${toolName}" mode="${store.permissionMode}" autoApprove=${shouldAutoApprove(store.agent, toolName, store.permissionMode)}`);
            if (shouldAutoApprove(store.agent, toolName, store.permissionMode)) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }

            store.pendingPermissions.set(toolUseID, { resolve, input, toolName, toolUseID });
            notifyPermissionsChanged();
            emitEvent(store, "permission_request", permissionRequest(toolUseID, toolName, input));

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

    // The account's model list for the picker. Only a live session can be asked
    // for it, so the first turn of the process is what fills it in; awaited by
    // nobody, so a failure cannot disturb the turn.
    captureSupportedModels(q);

    let receivedResult = false;
    // The canonical model id the main thread actually ran as, learned from its
    // assistant messages. Needed to read the turn's real window back (see
    // runtimeWindow): `result.modelUsage` does not key by an alias.
    let ranAs: string | undefined;
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

        // Context meter: an assistant message reports what the request carried
        // and what it wrote — together that is what the next request will resend.
        // The result message tells us the window the SDK actually budgeted.
        // A subagent's messages carry its own window, not this session's.
        if (msg.type === "assistant" && !(msg as any).parent_tool_use_id) {
          // The canonical id the turn actually ran as, which is how `result`
          // keys its usage when an alias was configured. Kept from the main
          // thread only: a sub-agent reports whatever model it was given.
          ranAs = (msg as any).message?.model ?? ranAs;
          const used = tokensInContext((msg as any).message?.usage);
          if (used > 0) reportContext(store, used);
        } else if (msg.type === "result") {
          const window = runtimeWindow(msg, store.model, ranAs);
          reportContext(store, store.context?.used ?? 0, window);
        }

        if (!modelLogged && msg.type === "assistant" && (msg as any).message?.model) {
          modelLogged = true;
        }

        // A sub-agent's words are not the run's verdict.
        if (preset?.setup && msg.type === "assistant" && !(msg as any).parent_tool_use_id) {
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

    if (preset?.setup) recordSetupOutcome(preset.id, assistantText);

    if (!receivedResult) {
      console.log("[query] stream ended without result message — treating as error");
      emitEvent(store, "error", { message: namingModel(store, "Claude process exited unexpectedly", stderrTail) });
      store.status = "error";
      scheduleCleanup(store);
      return;
    }
  } catch (err: any) {
    console.log("[query] outer error:", err?.message, err?.stack);
    emitEvent(store, "error", {
      message: namingModel(store, err?.message ?? "Unknown error", stderrTail),
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

/**
 * The window the turn was actually held to, from the `result` message — the one
 * input that can correct `contextWindowFor`'s static table, so it is worth some
 * care to find and worth saying so when it is missing.
 *
 * `result.modelUsage` is **not** keyed by the string the turn was configured
 * with whenever that string is an alias. Measured 2026-10-07:
 *
 *     configured "default"           → keys ["claude-haiku-4-5-20251001", "claude-opus-5-5"]
 *     configured "haiku"             → keys ["claude-haiku-4-5-20251001"]
 *     configured "claude-opus-5[1m]" → keys ["claude-haiku-4-5-20251001", "claude-opus-5[1m]"]
 *
 * Three things follow. A literal id is echoed back as given, suffix and all, so
 * an exact match is tried first. An alias is replaced by the canonical id the
 * run resolved to, which is exactly what the main thread's assistant messages
 * report, so that is the second key to try — note `claude-opus-5[1m]` resolves
 * to `claude-opus-5`, so neither lookup subsumes the other. And **there is
 * almost always a Haiku entry** from Claude Code's own small-model helper work,
 * so "the only entry" and "the largest window" are both wrong.
 */
function runtimeWindow(result: SDKMessage, configured?: string, ranAs?: string): number | undefined {
  const usage = (result as any).modelUsage as Record<string, { contextWindow?: number; canonicalModel?: string }> | undefined;
  if (!usage) return undefined;
  const entry =
    (configured ? usage[configured] : undefined)
    ?? (ranAs ? usage[ranAs] : undefined)
    ?? (ranAs ? Object.values(usage).find((u) => u?.canonicalModel === ranAs) : undefined);
  const window = entry?.contextWindow;
  if (typeof window === "number" && window > 0) return window;
  // A miss leaves the meter on the static table, which is a guess that goes
  // stale silently — so say so here rather than let the two look alike.
  console.warn(
    `  context meter: no modelUsage entry for "${configured}"${ranAs && ranAs !== configured ? ` (ran as "${ranAs}")` : ""}`
    + ` — keys were [${Object.keys(usage).join(", ")}]; falling back to the static window table`,
  );
  return undefined;
}

/**
 * A failed turn's message: what went wrong, the child's own stderr, and — when
 * the failure is about the model or the effort level — what this turn asked
 * for. Nothing falls back to another model, so a rejected one has to be named
 * here or the picker would go on showing a model that never ran.
 */
function namingModel(store: SessionStore, message: string, stderrTail: string[]): string {
  const detail = stderrTail.join("").trim();
  const text = detail ? `${message}\n\n${detail}` : message;
  if (!/\bmodel\b|\beffort\b/i.test(text)) return text;
  return `${text}\n\nThis turn asked for model "${store.model}" at effort "${store.effort}".`;
}

/** A question's record for its tool row; nothing for any other tool. */
function askField(toolName: string, input: unknown): { ask?: AskRecord } {
  const ask = toolName === ASK_USER_QUESTION ? askRecord(input) : null;
  return ask ? { ask } : {};
}

/**
 * The permission_request event's payload, live and replayed alike — it is what
 * goes into store.events, so a client rejoining a turn reads the same thing.
 *
 * An AskUserQuestion carries its questions already parsed. Parsing happens
 * here, once, and only here: the browser reads the normalized array off the
 * wire and never learns the tool's own input shape. The field is absent for
 * every other tool, and for a question that does not parse, which is what
 * tells the chat to draw a plain approval card instead of a question card.
 */
export function permissionRequest(
  toolUseID: string,
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  const questions = toolName === ASK_USER_QUESTION ? parseAskUserQuestion(input) : null;
  return { toolUseID, toolName, input, ...(questions ? { questions } : {}) };
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

/**
 * Publishes how full the context window is: live to the open SSE stream,
 * and stored on the session so a reconnecting client can read it from
 * GET /sessions/:id/config.
 */
function reportContext(store: SessionStore, used: number, window?: number): void {
  if (!used && window === undefined) return;
  const next = contextUsage(used || store.context?.used || 0, store.model, window);
  const changed = JSON.stringify(next) !== JSON.stringify(store.context);
  store.context = next;
  if (changed) emitEvent(store, "context", next as unknown as Record<string, unknown>);
}

export function formatMessage(
  msg: SDKMessage,
): Record<string, unknown> | Record<string, unknown>[] | null {
  switch (msg.type) {
    case "system":
      return { type: "system", subtype: (msg as any).subtype, data: msg };

    case "assistant": {
      const payloads: Record<string, unknown>[] = [];
      // A sub-agent's message (inside a Task) carries the Task's id; keep it,
      // so the turn's own last word can be told from the sub-agent's.
      const parent = (msg as any).parent_tool_use_id;
      const from = parent ? { parent_tool_use_id: parent } : {};

      // Walk the blocks in order so the client can paint text and tool calls
      // where they actually happened; consecutive text blocks coalesce.
      let text = "";
      const flushText = () => {
        if (text) payloads.push({ type: "assistant", content: text, ...from });
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
            tool_use_id: block.id,
            // A question's row shows what was asked; its answer follows as an
            // `ask_answer` event when the user replies (see server.ts).
            ...askField(block.name, block.input),
            // The plan panel mirrors the main agent's list only: a Task
            // sub-agent keeps its own todos, and letting those through would
            // swap the plan (and its done/total) mid-turn and then swap back.
            // The sub-agent's chip still renders, like any other of its calls.
            ...(parent ? {} : todoList(block.name, block.input)),
            ...from,
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
): Promise<{ role: string; content: any[]; at?: string }[]> {
  const transcriptPath = join(projectDir(cwd), `${sessionId}.jsonl`);

  // Callers only ask for sessions that have already run, so a missing file means
  // we resolved the path wrongly rather than that there is nothing to show.
  if (!existsSync(transcriptPath)) {
    console.warn(`  no claude-code transcript at ${transcriptPath} (session ${sessionId}, cwd ${cwd})`);
    return [];
  }

  // Each message carries its transcript time (`at`) when the line has one:
  // the UI places gitbot's own rows (a child's approvals) among them by time.
  const messages: { role: string; content: any[]; at?: string }[] = [];
  // AskUserQuestion rows by tool_use_id, so the answer in a later tool_result
  // lands on the row that asked.
  const asks = new Map<string, any>();
  // Top-level Agent blocks by tool_use_id, so their result settles the row
  // that started it. Notifications are applied in order once all is read (the
  // CLI can log one ahead of the call it ends), so the last one wins: a
  // resumed sub-agent notifies again.
  const agents = new Map<string, any>();
  const notices: TaskNotification[] = [];
  const notified = (text: unknown) => {
    const n = parseTaskNotification(text);
    if (n) notices.push(n);
  };

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

      const at = typeof entry.timestamp === "string" ? { at: entry.timestamp } : {};

      if (entry.type === "user" && Array.isArray(entry.message?.content)) {
        for (const b of entry.message.content) {
          const row = b?.type === "tool_result" ? asks.get(b.tool_use_id) : undefined;
          if (row) Object.assign(row.ask, askResult(entry.toolUseResult, b.content, b.is_error === true));
          const agent = b?.type === "tool_result" ? agents.get(b.tool_use_id) : undefined;
          if (agent && settleSubagent(agent.subagent, entry, b) === "drop") {
            delete agent.subagent;
            agents.delete(b.tool_use_id);
          }
        }
      }

      // A background sub-agent's end. The CLI records it as a queued command
      // when it lands mid-turn, as a user turn of its own when it wakes the
      // agent, and as a queue entry when it is enqueued — any one will do.
      if (entry.type === "attachment" && entry.attachment?.type === "queued_command") notified(entry.attachment.prompt);
      if (entry.type === "queue-operation" && entry.operation === "enqueue") notified(entry.content);
      const notice = entry.type === "user" && (entry.origin?.kind === "task-notification" || parseTaskNotification(extractText(entry.message?.content)));
      if (notice) notified(extractText(entry.message?.content));

      // Not shown as a bubble: the CLI wrote it, not the user, and the panel
      // already shows the outcome — as the live stream, which never sends it.
      // Older CLIs mark it with no origin: then only text that opens with the
      // tag and names a task and a status counts, which no user types.
      if (entry.type === "user" && entry.userType === "external" && !entry.isMeta && !notice) {
        const rawContent = entry.message?.content;
        const blocks: any[] = [];
        if (typeof rawContent === "string") {
          const text = stripJarvisReminder(rawContent);
          if (text) blocks.push({ type: "text", text });
        } else if (Array.isArray(rawContent)) {
          for (const b of rawContent) {
            const text = b.type === "text" && b.text ? stripJarvisReminder(b.text) : "";
            if (text) blocks.push({ type: "text", text });
            else if (b.type === "image" && b.source?.url) blocks.push({ type: "image_url", url: b.source.url });
          }
        }
        if (blocks.length) messages.push({ role: "user", content: blocks, ...at });
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
              // Sidechain entries are a sub-agent's: their chips belong in the
              // transcript, but their todos must not seed the plan panel —
              // the same rule the live path applies via `parent_tool_use_id`.
              const block = {
                type: "tool_use",
                tool_name: b.name,
                tool_input,
                tool_use_id: b.id,
                ...askField(b.name, b.input),
                ...(entry.isSidechain ? {} : todoList(b.name, b.input)),
                // Only the main agent's sub-agents are rows, as live.
                ...(entry.isSidechain || entry.parent_tool_use_id ? {} : subagentField(b.name, b.input)),
              };
              if (block.ask && b.id) asks.set(b.id, block);
              if (block.subagent && b.id) agents.set(b.id, block);
              blocks.push(block);
            }
          }
        }
        if (blocks.length) messages.push({ role: "assistant", content: blocks, ...at });
      }

      if (entry.type === "result" && entry.subtype === "success" && typeof entry.result === "string" && entry.result.trim()) {
        messages.push({ role: "assistant", content: [{ type: "text", text: entry.result }], ...at });
      }
    }

    // By tool call; older CLIs name only the task, which is the agent id.
    const byTask = new Map<string, SubagentRecord>();
    for (const block of agents.values()) if (block.subagent?.taskId) byTask.set(block.subagent.taskId, block.subagent);
    for (const n of notices) {
      const rec: SubagentRecord | undefined = (n.toolUseId && agents.get(n.toolUseId)?.subagent) || (n.taskId && byTask.get(n.taskId)) || undefined;
      if (rec) rec.status = n.status;
    }
    return messages;
  } catch (err: any) {
    console.error("Error reading transcript:", err.message);
    return [];
  }
}

/**
 * How full a thread's context window is at the end of its transcript: the last
 * main-thread assistant message's usage, as the live meter reads it. For a
 * thread opened when no turn has run since gitbot started.
 *
 * `model` is the one the **next** turn will run (see `threadContext`), not
 * necessarily the one that wrote the transcript — the user may have changed the
 * pick since. That is deliberate: the meter answers "will this conversation fit
 * what it is about to run", so a thread that has outgrown a newly-picked model
 * must read over 100% rather than be quietly re-sized to something that fits.
 */
export async function loadTranscriptContext(
  sessionId: string,
  cwd: string,
  model?: string,
): Promise<ContextUsage | null> {
  const transcriptPath = join(projectDir(cwd), `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) return null;
  let used = 0;
  let seenModel: string | undefined;
  try {
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      // Cheap pre-filter: most lines are not assistant messages.
      if (!line.includes('"assistant"')) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "assistant" || entry.isSidechain) continue;
      const tokens = tokensInContext(entry.message?.usage);
      if (tokens > 0) {
        used = tokens;
        // Validated where it enters, not only where it is used. This is parsed
        // JSONL written by another process: `entry` is `any`, so TypeScript
        // never checks that `message.model` is the `string | undefined` the
        // variable claims, and anything non-string would flow on into
        // ContextUsage and out to the browser.
        const parsed = entry.message?.model;
        seenModel = typeof parsed === "string" && parsed ? parsed : undefined;
      }
    }
  } catch (err: any) {
    console.error("Error reading transcript context:", err.message);
    return null;
  }
  if (!used) return null;
  // No promotion when `used` overruns the window. That rule existed when the
  // window was 200k for every model without a [1m] suffix, so an overrun could
  // only mean the table had guessed low. The table is now per model, and the
  // model is the next turn's, so an overrun is a real reading — the thread does
  // not fit what it is set to run — and it is the same condition the picker
  // greys a short-window model out on. Hiding it here would contradict that.
  return contextUsage(used, model ?? seenModel);
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

/**
 * The plan panel needs the list as a list, not as the one-line summary the tool
 * chip shows. Carried as a separate field so the chip keeps rendering unchanged,
 * and spread in so every other tool's payload stays exactly as it was.
 */
function todoList(toolName: string, input: Record<string, unknown>): { todos?: TodoItem[] } {
  if (toolName !== "TodoWrite") return {};
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return {};
  return {
    todos: todos.map((t: any) => ({
      content: String(t?.content ?? ""),
      status: String(t?.status ?? "pending"),
      activeForm: String(t?.activeForm ?? ""),
    })),
  };
}

type TodoItem = { content: string; status: string; activeForm: string };

// --- Sub-agents in the transcript ---
// The live panel runs on task events, which the transcript never records, so
// history rebuilds each top-level sub-agent from what it does record: the
// Agent call, its tool_result, and — for one that ran in the background — the
// <task-notification> the CLI hands the main agent when it ends.

type SubagentStatus = "completed" | "failed" | "stopped";
/** On an Agent block. `status` absent: the transcript shows no end. */
type SubagentRecord = { description: string; type?: string; taskId?: string; status?: SubagentStatus };

const NOTIFIED: Record<string, SubagentStatus> = { completed: "completed", failed: "failed", stopped: "stopped", killed: "stopped" };

function subagentField(toolName: string, input: Record<string, unknown>): { subagent?: SubagentRecord } {
  if (toolName !== "Agent" && toolName !== "Task") return {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { subagent: { description: str(input.description) ?? "Sub-agent", type: str(input.subagent_type) } };
}

// A call refused before it ran: the user's rejection (the CLI's own prompt,
// or gitbot's canUseTool: "User denied", "Request aborted" on Stop) or the
// auto-mode classifier. Live, no task starts for these, so no row either.
const DENIED = /^(Error: )?(User denied|User rejected tool use|Request aborted)\b|doesn't want to proceed with this tool use|Permission for this action was denied/;

/**
 * What an Agent call's tool_result says about the run. A background launch
 * ("async_launched") only names the task; its end comes as a notification.
 * A denied call never ran and has no row; any other error is an end.
 */
function settleSubagent(rec: SubagentRecord, entry: any, block: any): "drop" | void {
  const result = entry.toolUseResult;
  const agentId = typeof result?.agentId === "string" ? result.agentId : undefined;
  if (agentId) rec.taskId = agentId;
  if (block.is_error === true) {
    const text = extractText(block.content) || (typeof result === "string" ? result : "");
    const kind = entry.toolDenialKind;
    // Cut off mid-run: "[Tool call interrupted…]" (written on resume for a
    // call left open), "[Request interrupted by user for tool use]".
    if (kind === "interrupted" || /interrupted/i.test(text)) rec.status = "stopped";
    else if ((kind && !agentId) || (!agentId && DENIED.test(text))) return "drop";
    else rec.status = "failed";
  } else if (result?.status === "completed") rec.status = "completed";
}

/** A notification names its tool call (current CLIs), its task (all), or both. */
type TaskNotification = { toolUseId?: string; taskId?: string; status: SubagentStatus };

/** A <task-notification>'s ids and outcome, if `text` is one. */
export function parseTaskNotification(text: unknown): TaskNotification | undefined {
  if (typeof text !== "string" || !text.trimStart().startsWith("<task-notification>")) return undefined;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const status = NOTIFIED[/<status>([^<]+)<\/status>/.exec(text)?.[1] ?? ""];
  return (toolUseId || taskId) && status ? { toolUseId, taskId, status } : undefined;
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
    case "Agent":
      return input.subagent_type ? `[${input.subagent_type}] ${input.description}` : `${input.description}`;
    case "WebFetch":
      return `${input.url}`;
    case "WebSearch":
      return `"${input.query}"`;
    case "NotebookEdit":
      return `${input.notebook_path} (${input.edit_mode || "replace"})`;
    // A question reads as what was asked, both live and replayed from the
    // transcript, where the chip is all that is left of it.
    case ASK_USER_QUESTION:
      return askUserQuestionLabel(input);
    case "TodoWrite": {
      const todos = input.todos as { content: string; status: string }[] | null | undefined;
      if (!Array.isArray(todos)) return JSON.stringify(input);
      return todos.map((t) => `[${t.status}] ${t.content}`).join(", ");
    }
    default:
      return JSON.stringify(input);
  }
}
