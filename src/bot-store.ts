import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";

// --- Types ---

/** Machine-local: setup is about this computer, not about the bot's definition. */
export type SetupStatus = "pending" | "complete" | "failed";

/** The coding harnesses a bot can run on. */
export const BOT_AGENTS = ["claude-code", "opencode", "codex"] as const;
export type BotAgent = (typeof BOT_AGENTS)[number];

/** Bots and threads saved before the field existed all ran on Claude Code. */
export const DEFAULT_BOT_AGENT: BotAgent = "claude-code";

/** What a built-in bot is: Jarvis, or the plain bot for one agent. */
export type BuiltinKind = BotAgent | "jarvis";

export function isBotAgent(value: unknown): value is BotAgent {
  return typeof value === "string" && (BOT_AGENTS as readonly string[]).includes(value);
}

export interface Bot {
  id: string;
  name: string;
  description: string;
  emoji: string;
  /** Appended to Claude Code's own system prompt. This is the bot's job description. */
  instructions: string;
  /** The harness this bot runs on. Undefined on older records: Claude Code. */
  agent?: BotAgent;
  /**
   * Set on bots defined in code rather than stored: "jarvis" for Jarvis, or the
   * agent a plain agent bot runs. Built-in bots are not in bots.json and cannot
   * be edited or deleted.
   */
  builtin?: BuiltinKind;
  /**
   * What this bot needs on a machine before it can work — "ffmpeg must be on
   * PATH", "run npm install in the repo". Travels with the bot when shared, and
   * is run once, on this machine, in a thread of its own. Blank means the bot
   * works anywhere and no setup run happens.
   */
  setupInstructions?: string;
  /** Where this machine stands on that setup. Undefined when there is none to do. */
  setupStatus?: SetupStatus;
  /** The thread the setup run lives in, so it can be reopened and rejoined. */
  setupThreadId?: string;
  model?: string;
  /** Default working directory for new threads. Threads may override. */
  repoPath?: string;
  permissionMode: "ask-permissions" | "auto-approve" | "plan";
  allowedTools?: string[];
  disallowedTools?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Thread {
  id: string;
  botId: string;
  /** A setup thread prepares the machine; it runs before any chat thread may. */
  kind?: "chat" | "setup";
  /**
   * The harness this thread's conversation lives in, fixed by its first turn. A
   * session id only means something to the agent that issued it, so a thread
   * keeps its agent even if the bot is later switched to another one.
   */
  agent?: BotAgent;
  /** The agent's own session id — the resume handle. Null until the first turn completes. */
  sdkSessionId: string | null;
  title: string;
  /** True while the title is still auto-derived, so a later turn may improve it. */
  titleIsAuto?: boolean;
  repoPath: string;
  preview: string;
  messageCount: number;
  /**
   * The Jarvis thread this one reports to: set when Jarvis starts it or sends
   * it a message (send_to_thread), cleared when the user types here. Threads
   * the user starts never have one.
   */
  reportTo?: string;
  /**
   * Jarvis threads only: what gitbot owes Jarvis with the user's next message
   * ("[you stopped PR Validator on Trophy]"). Prepended once, then cleared.
   */
  pendingNote?: string;
  /**
   * Jarvis threads only: the approvals its children asked for, shown as rows
   * in its conversation. Stored, not derived: once answered, an approval
   * leaves the live stream, and how it was answered is known nowhere else.
   */
  approvals?: ChildApproval[];
  /**
   * Set while a turn here runs that will report to a Jarvis thread: that
   * thread, and the gitbot process running the turn. Set when the turn
   * starts, cleared when it ends; sessions live in memory, so one still set
   * at startup, by a process no longer alive, is a child a restart
   * interrupted (restart-recovery.ts).
   */
  runningFor?: RunningMark;
  createdAt: string;
  updatedAt: string;
}

/** One approval a Jarvis-owned child asked for: a row gitbot places in the Jarvis thread. */
export interface ChildApproval {
  /** The tool request's id (toolUseID), unique per approval. */
  id: string;
  childThreadId: string;
  childBotId: string;
  /** The child's bot name when it asked. */
  bot: string;
  /** What it asked to run: the command, the file, or the tool's name. */
  tool: string;
  /** The Jarvis thread's messageCount when it asked: the row follows that many turns. */
  after: number;
  /** Unset while it waits. "dropped": the turn ended or stopped before an answer. */
  outcome?: "approved" | "denied" | "dropped";
}

export interface RunningMark {
  /** The Jarvis thread the running turn reports to. */
  owner: string;
  /** The gitbot process running it. */
  pid: number;
}

export type NewBot = Partial<Bot> & Pick<Bot, "name">;

// --- Storage ---
// Two JSON files under ~/.gitbot. Small collections, read fully and written atomically.
// All access goes through this module so the backing store can be swapped later.

// ~/.grass is the pre-rename location: keep using it when it exists and the new
// directory does not, so an upgrade doesn't orphan someone's bots and threads.
function resolveDataDir(): string {
  if (process.env.GITBOT_DATA_DIR) return process.env.GITBOT_DATA_DIR;
  if (process.env.GRASS_DATA_DIR) return process.env.GRASS_DATA_DIR;
  const current = join(homedir(), ".gitbot");
  const legacy = join(homedir(), ".grass");
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

const DATA_DIR = resolveDataDir();

/** The resolved gitbot data directory, shared by other modules that persist state. */
export function dataDir(): string {
  return DATA_DIR;
}
const BOTS_FILE = join(DATA_DIR, "bots.json");
const THREADS_FILE = join(DATA_DIR, "threads.json");

function readCollection<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    console.error(`[bot-store] could not read ${file}: ${err.message}`);
    return [];
  }
}

