// Frontend-only contract mirroring the live GitBot server.
// No fetches here — UI components take these types as props,
// so a future adapter can plug into:
//   GET / (bots), /history, /sessions, /status
//   POST /chat, /abort, /permission
// without touching components.

export type Agent = "claude" | "codex" | "opencode";

export type Bot = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  instructions: string;
  permissionMode: string;
  // Server values: "claude-code" | "codex" | "opencode" (older records
  // may predate the field and default to Claude Code server-side).
  agent: string;
  model: string;
  setupInstructions?: string;
  repoPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  setupStatus?: string;
  setupThreadId?: string;
};

export type Thread = {
  id: string;
  botId: string;
  title: string;
};

export type ThreadFull = Thread & {
  kind: string;
  sdkSessionId: string | null;
  titleIsAuto: boolean;
  repoPath: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type HistoryBlock = {
  type: string;
  text?: string;
  tool_name?: string;
  tool_input?: unknown;
};

export type HistoryMsg = {
  role: string;
  content: HistoryBlock[];
};

export type PermRequest = {
  toolUseID: string;
  toolName: string;
  input: unknown;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
