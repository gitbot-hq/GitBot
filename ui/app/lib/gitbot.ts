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
  // Set on the bots the server defines in code: "jarvis", or a plain agent
  // bot's agent ("claude-code", "codex", "opencode"). Not editable, deletable
  // or shareable.
  builtin?: string;
};

/** Jarvis's fixed id (see src/bot-store.ts). */
export const JARVIS_BOT_ID = "builtin-jarvis";

export type Thread = {
  id: string;
  botId: string;
  title: string;
};

export type ThreadFull = Thread & {
  // Omitted when the thread inherits the bot's configured coding agent.
  agent?: string;
  kind: string;
  sdkSessionId: string | null;
  titleIsAuto: boolean;
  repoPath: string;
  preview: string;
  messageCount: number;
  // The Jarvis thread that started this one, while it reports to it.
  reportTo?: string;
  // Jarvis threads: the approvals its children asked for, as gitbot's rows.
  approvals?: import("./approvals").ChildApproval[];
  // Jarvis threads: when a turn last ended, and when it was last viewed.
  // Has news while the first is later (lib/attention.ts).
  lastActivityAt?: string;
  lastSeenAt?: string;
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

/** Tools the "Allow all edits" shortcut on an approval card covers
 *  (the server's allow-all-edits mode auto-approves exactly these). */
export const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

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
