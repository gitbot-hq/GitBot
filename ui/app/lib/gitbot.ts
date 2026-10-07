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
  // Claude Code threads: the composer's model and effort pick, stored per
  // thread so it survives a restart. Absent until the user picks.
  model?: string;
  effort?: string;
  titleIsAuto: boolean;
  repoPath: string;
  preview: string;
  messageCount: number;
  // The Jarvis thread that started this one, while it reports to it.
  reportTo?: string;
  // Jarvis threads: the approvals its children asked for, as gitbot's rows.
  approvals?: import("./approvals").ChildApproval[];
  // When a turn last ended, and when the thread was last viewed. Has news
  // while the first is later (lib/attention.ts); lastOutcome says how it ended.
  lastActivityAt?: string;
  lastSeenAt?: string;
  lastOutcome?: "done" | "failed" | "stopped";
  createdAt: string;
  updatedAt: string;
};

/** One line of the agent's own plan, as TodoWrite writes it. `activeForm` is
 *  the present-continuous wording ("Running tests"), which is what a status
 *  line wants; `content` is the imperative form, and the fallback. */
export type TodoItem = {
  content: string;
  status: string;
  activeForm: string;
};

export type HistoryBlock = {
  type: string;
  text?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** Set on a TodoWrite block only: the whole plan, as a list. */
  todos?: TodoItem[];
  tool_use_id?: string;
  /** Set on an AskUserQuestion block only: what was asked and what came back. */
  ask?: AskRecord;
  /** Set on a main-agent Agent block only (Claude Code): the sub-agent it ran.
   *  `taskId` is the live task id; `status` is absent when no end was seen. */
  subagent?: { description: string; type?: string; taskId?: string; status?: "completed" | "failed" | "stopped" };
  /** Set on a main-agent TaskCreate/TaskGet/TaskUpdate/TaskList block whose
   *  call succeeded (Claude Code): the call paired with its result. */
  task?: { tool: string; input: Record<string, any>; result: Record<string, any> };
};

/**
 * A question as its tool row carries it (src/ask-user-question.ts, AskRecord).
 * `state` is absent while no answer has been seen — the chat knows from its
 * pending questions whether one is still waiting; "none" means declined,
 * aborted, or answered with nothing.
 */
export type AskRecord = {
  questions: { header: string; question: string }[];
  /** Question text → the answer (multi-select comma-joined). */
  answers?: Record<string, string>;
  state?: "answered" | "none";
};

export type HistoryMsg = {
  role: string;
  content: HistoryBlock[];
  /** The transcript's time for the message (ISO), where the agent keeps one. */
  at?: string;
};

/** Tools the "Allow all edits" shortcut on an approval card covers
 *  (the server's allow-all-edits mode auto-approves exactly these). */
export const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

export type AskOption = { label: string; description: string };

/**
 * One question from Claude Code's AskUserQuestion, as the server sends it.
 * The server parses the tool's raw input (src/ask-user-question.ts) and puts
 * the result on the wire, so nothing here has to know the tool's own schema —
 * these fields are already normalized and present.
 */
export type AskQuestion = {
  /** Short chip label ("Auth method"); the server falls back to the question. */
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
};

/** What the client sends back: question text → the labels chosen (or the
 *  words typed under "Other"). The server turns these into the tool's own
 *  `answers` map; see POST /permission in lib/api.ts. */
export type AskAnswers = Record<string, string[]>;

export type PermRequest = {
  toolUseID: string;
  toolName: string;
  input: unknown;
  /** Set only on an AskUserQuestion the server could parse: the chat draws a
   *  question card instead of an allow/deny card. Absent otherwise. */
  questions?: AskQuestion[];
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
