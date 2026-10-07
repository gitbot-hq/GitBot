// HTTP adapter for the live GitBot server. The CLI serves this exported UI
// and the API from one origin, so requests stay relative to the current host.
const BASE = "";

export type SessionPermissionMode = "ask-permissions" | "allow-all-edits" | "yolo";

export class ApiError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & Record<string, unknown>;
  if (!res.ok || body.error) {
    const { error, ...extra } = body;
    throw new ApiError(
      res.status,
      error ?? `Request failed (${res.status})`,
      extra,
    );
  }
  return body as T;
}

export function getAgents() {
  return req<{ agents: string[] }>("/agents");
}

export function getBots() {
  return req<{ bots: import("./gitbot").Bot[] }>("/bots");
}

/** One bot's threads, or every thread when no bot is given. */
export function getThreads(botId?: string) {
  return req<{ threads: import("./gitbot").ThreadFull[] }>(
    botId ? `/threads?botId=${encodeURIComponent(botId)}` : "/threads",
  );
}

export function getThread(threadId: string) {
  return req<{ thread: import("./gitbot").ThreadFull }>(`/threads/${encodeURIComponent(threadId)}`);
}

export function getMessages(threadId: string) {
  return req<{ messages: import("./gitbot").HistoryMsg[]; context?: ContextUsage | null }>(
    `/threads/${encodeURIComponent(threadId)}/messages`,
  );
}

export function createThread(botId: string, repoPath?: string, agent?: string) {
  return req<{ thread: import("./gitbot").ThreadFull }>("/threads", {
    method: "POST",
    body: JSON.stringify({
      botId,
      ...(repoPath ? { repoPath } : {}),
      ...(agent ? { agent } : {}),
    }),
  });
}

export type BrowseResult = {
  path: string;
  parent: string | null;
  workspace: string;
  home: string;
  dirs: { name: string; path: string }[];
};

/** Subdirectories of `path` for the folder picker. Omit it to start at
 *  the server's directory. Mirrors GET /browse on the live server. */
export function browse(path?: string | null) {
  return req<BrowseResult>(
    path ? `/browse?path=${encodeURIComponent(path)}` : "/browse",
  );
}

/** What the chat's permission menu offers: the server's three session
 *  modes as-is, plus "plan" — yolo with the agent held to planning. */
export type ChatPermissionMode = SessionPermissionMode | "plan";

/** Starts a turn. Returns the session id to stream + abort + approve on.
 *  `model`/`effort` are Claude Code's and are sent on every turn the picker
 *  applies to: the thread record carries the same pick, and sending it here as
 *  well means a pick made moments before Send cannot lose the race with its
 *  own save. */
export function postChat(
  threadId: string,
  prompt: string,
  permissionMode: ChatPermissionMode,
  claude?: { model?: string; effort?: string },
) {
  return req<{ sessionId: string }>("/chat", {
    method: "POST",
    body: JSON.stringify({
      threadId,
      prompt,
      permissionMode: permissionMode === "plan" ? "yolo" : permissionMode,
      mode: permissionMode === "plan" ? "plan" : "build",
      ...(claude?.model ? { model: claude.model } : {}),
      ...(claude?.effort ? { effort: claude.effort } : {}),
    }),
  });
}

/** The account's Claude Code models, or `models: null` while no session has run
 *  in this gitbot process and nothing has been able to ask for them. */
export function getClaudeModels() {
  return req<{
    models: import("./claude-models").ClaudeModelInfo[] | null;
    effortLevels: string[];
    defaultEffort: string;
  }>("/claude-models");
}

/** Saves the thread's model and effort pick. Applies from its next turn. */
export function patchThread(threadId: string, patch: { model?: string; effort?: string }) {
  return req<{ thread: import("./gitbot").ThreadFull }>(`/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function patchPermissionMode(sessionId: string, permissionMode: SessionPermissionMode) {
  return req<{ sessionId: string; permissionMode: SessionPermissionMode }>(
    `/sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: JSON.stringify({ permissionMode }) },
  );
}

export interface ContextUsage {
  used: number;
  window: number;
  model: string;
  label: string;
}

export function getSessionConfig(sessionId: string) {
  return req<{ permissionMode: SessionPermissionMode; mode?: string | null; model?: string | null; effort?: string | null; context?: ContextUsage | null }>(
    `/sessions/${encodeURIComponent(sessionId)}/config`,
  );
}

/** `answers` is for AskUserQuestion only (question text → the labels chosen
 *  or the words typed). The server turns it into the shape that tool reads;
 *  every other approval is just approved or not. */
export function postPermission(
  sessionId: string,
  toolUseID: string,
  approved: boolean,
  answers?: Record<string, string[]>,
) {
  return req<{ ok: boolean }>(
    `/sessions/${encodeURIComponent(sessionId)}/permission`,
    { method: "POST", body: JSON.stringify({ toolUseID, approved, ...(answers ? { answers } : {}) }) },
  );
}

export function postAbort(sessionId: string) {
  return req<{ ok: boolean }>(
    `/sessions/${encodeURIComponent(sessionId)}/abort`,
    { method: "POST" },
  );
}

export type BotInput = {
  name: string;
  emoji?: string;
  description?: string;
  agent?: string;
  instructions?: string;
  setupInstructions?: string;
  repoPath?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
};

export function createBot(body: BotInput) {
  return req<{ bot: import("./gitbot").Bot; setupThread?: unknown }>("/bots", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function patchBot(id: string, body: BotInput) {
  return req<{ bot: import("./gitbot").Bot; setupThread?: unknown }>(
    `/bots/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export function deleteBot(id: string) {
  return req<{ deleted: boolean }>(`/bots/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function deleteThread(id: string) {
  return req<{ deleted: boolean }>(`/threads/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Marks a thread viewed, clearing its "has news" on every device. */
export function markThreadSeen(id: string) {
  return req<{ thread: import("./gitbot").ThreadFull }>(`/threads/${encodeURIComponent(id)}/seen`, {
    method: "POST",
  });
}

export function botSetupAction(id: string, action: "complete" | "reset" | "fail") {
  return req<{ bot: import("./gitbot").Bot; setupThread?: unknown }>(
    `/bots/${encodeURIComponent(id)}/setup`,
    { method: "POST", body: JSON.stringify({ action }) },
  );
}

export function getSessionStatus(sessionId: string) {
  return req<{ streaming: boolean; sdkSessionId: string | null; gitbotId?: string; seq?: number; pending?: string[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/status`,
  );
}

export function getPendingPermissions(sessionId: string) {
  return req<{ pending: string[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/permissions`,
  );
}

/** Every session's status, pushed on each change (and pending approvals). */
export function sessionsStreamUrl() {
  return `${BASE}/permissions/events`;
}

export function streamUrl(sessionId: string) {
  return `${BASE}/events?sessionId=${encodeURIComponent(sessionId)}`;
}
