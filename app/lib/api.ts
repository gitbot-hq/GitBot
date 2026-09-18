// HTTP adapter for the live GitBot server. Components never import this;
// blank/page.tsx calls it and passes plain data down as props.

// Same-origin proxy (app/api/gitbot/...) → live GitBot server.
// The browser never talks cross-origin; Node forwards server-side.
const BASE = "/api/gitbot";

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
export function postChat(threadId: string, prompt: string) {
  return req<{ sessionId: string }>("/chat", {
    method: "POST",
    body: JSON.stringify({ threadId, prompt }),
  });
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