function writeCollection<T>(file: string, items: T[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2), "utf-8");
  renameSync(tmp, file);
}

const now = () => new Date().toISOString();

// --- Built-in bots ---
// One plain bot per agent: the agent itself, with no instructions, so a thread
// that is "just Claude Code" is still a bot thread. Defined here, never stored.

const PLAIN_AGENT_NAMES: Record<BotAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const PLAIN_AGENT_ORDER: BotAgent[] = ["claude-code", "codex", "opencode"];

const BUILTIN_EPOCH = new Date(0).toISOString();

function plainAgentBot(agent: BotAgent): Bot {
  const name = PLAIN_AGENT_NAMES[agent];
  return {
    id: `builtin-${agent}`,
    name,
    description: `${name} with no bot instructions.`,
    emoji: "🤖",
    instructions: "",
    agent,
    builtin: agent,
    permissionMode: "ask-permissions",
    createdAt: BUILTIN_EPOCH,
    updatedAt: BUILTIN_EPOCH,
  };
}

/** The plain agent bots for the agents installed on this machine. */
export function plainAgentBots(installedAgents: readonly string[]): Bot[] {
  return PLAIN_AGENT_ORDER.filter((a) => installedAgents.includes(a)).map(plainAgentBot);
}

export const JARVIS_BOT_ID = "builtin-jarvis";

/**
 * Jarvis, the manager bot. Its prompt and tools live in code (see jarvis.ts),
 * not in instructions; it always runs Claude Code on the default model, in
 * auto-approve, in its own folder under the data dir.
 */
function jarvisBot(): Bot {
  return {
    id: JARVIS_BOT_ID,
    name: "Jarvis",
    description: "Tell it what you want done; it works out which bot or agent should do it.",
    emoji: "🎩",
    instructions: "",
    agent: "claude-code",
    builtin: "jarvis",
    permissionMode: "auto-approve",
    createdAt: BUILTIN_EPOCH,
    updatedAt: BUILTIN_EPOCH,
  };
}

/** True for Jarvis's bot. */
export function isJarvisBot(bot: Pick<Bot, "builtin"> | undefined): boolean {
  return bot?.builtin === "jarvis";
}

