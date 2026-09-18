import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";

// --- Types ---

/** Machine-local: setup is about this computer, not about the bot's definition. */
export type SetupStatus = "pending" | "complete" | "failed";

export interface Bot {
  id: string;
  name: string;
  description: string;
  emoji: string;
  /** Appended to Claude Code's own system prompt. This is the bot's job description. */
  instructions: string;
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
  /** Claude Code session id — the resume handle. Null until the first turn completes. */
  sdkSessionId: string | null;
  title: string;
  /** True while the title is still auto-derived, so a later turn may improve it. */
  titleIsAuto?: boolean;
  repoPath: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
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

// --- Bots ---

export function listBots(): Bot[] {
  return readCollection<Bot>(BOTS_FILE).sort((a, b) => a.name.localeCompare(b.name));
}

export function getBot(id: string): Bot | undefined {
  return readCollection<Bot>(BOTS_FILE).find((b) => b.id === id);
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
  const { id: _ignored, createdAt: _created, ...rest } = patch;
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
  kind: "chat" | "setup" = "chat"
): Thread {
  const threads = readCollection<Thread>(THREADS_FILE);
  const ts = now();
  const thread: Thread = {
    id: randomUUID(),
    botId,
    kind,
    sdkSessionId: null,
    title: title ?? defaultTitle(repoPath),
    titleIsAuto: !title,
    repoPath,
    preview: "",
    messageCount: 0,
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
