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

// A running session's permission mode (server: PermissionMode). Bots store
// their own vocabulary ("ask-permissions" | "auto-approve" | "plan"); this
// mirrors the server's botPermissionToSession translation.
export type SessionPermissionMode = "ask-permissions" | "allow-all-edits" | "yolo";

export const PERMISSION_MODES: { value: SessionPermissionMode; label: string }[] = [
  { value: "ask-permissions", label: "Ask every time" },
  { value: "allow-all-edits", label: "Auto-approve edits" },
  { value: "yolo", label: "Auto-approve all" },
];

export const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

export function botPermissionToSession(botMode: string | undefined): SessionPermissionMode {
  return botMode === "auto-approve" || botMode === "plan" ? "yolo" : "ask-permissions";
}