/** Where every Jarvis thread runs, whatever folder anyone asks for. Made on demand. */
export function jarvisDir(): string {
  const dir = join(DATA_DIR, "jarvis");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** The built-in bot with this id, its agent installed here or not. */
function builtinBot(id: string): Bot | undefined {
  if (id === JARVIS_BOT_ID) return jarvisBot();
  const agent = PLAIN_AGENT_ORDER.find((a) => plainAgentBot(a).id === id);
  return agent ? plainAgentBot(agent) : undefined;
}

/** True for a bot defined in code rather than stored. */
export function isBuiltinBot(id: string): boolean {
  return builtinBot(id) !== undefined;
}

/**
 * The agent a thread runs on. A plain agent bot is its agent, whatever the
 * thread record says; any other thread keeps the agent of its first turn, and
 * older threads without one inherit the bot's.
 */
export function threadAgent(thread: Pick<Thread, "agent">, bot: Pick<Bot, "agent" | "builtin">): BotAgent {
  if (bot.builtin) return builtinAgent(bot.builtin);
  return thread.agent ?? bot.agent ?? DEFAULT_BOT_AGENT;
}

/** The agent a built-in bot is pinned to: Jarvis runs Claude Code in v1. */
export function builtinAgent(builtin: BuiltinKind): BotAgent {
  return builtin === "jarvis" ? "claude-code" : builtin;
}

// --- Bots ---

/**
 * The bots in bots.json, as bots.json may say anything: a record cannot take a
 * built-in's id, and no stored bot is built-in.
 */
function readStoredBots(): Bot[] {
  return readCollection<Bot>(BOTS_FILE)
    .filter((b) => !isBuiltinBot(b.id))
    .map(({ builtin: _builtin, ...bot }) => bot);
}

/**
 * Jarvis first, then the user's bots by name, then the built-in bots for the
 * installed agents. Jarvis is listed even while Claude Code, which it runs
 * on, is missing: it always exists, and its threads keep their place. The UI
 * reads the agent list to show that it cannot run yet.
 */
export function listBots(installedAgents: readonly string[]): Bot[] {
  const stored = readStoredBots().sort((a, b) => a.name.localeCompare(b.name));
  return [jarvisBot(), ...stored, ...plainAgentBots(installedAgents)];
}

/**
 * Any bot by id, built-in or stored. A built-in is found whether or not its
 * agent is installed, so its existing threads still resolve; running them is
 * refused elsewhere when the agent is missing.
 */
export function getBot(id: string): Bot | undefined {
  return builtinBot(id) ?? readStoredBots().find((b) => b.id === id);
}

export function createBot(input: NewBot): Bot {
  const bots = readCollection<Bot>(BOTS_FILE);
  const ts = now();
  const bot: Bot = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? "",
    emoji: input.emoji ?? "🤖",
    instructions: input.instructions ?? "",
    agent: input.agent,
    setupInstructions: input.setupInstructions,
    setupStatus: input.setupInstructions?.trim() ? "pending" : undefined,
    model: input.model,
    repoPath: input.repoPath,
    permissionMode: input.permissionMode ?? "ask-permissions",
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    createdAt: ts,
    updatedAt: ts,
  };
  bots.push(bot);
  writeCollection(BOTS_FILE, bots);
  return bot;
}

export function updateBot(id: string, patch: Partial<Bot>): Bot | undefined {
  const bots = readCollection<Bot>(BOTS_FILE);
  const idx = bots.findIndex((b) => b.id === id);
  if (idx === -1) return undefined;
  // Built-in is a property of where a bot is defined, not something a patch can claim.
  const { id: _ignored, createdAt: _created, builtin: _builtin, ...rest } = patch;
  const before = bots[idx];
  const merged: Bot = { ...before, ...rest, updatedAt: now() };

  // Setup state follows the instructions it exists for: gaining them arms a run,
  // losing them drops it, and rewriting them asks the machine to be prepared
  // again. An explicit status in the patch is the caller's own call and stands.
  const had = !!before.setupInstructions?.trim();
  const has = !!merged.setupInstructions?.trim();
  if (!has) {
    merged.setupStatus = undefined;
    merged.setupThreadId = undefined;
  } else if (rest.setupStatus === undefined) {
    if (!had || merged.setupInstructions !== before.setupInstructions) merged.setupStatus = "pending";
  }

  bots[idx] = merged;
  writeCollection(BOTS_FILE, bots);
  return bots[idx];
}

/** Deletes the bot and every thread belonging to it. */
export function deleteBot(id: string): boolean {
  const bots = readCollection<Bot>(BOTS_FILE);
  const remaining = bots.filter((b) => b.id !== id);
  if (remaining.length === bots.length) return false;
  writeCollection(BOTS_FILE, remaining);
  const threads = readCollection<Thread>(THREADS_FILE);
  writeCollection(THREADS_FILE, threads.filter((t) => t.botId !== id));
  return true;
}

// --- Setup ---

/**
 * True while this machine still owes the bot a setup run. A bot with no setup
 * instructions never owes one, so it is usable the moment it lands.
 */
export function botNeedsSetup(bot: Bot): boolean {
  return !!bot.setupInstructions?.trim() && bot.setupStatus !== "complete";
}

/**
 * The bot's setup thread, created on first ask. The thread is an ordinary
 * Claude Code conversation — only its kind and its opening prompt differ — so
 * the user can talk to it when the automatic run does not get all the way there.
 */
export function ensureSetupThread(botId: string, fallbackPath: string): Thread | undefined {
  const bot = getBot(botId);
  if (!bot || !bot.setupInstructions?.trim()) return undefined;

  const existing = bot.setupThreadId ? getThread(bot.setupThreadId) : undefined;
  if (existing) return existing;

  const thread = createThread(bot.id, bot.repoPath || fallbackPath, `Set up ${bot.name}`, "setup");
  updateBot(bot.id, { setupThreadId: thread.id, setupStatus: bot.setupStatus ?? "pending" });
  return thread;
}

