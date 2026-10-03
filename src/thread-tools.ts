import { realpathSync } from "fs";
import { basename } from "path";
import { getBot, getThread, isJarvisBot, listThreads, type BotAgent, type Thread } from "./bot-store";
import { findProject, listProjects, projectId } from "./project-index";
import { sessions, type SessionStore } from "./server-common";
import { loadTranscript as loadClaudeTranscript } from "./start-claude-code";
import { loadTranscript as loadCodexTranscript } from "./start-codex";
import { getSessionHistory as loadOpencodeHistory } from "./start-opencode";

// Jarvis's read-only view of gitbot threads: list them, ask how one stands,
// read its last few messages. Plain functions, so they can be tested without
// the SDK. Jarvis threads are never shown or read here: Jarvis does not see
// other Jarvis conversations.

// --- Transcripts ---

export type TranscriptMessage = { role: string; content: any[] };

/**
 * How each agent's transcript is read back — the same readers the thread view
 * uses. A seam: tests swap an entry for a stub.
 */
export const transcriptLoaders: Record<BotAgent, (sdkSessionId: string, repoPath: string) => Promise<TranscriptMessage[]>> = {
  "claude-code": (id, path) => loadClaudeTranscript(id, path),
  codex: (id, path) => loadCodexTranscript(id, path),
  opencode: (id, path) => loadOpencodeHistory(id, path),
};

/** A thread's messages from its agent's own transcript; none before its first turn. */
export async function loadThreadMessages(thread: Thread): Promise<TranscriptMessage[]> {
  if (!thread.sdkSessionId) return [];
  return transcriptLoaders[thread.agent ?? "claude-code"](thread.sdkSessionId, thread.repoPath);
}

// --- Caps ---

export const LIST_THREADS_CAP = 30;
export const TAIL_DEFAULT = 5;
export const TAIL_MAX = 20;
export const MESSAGE_CHARS = 2000;
export const LAST_MESSAGE_CHARS = 4000;
const TOOL_INPUT_CHARS = 200;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

/** A transcript message as plain text: its words, and a short line per tool call. */
function messageText(message: TranscriptMessage): string {
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block?.type === "text" && block.text) parts.push(String(block.text));
    else if (block?.type === "tool_use") parts.push(`[tool ${block.tool_name}: ${cap(String(block.tool_input ?? ""), TOOL_INPUT_CHARS)}]`);
    else if (block?.type === "image_url") parts.push("[image]");
  }
  return parts.join("\n");
}

/** The last assistant message that has words in it, from a transcript. */
function lastAssistantText(messages: TranscriptMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const text = (messages[i].content ?? [])
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => String(b.text))
      .join("\n");
    if (text.trim()) return text;
  }
  return undefined;
}

// --- Lookup ---

type Readable = { ok: true; thread: Thread } | { ok: false; error: string };

/** A thread Jarvis may read: it exists and is not a Jarvis thread. */
function readableThread(threadId: string): Readable {
  const thread = getThread(threadId);
  const bot = thread && getBot(thread.botId);
  if (!thread) return { ok: false, error: `no thread with id "${threadId}": use list_threads` };
  if (isJarvisBot(bot)) return { ok: false, error: "that is a Jarvis thread; you cannot read Jarvis threads" };
  return { ok: true, thread };
}

/** A folder's project id, by its resolved path, as the project index makes it. */
function folderProjectId(folder: string): string {
  try {
    return projectId(realpathSync(folder));
  } catch {
    return projectId(folder);
  }
}

// --- list_threads ---

export interface ThreadListing {
  id: string;
  title: string;
  bot: string;
  botId: string;
  project: string;
  projectId: string;
  updatedAt: string;
  /** Set when this Jarvis thread started it. */
  startedByYou?: true;
}

export type ListThreadsResult =
  | { ok: true; threads: ThreadListing[]; total: number; truncated?: true }
  | { ok: false; error: string };

/**
 * gitbot's chat threads, newest first, without Jarvis or setup threads.
 * Filtered by project id and bot id when given; at most LIST_THREADS_CAP.
 */
export async function listThreadsForJarvis(
  filter: { project?: string; bot?: string },
  jarvisThreadId?: string,
): Promise<ListThreadsResult> {
  if (filter.project && !findProject(filter.project)) {
    return { ok: false, error: `no project with id "${filter.project}": use list_projects` };
  }
  if (filter.bot) {
    const bot = getBot(filter.bot);
    if (!bot || isJarvisBot(bot)) return { ok: false, error: `no bot with id "${filter.bot}": use list_bots` };
  }

  const names = new Map<string, string>();
  try {
    for (const p of (await listProjects()).projects) names.set(p.id, p.name);
  } catch {
    // Names are a nicety: fall back to folder names.
  }

  const matching: ThreadListing[] = [];
  for (const thread of listThreads(filter.bot)) {
    if (thread.kind === "setup") continue;
    const bot = getBot(thread.botId);
    if (!bot || isJarvisBot(bot)) continue;
    const pid = folderProjectId(thread.repoPath);
    if (filter.project && pid !== filter.project) continue;
    matching.push({
      id: thread.id,
      title: thread.title,
      bot: bot.name,
      botId: bot.id,
      project: names.get(pid) ?? basename(thread.repoPath),
      projectId: pid,
      updatedAt: thread.updatedAt,
      ...(jarvisThreadId && thread.reportTo === jarvisThreadId ? { startedByYou: true as const } : {}),
    });
  }
  const threads = matching.slice(0, LIST_THREADS_CAP);
  return {
    ok: true,
    threads,
    total: matching.length,
    ...(matching.length > threads.length ? { truncated: true as const } : {}),
  };
}

