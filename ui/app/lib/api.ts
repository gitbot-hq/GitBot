// HTTP adapter for the live GitBot server. Components never import this;
// the pages call it and pass plain data down as props.

import type { SessionPermissionMode } from "./gitbot";

// Same origin: the gitbot server serves this UI and the API from one port,
// so every path below is relative to wherever the page was loaded from.
const BASE = "";

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

// The agents actually installed on the machine gitbot runs on, in the
// server's order of preference.
export function getAgents() {
  return req<{ agents: string[] }>("/agents");
}

export function getBots() {
  return req<{ bots: import("./gitbot").Bot[] }>("/bots");
}

export function getThreads(botId: string) {
  return req<{ threads: import("./gitbot").ThreadFull[] }>(
    `/threads?botId=${encodeURIComponent(botId)}`,
  );
}

export function getMessages(threadId: string) {
  return req<{ messages: import("./gitbot").HistoryMsg[] }>(
    `/threads/${encodeURIComponent(threadId)}/messages`,
  );
}

export function createThread(botId: string, repoPath?: string) {
  return req<{ thread: import("./gitbot").ThreadFull }>("/threads", {
    method: "POST",
    body: JSON.stringify(
      repoPath ? { botId, repoPath } : { botId },
    ),
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

/** Starts a turn. Returns the session id to stream + abort + approve on. */
// permissionMode is only sent when the user overrode the bot's default for
// this thread; otherwise the server applies the bot's own setting.
export function postChat(
  threadId: string,
  prompt: string,
  permissionMode?: SessionPermissionMode,
) {
  return req<{ sessionId: string }>("/chat", {
    method: "POST",
    body: JSON.stringify({ threadId, prompt, ...(permissionMode ? { permissionMode } : {}) }),
  });
}

// Switch a session's permission mode. Works mid-turn: the server also
// resolves any approvals already waiting that the new mode covers.
export function patchPermissionMode(sessionId: string, permissionMode: SessionPermissionMode) {
  return req<{ sessionId: string; permissionMode: SessionPermissionMode }>(
    `/sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: JSON.stringify({ permissionMode }) },
  );
}

export function getSessionConfig(sessionId: string) {
  return req<{ permissionMode: SessionPermissionMode }>(
    `/sessions/${encodeURIComponent(sessionId)}/config`,
  );
}

export function postPermission(
  sessionId: string,
  toolUseID: string,
  approved: boolean,
) {
  return req<{ ok: boolean }>(
    `/sessions/${encodeURIComponent(sessionId)}/permission`,
    { method: "POST", body: JSON.stringify({ toolUseID, approved }) },
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
  // No form field: only arrives through an imported share code.
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

// The agent's own transcript stays on disk; only the hub's record goes.
export function deleteThread(id: string) {
  return req<{ deleted: boolean }>(`/threads/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function deleteBot(id: string) {
  return req<{ deleted: boolean }>(`/bots/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function botSetupAction(id: string, action: "complete" | "reset" | "fail") {
  return req<{ bot: import("./gitbot").Bot; setupThread?: unknown }>(
    `/bots/${encodeURIComponent(id)}/setup`,
    { method: "POST", body: JSON.stringify({ action }) },
  );
}

export function getSessionStatus(sessionId: string) {
  return req<{ streaming: boolean; sdkSessionId: string | null }>(
    `/sessions/${encodeURIComponent(sessionId)}/status`,
  );
}

export function getPendingPermissions(sessionId: string) {
  return req<{ pending: string[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/permissions`,
  );
}

export function streamUrl(sessionId: string) {
  return `${BASE}/events?sessionId=${encodeURIComponent(sessionId)}`;
}