export function setSetupStatus(botId: string, status: SetupStatus): Bot | undefined {
  const bot = getBot(botId);
  if (!bot || !bot.setupInstructions?.trim()) return bot;
  return updateBot(botId, { setupStatus: status });
}

// --- Threads ---

export function listThreads(botId?: string): Thread[] {
  const threads = readCollection<Thread>(THREADS_FILE);
  return threads
    .filter((t) => !botId || t.botId === botId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getThread(id: string): Thread | undefined {
  return readCollection<Thread>(THREADS_FILE).find((t) => t.id === id);
}

export function createThread(
  botId: string,
  repoPath: string,
  title?: string,
  kind: "chat" | "setup" = "chat",
  agent?: BotAgent,
  reportTo?: string,
): Thread {
  const threads = readCollection<Thread>(THREADS_FILE);
  const ts = now();
  const thread: Thread = {
    id: randomUUID(),
    botId,
    kind,
    ...(agent ? { agent } : {}),
    sdkSessionId: null,
    title: title ?? defaultTitle(repoPath),
    titleIsAuto: !title,
    repoPath,
    preview: "",
    messageCount: 0,
    ...(reportTo ? { reportTo } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  threads.push(thread);
  writeCollection(THREADS_FILE, threads);
  return thread;
}

export function updateThread(id: string, patch: Partial<Thread>): Thread | undefined {
  const threads = readCollection<Thread>(THREADS_FILE);
  const idx = threads.findIndex((t) => t.id === id);
  if (idx === -1) return undefined;
  const { id: _ignored, botId: _bot, createdAt: _created, ...rest } = patch;
  threads[idx] = { ...threads[idx], ...rest, updatedAt: now() };
  // A title the caller set by hand is the user's, not ours to overwrite.
  if (rest.title !== undefined && rest.titleIsAuto === undefined) threads[idx].titleIsAuto = false;
  writeCollection(THREADS_FILE, threads);
  return threads[idx];
}

export function deleteThread(id: string): boolean {
  const threads = readCollection<Thread>(THREADS_FILE);
  const remaining = threads.filter((t) => t.id !== id);
  if (remaining.length === threads.length) return false;
  writeCollection(THREADS_FILE, remaining);
  return true;
}

/**
 * Sets or clears the Jarvis thread a thread reports to. Ownership is not
 * activity: updatedAt stays, so the thread list keeps its order.
 */
export function setThreadOwner(id: string, reportTo: string | undefined): void {
  const threads = readCollection<Thread>(THREADS_FILE);
  const thread = threads.find((t) => t.id === id);
  if (!thread || thread.reportTo === reportTo) return;
  if (reportTo) thread.reportTo = reportTo;
  else delete thread.reportTo;
  writeCollection(THREADS_FILE, threads);
}

/**
 * Rewrites a thread's approval rows. Like ownership, not activity: updatedAt
 * stays, so the thread list keeps its order.
 */
export function setThreadApprovals(id: string, edit: (rows: ChildApproval[]) => ChildApproval[]): void {
  const threads = readCollection<Thread>(THREADS_FILE);
  const thread = threads.find((t) => t.id === id);
  if (!thread) return;
  thread.approvals = edit(thread.approvals ?? []);
  writeCollection(THREADS_FILE, threads);
}

/**
 * Marks a thread as running a turn for a Jarvis thread (owner), or unmarks
 * it. Like ownership, it is not activity: updatedAt stays. Best-effort: a
 * failed write is logged, never thrown into the turn that made it.
 */
export function setRunningFor(id: string, owner: string | undefined): void {
  try {
    const threads = readCollection<Thread>(THREADS_FILE);
    const thread = threads.find((t) => t.id === id);
    if (!thread) return;
    if (owner) {
      if (thread.runningFor?.owner === owner && thread.runningFor.pid === process.pid) return;
      thread.runningFor = { owner, pid: process.pid };
    } else {
      if (!thread.runningFor) return;
      delete thread.runningFor;
    }
    writeCollection(THREADS_FILE, threads);
  } catch (err: any) {
    console.error(`[running-mark] could not ${owner ? "mark" : "unmark"} thread ${id}: ${err?.message ?? err}`);
  }
}

/** A pending note with one more line; a line already there is not repeated. */
export function appendNote(existing: string | undefined, note: string): string {
  if (!existing) return note;
  return existing.split("\n").includes(note) ? existing : `${existing}\n${note}`;
}

/**
 * Settles the marks a gone gitbot process left behind, in one write: each
 * one's Jarvis thread gets note(thread) appended to its pendingNote, and the
 * mark is cleared. A mark held by another live gitbot on the same data dir
 * is still running, so it is left alone. Returns the threads settled.
 */
export function settleRunningMarks(
  note: (child: Thread) => string,
  isAlive: (pid: number) => boolean,
): string[] {
  const threads = readCollection<Thread>(THREADS_FILE);
  const settled: string[] = [];
  for (const thread of threads) {
    const mark = thread.runningFor;
    if (!mark) continue;
    try {
      if (mark.pid !== process.pid && isAlive(mark.pid)) continue;
      const owner = threads.find((t) => t.id === mark.owner);
      if (owner) owner.pendingNote = appendNote(owner.pendingNote, note(thread));
      delete thread.runningFor;
      settled.push(thread.id);
    } catch (err: any) {
      console.error(`[restart-recovery] thread ${thread.id}: ${err?.message ?? err}`);
    }
  }
  if (settled.length) writeCollection(THREADS_FILE, threads);
  return settled;
}

/**
 * Binds a thread to the Claude Code session that backs it. Called once, when the
 * SDK reports its session id on the first turn; that id is the resume handle.
 */
export function bindSession(id: string, sdkSessionId: string): Thread | undefined {
  const thread = getThread(id);
  if (!thread || thread.sdkSessionId) return thread;
  return updateThread(id, { sdkSessionId });
}

/**
 * Records a turn on a thread, keeping the title and preview useful in the
 * thread list.
 */
export function touchThread(id: string, prompt: string): Thread | undefined {
  const thread = getThread(id);
  if (!thread) return undefined;
  const patch: Partial<Thread> = { messageCount: thread.messageCount + 1 };
  if (prompt) {
    patch.preview = prompt.slice(0, 140);
    // Conversations open with "hi" as often as not, so keep looking for a name
    // until a turn actually says what the thread is about.
    if (thread.titleIsAuto !== false) {
      const derived = titleFromPrompt(prompt);
      if (derived) { patch.title = derived; patch.titleIsAuto = false; }
    }
  }
  return updateThread(id, patch);
}

/** A thread with no turns yet is named after the folder it will run in. */
function defaultTitle(repoPath: string): string {
  const folder = basename(repoPath || "").trim();
  return folder ? `New thread in ${folder}` : "New thread";
}

/** Prompts that name nothing: greetings, acknowledgements, nudges. */
const LOW_SIGNAL = /^(?:hi|hey|hello|yo|sup|hiya|howdy|good (?:morning|afternoon|evening)|greetings|thanks|thank you|ty|ok|okay|k|kk|cool|nice|great|got it|sure|yes|yep|yeah|no|nope|nah|continue|carry on|go on|go ahead|proceed|next|more|again|do it|please do|test|testing|ping|\?+|.)[\s!.,?]*$/i;

/** Openers that carry no meaning in a list of thread names. */
const FILLER = /^(?:hey|hi|hello|ok|okay|so|now|please|pls|can you(?: please)?|could you(?: please)?|would you(?: please)?|i want you to|i need you to|i'd like you to|let's|lets|help me|i want to|i need to)\b[\s,:-]*/i;

/**
 * Names a thread after a prompt, or returns null when the prompt says too
 * little to name anything. The aim is a label that reads well in a list: one
 * short phrase, no markdown scaffolding, no mid-word cut.
 */
function titleFromPrompt(prompt: string): string | null {
  let text = prompt
    .replace(/```[\s\S]*?```/g, " ")           // fenced code says nothing useful
    .replace(/`([^`]*)`/g, "$1")               // keep inline code, drop the ticks
    .replace(/^\s*(?:[#>*\-+]+|\d+[.)])\s*/gm, "") // markdown bullets/headings
    .replace(/\s+/g, " ")
    .trim();

  if (LOW_SIGNAL.test(text)) return null;

  // Strip leading pleasantries ("hi, can you please ..."), then cut at the
  // first sentence end.
  for (let prev = ""; prev !== text; ) { prev = text; text = text.replace(FILLER, "").trim(); }
  const sentence = text.match(/^[^.!?\n]{8,}?(?=[.!?](?:\s|$))/);
  if (sentence) text = sentence[0].trim();
  text = text.replace(/[\s,;:.\-]+$/, "");
  // Two words or a handful of characters is a fragment, not a name.
  if (text.length < 12 || text.split(" ").length < 3) return null;

  const MAX = 52;
  if (text.length > MAX) {
    const cut = text.slice(0, MAX);
    const space = cut.lastIndexOf(" ");
    text = (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-]+$/, "") + "\u2026";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