// --- thread_status ---

export type ThreadState = "running" | "waiting on approval" | "done" | "failed" | "stopped" | "idle";

/** The live session for a thread: a running one if there is one, else the newest. */
export function liveStoreFor(threadId: string): SessionStore | undefined {
  let latest: SessionStore | undefined;
  for (const store of sessions.values()) {
    if (store.threadId !== threadId) continue;
    if (store.status === "running") return store;
    latest = store; // insertion order: later stores are newer turns
  }
  return latest;
}

/** How a session's state reads to Jarvis. A turn the user aborted is stopped, not failed. */
export function sessionState(store: SessionStore): ThreadState {
  if (store.pendingPermissions.size > 0) return "waiting on approval";
  if (store.status === "running") return "running";
  if (store.events.some((e) => e.type === "aborted")) return "stopped";
  return store.status === "error" ? "failed" : "done";
}

/** The last top-level assistant message of the session's current turn. */
function lastEventText(store: SessionStore): string | undefined {
  for (let i = store.events.length - 1; i >= 0; i--) {
    const e = store.events[i] as any;
    if (e.type === "assistant" && !e.parent_tool_use_id && String(e.content ?? "").trim()) return String(e.content);
  }
  return undefined;
}

export type ThreadStatusResult =
  | {
      ok: true;
      threadId: string;
      title: string;
      bot: string;
      status: ThreadState;
      /** Present when idle: why there is no live state. */
      note?: string;
      /** The tools waiting on the user's approval. */
      waitingOn?: string[];
      /** The failure, when the turn failed. */
      error?: string;
      lastMessage?: string;
    }
  | { ok: false; error: string };

export async function threadStatus(threadId: string): Promise<ThreadStatusResult> {
  const found = readableThread(threadId);
  if (!found.ok) return found;
  const { thread } = found;
  const bot = getBot(thread.botId);
  const store = liveStoreFor(thread.id);

  let lastMessage = store && lastEventText(store);
  if (!lastMessage) {
    try {
      lastMessage = lastAssistantText(await loadThreadMessages(thread));
    } catch {
      // No transcript to read: report the status alone.
    }
  }

  const base = { ok: true as const, threadId: thread.id, title: thread.title, bot: bot?.name ?? thread.botId };
  const last = lastMessage ? { lastMessage: cap(lastMessage, LAST_MESSAGE_CHARS) } : {};
  if (!store) {
    return {
      ...base,
      status: "idle",
      note: "no turn has run in this thread since gitbot started, so its outcome is unknown; it is not running",
      ...last,
    };
  }
  const status = sessionState(store);
  const waitingOn = status === "waiting on approval" ? [...store.pendingPermissions.values()].map((p) => p.toolName) : undefined;
  const errorEvent = status === "failed" ? [...store.events].reverse().find((e) => e.type === "error") : undefined;
  return {
    ...base,
    status,
    ...(waitingOn ? { waitingOn } : {}),
    ...(errorEvent ? { error: cap(String((errorEvent as any).message ?? ""), 500) } : {}),
    ...last,
  };
}

// --- read_thread_tail ---

export type ThreadTailResult =
  | { ok: true; threadId: string; title: string; messages: { role: string; text: string }[]; total: number }
  | { ok: false; error: string };

/** The last n messages (at most TAIL_MAX) of a thread's transcript, each capped. */
export async function readThreadTail(threadId: string, n: number = TAIL_DEFAULT): Promise<ThreadTailResult> {
  const found = readableThread(threadId);
  if (!found.ok) return found;
  const { thread } = found;
  const count = Math.max(1, Math.min(TAIL_MAX, Math.floor(Number.isFinite(n) ? n : TAIL_DEFAULT)));
  let all: TranscriptMessage[];
  try {
    all = await loadThreadMessages(thread);
  } catch (err: any) {
    return { ok: false, error: `could not read the thread's transcript: ${err?.message ?? err}` };
  }
  const messages = all
    .map((m) => ({ role: m.role, text: cap(messageText(m), MESSAGE_CHARS) }))
    .filter((m) => m.text)
    .slice(-count);
  return { ok: true, threadId: thread.id, title: thread.title, messages, total: all.length };
}
