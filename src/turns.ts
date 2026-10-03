import { randomUUID } from "crypto";
import {
  createSession,
  sessions,
  emitEvent,
  notifyPermissionsChanged,
  type PermissionMode,
  type BotPreset,
  type SessionStore,
} from "./server-common";
import { runAgent as runClaudeCode } from "./start-claude-code";
import { runAgent as runOpencode } from "./start-opencode";
import { runAgent as runCodex } from "./start-codex";
import { resolveThreadTurn } from "./bot-routes";
import { getBot, getThread, touchThread, updateThread } from "./bot-store";

// Starting a turn: what POST /chat does once it has read the request, and what
// gitbot itself does when it starts a turn without one (Jarvis's start_thread).
// Both go through the same session path, so a server-started turn is watched,
// replayed and aborted exactly like one the browser sent.

/** What a turn is asked to run. A threadId lets the thread supply the rest. */
export interface TurnRequest {
  threadId?: string;
  prompt?: string;
  attachments?: Array<{ url: string }>;
  repoPath?: string;
  agent?: string;
  /** The session to continue, for a turn outside the bot hub. */
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  mode?: "plan" | "build";
}

export type TurnResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; message: string; extra?: Record<string, unknown> };

/**
 * How each agent runs a session. A seam: tests swap an entry for a stub so a
 * turn can be started without spawning a real agent.
 */
export const agentRunners: Record<SessionStore["agent"], (store: SessionStore) => Promise<void>> = {
  "claude-code": (s) => runClaudeCode(s),
  codex: (s) => runCodex(s),
  opencode: (s) => runOpencode(s),
};

/**
 * Validates a turn, makes or reuses its session, and sets the agent running.
 * Returns once the run has started — never waits for it to finish.
 */
export function startTurn(request: TurnRequest, availableAgents: readonly string[]): TurnResult {
  let { repoPath, agent, sessionId: existingId, model, permissionMode, mode } = request;
  const { prompt, attachments, threadId } = request;
  // attachments: Array<{ url: string }> | undefined

  // A threadId comes from the bot hub: it supplies the repo, the resume handle
  // and the bot preset, so the client need not repeat them.
  let botPreset: BotPreset | undefined;
  if (threadId) {
    const thread = getThread(threadId);
    if (!thread) return { ok: false, status: 404, message: "Thread not found" };
    const bot = getBot(thread.botId);
    if (!bot) return { ok: false, status: 404, message: "Bot not found" };
    const turn = resolveThreadTurn(thread, bot, { model, permissionMode, mode }, availableAgents);
    if (!turn.ok) return { ok: false, status: turn.status, message: turn.message, extra: turn.extra };
    ({ repoPath, agent, model, permissionMode, mode, preset: botPreset } = turn);
    if (thread.agent !== turn.agent) updateThread(threadId, { agent: turn.agent });
    existingId = thread.sdkSessionId ?? undefined;
  }

  if (!repoPath) return { ok: false, status: 400, message: "repoPath is required" };
  if (!prompt && (!attachments || attachments.length === 0)) {
    return { ok: false, status: 400, message: "prompt or attachments is required" };
  }
  if (attachments != null && (!Array.isArray(attachments) || attachments.some((a: any) => typeof a?.url !== "string" || !a.url))) {
    return { ok: false, status: 400, message: "attachments must be an array of { url: string }" };
  }
  if (agent !== "claude-code" && agent !== "opencode" && agent !== "codex") {
    return { ok: false, status: 400, message: "agent must be claude-code, opencode, or codex" };
  }
  if (!availableAgents.includes(agent)) {
    return { ok: false, status: 400, message: `Agent '${agent}' is not available` };
  }

  let store = existingId ? sessions.get(existingId) : undefined;

  // A thread's first-turn store is keyed by a random id, so the lookup above
  // misses it. Refuse a second turn on a thread that is still running rather
  // than start a parallel session (the root cause is parked:
  // docs/issues/future/first-turn-parallel-session.md).
  if (!store && threadId && [...sessions.values()].some((s) => s.threadId === threadId && s.status === "running")) {
    return { ok: false, status: 409, message: "Session is already running" };
  }

  if (store) {
    if (store.status === "running") {
      return { ok: false, status: 409, message: "Session is already running" };
    }
    // A Jarvis session's settings are fixed by its thread; a bare /chat
    // must not reach in and change them.
    if (!threadId && store.botPreset?.jarvis) {
      return { ok: false, status: 400, message: "Jarvis turns need a threadId" };
    }
    store.status = "running";
    notifyPermissionsChanged();
    store.events = [];
    store.seq = 0;
    if (model) store.model = model;
    if (mode) store.mode = mode;
    if (permissionMode) store.permissionMode = permissionMode as PermissionMode;
    if (botPreset?.jarvis) { store.model = undefined; store.mode = undefined; }
    if (threadId) { store.threadId = threadId; store.botPreset = botPreset; }
    emitEvent(store, 'user_prompt', { prompt: prompt ?? '', ...(attachments?.length ? { attachments } : {}) });
  } else {
    // A thread's first turn has no SDK session id yet, so its store is keyed
    // by a random id. Known: later turns look it up by the SDK id and miss
    // (docs/issues/future/first-turn-parallel-session.md).
    const gitbotId = existingId ?? randomUUID();
    store = createSession(gitbotId, agent, repoPath, model, mode, permissionMode as PermissionMode | undefined, { threadId, preset: botPreset });
    if (existingId) {
      store.sdkSessionId = existingId;
    }
    emitEvent(store, 'user_prompt', { prompt: prompt ?? '', ...(attachments?.length ? { attachments } : {}) });
    notifyPermissionsChanged();
  }

  const s = store;
  if (threadId) touchThread(threadId, prompt ?? '');

  // Anything thrown past runAgent's own handling would otherwise leave the
  // session pinned to "running": every later message on the thread answers
  // 409 for as long as the server lives, and the event stream — which only
  // closes on done/error/aborted — hangs the client that is watching it.
  // Each runAgent already reports its own failures and lands on "error"
  // before returning, so the status check makes this a no-op on every path
  // that handled itself.
  const onRunRejected = (err: any) => {
    console.error("[runAgent] unhandled:", err);
    if (s.status === "running") {
      emitEvent(s, "error", { message: err?.message ?? `${agent} failed to start` });
      s.status = "error";
      notifyPermissionsChanged();
    }
  };

  agentRunners[s.agent](s).catch(onRunRejected);

  return { ok: true, sessionId: s.gitbotId };
}
