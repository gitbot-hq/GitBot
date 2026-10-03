import { createSdkMcpServer, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  BOT_AGENTS,
  botNeedsSetup,
  createThread,
  deleteThread,
  getBot,
  getThread,
  isJarvisBot,
  listBots,
  threadAgent,
  type Bot,
  type BotAgent,
} from "./bot-store";
import { addProject, findProject, getProjects, listProjects } from "./project-index";
import { botPermissionToSession, type BotPreset, type PermissionMode } from "./server-common";
import { startTurn } from "./turns";

// Jarvis, the built-in manager bot: its fixed prompt and its tools. The tools
// are an in-process MCP server handed to Claude Code through query()'s
// mcpServers, built afresh for each Jarvis turn and never for any other
// session — so no other bot, and no other agent, can see them.

/** The server name; the model sees its tools as mcp__gitbot__<tool>. */
export const JARVIS_SERVER = "gitbot";

export const JARVIS_TOOL_PREFIX = `mcp__${JARVIS_SERVER}__`;

/** True for one of Jarvis's own tools, as the agent names it. */
export function isJarvisTool(toolName: string): boolean {
  return toolName.startsWith(JARVIS_TOOL_PREFIX);
}

export function jarvisSystemPrompt(): string {
  return [
    "You are Jarvis, the manager bot inside gitbot. gitbot runs coding agents —",
    "Claude Code, Codex, OpenCode — as bots the user talks to in threads.",
    "",
    "YOUR JOB IS DELEGATION:",
    "The user tells you what they want done. You work out what should do it and",
    "where. Bots are abilities: use one when it fits the task, otherwise a plain",
    "agent (the Claude Code, Codex and OpenCode bots, which have no instructions).",
    "Handle cheap things yourself — git, `gh`, read-only checks through your shell.",
    "Changes to a project's code belong in a thread of the bot or agent that should",
    "make them, not in your own session.",
    "",
    "YOUR TOOLS (server \"gitbot\"):",
    "- list_bots: every bot's id and name. Bots marked not ready have not finished",
    "  setting up this machine.",
    "- get_bots: details for one or more bots at once — description, agent, default",
    "  folder, setup status. Pass includeInstructions only when the user asks to see",
    "  or discuss a bot's instructions.",
    "- list_projects: every known project's id and name. A project is a folder:",
    "  one a gitbot thread has run in, or one you added.",
    "- get_projects: details for one or more projects at once — folder, git remote,",
    "  current branch (no git details for a folder that is not a repo). A git.root",
    "  means the folder sits inside a larger repo: the folder is where the user",
    "  worked, the root is the repo.",
    "- add_project: add a folder by absolute path. Use it when the user names a",
    "  project the list lacks and you found its folder with your shell. If your",
    "  shell finds more than one candidate folder, ask before add_project.",
    "- start_thread: start a child thread — with a bot (its id) or a plain agent",
    "  (claude-code, codex or opencode) — in a project (its id), with its first",
    "  message. It returns the child's thread id at once; the child works on its",
    "  own and the user can open it from this thread's list of started threads.",
    "  Nothing tells you when it finishes: say what you started and where, and that",
    "  the user can check the thread. If it refuses, tell the user why.",
    "A bot's or project's name is often all you see; call get_bots or get_projects",
    "when the name is not enough.",
    "",
    "STARTING A THREAD:",
    "- The child sees nothing of this conversation. Write its first message as a",
    "  complete brief: the task, and anything the user told you that matters.",
    "- start_thread needs a project id. For a bot's default folder that is not",
    "  listed yet, add_project it first.",
    "- Leave permissionMode unset unless the user asked for a mode. Plain agents",
    "  then run in auto-approve and bots in their own mode.",
    "",
    "RULES:",
    "- A bot that is not set up on this machine: say so. Do not start its setup.",
    "- Choosing a folder: a project the user names (earlier in this thread counts),",
    "  resolved with list_projects and get_projects; else the default folder of a",
    "  bot the user names; otherwise ask. Never guess a folder.",
    "- Your working directory is your own scratch folder, not a project. Do not",
    "  treat it as the user's code.",
    "- Be brief. Answer from the tools rather than guessing about the user's bots",
    "  and projects.",
  ].join("\n");
}

// --- Tool handlers ---
// Plain functions over the bot store, so they can be tested without the SDK.

export type NotReady = "setup pending" | "setup failed";

export interface BotListing {
  id: string;
  name: string;
  /** Present only when the bot cannot take work on this machine yet. */
  notReady?: NotReady;
}

function notReady(bot: Bot): NotReady | undefined {
  if (!botNeedsSetup(bot)) return undefined;
  return bot.setupStatus === "failed" ? "setup failed" : "setup pending";
}

/** Every bot Jarvis may use — the user's and the plain agent bots — but not Jarvis. */
export function listBotsForJarvis(availableAgents: readonly string[]): BotListing[] {
  return listBots(availableAgents)
    .filter((b) => !isJarvisBot(b))
    .map((b) => {
      const marker = notReady(b);
      return { id: b.id, name: b.name, ...(marker ? { notReady: marker } : {}) };
    });
}

export interface BotDetails {
  id: string;
  name: string;
  description: string;
  agent: string;
  /** Plain agent bots are the agent itself, with no instructions. */
  plainAgent?: boolean;
  defaultFolder: string | null;
  setup: "not needed" | "complete" | "pending" | "failed";
  instructions?: string;
}

export type BotLookup = BotDetails | { id: string; error: string };

/**
 * Details for each id asked for, in order. Instructions only with the flag:
 * they are long, and Jarvis needs them only when the user asks about them.
 */
export function getBotsForJarvis(
  ids: readonly string[],
  includeInstructions: boolean,
  availableAgents: readonly string[],
): BotLookup[] {
  return ids.map((id) => {
    const bot = getBot(id);
    if (!bot || isJarvisBot(bot)) return { id, error: "no bot with this id" };
    // A plain agent bot is only an ability while its agent is installed here.
    if (bot.builtin && !availableAgents.includes(bot.builtin)) return { id, error: "agent not installed" };
    const details: BotDetails = {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      agent: bot.agent ?? "claude-code",
      ...(bot.builtin ? { plainAgent: true } : {}),
      defaultFolder: bot.repoPath || null,
      setup: !bot.setupInstructions?.trim() ? "not needed" : bot.setupStatus ?? "pending",
    };
    if (includeInstructions) details.instructions = bot.instructions;
    return details;
  });
}

// --- Starting a child thread ---

/** A thread's permissions in the bot vocabulary: what Jarvis may ask for. */
export type ChildPermissionMode = Bot["permissionMode"];

export const CHILD_PERMISSION_MODES = ["ask-permissions", "auto-approve", "plan"] as const satisfies readonly ChildPermissionMode[];

/**
 * How a child runs: a plain agent in auto-approve, a bot in its own mode, and
 * either in the mode the user asked for when Jarvis passes one. The run mode is
 * always explicit, so an override is never mixed with a plan bot's own mode.
 */
export function childPermission(
  bot: Pick<Bot, "builtin" | "permissionMode">,
  agent: BotAgent,
  override?: ChildPermissionMode,
): { chosen: ChildPermissionMode; permissionMode: PermissionMode; mode: "plan" | "build" } {
  const chosen = override ?? (bot.builtin ? "auto-approve" : bot.permissionMode);
  const session = botPermissionToSession(chosen, agent);
  return { chosen, permissionMode: session.permissionMode, mode: session.mode ?? "build" };
}

export interface StartThreadArgs {
  bot?: string;
  agent?: string;
  project: string;
  message: string;
  permissionMode?: ChildPermissionMode;
}

export type StartThreadResult =
  | { ok: true; threadId: string; bot: string; project: string; folder: string; permissionMode: ChildPermissionMode }
  | { ok: false; error: string };

/**
 * Starts a child of a Jarvis thread: makes the thread under its own bot, in
 * the project's folder, owned by the Jarvis thread, and starts its first turn.
 * Returns as soon as the turn is running.
 */
export function startChildThread(
  jarvisThreadId: string,
  args: StartThreadArgs,
  availableAgents: readonly string[],
): StartThreadResult {
  const owner = getThread(jarvisThreadId);
  if (!owner || !isJarvisBot(getBot(owner.botId))) return { ok: false, error: "only a Jarvis thread can start a child thread" };

  if (!!args.bot === !!args.agent) return { ok: false, error: "pass exactly one of bot or agent" };
  let bot: Bot | undefined;
  if (args.agent) {
    if (!(BOT_AGENTS as readonly string[]).includes(args.agent)) {
      return { ok: false, error: `unknown agent "${args.agent}": use one of ${BOT_AGENTS.join(", ")}` };
    }
    if (!availableAgents.includes(args.agent)) return { ok: false, error: `${args.agent} is not installed on this machine` };
    bot = getBot(`builtin-${args.agent}`);
  } else {
    bot = getBot(args.bot!);
    if (bot && isJarvisBot(bot)) return { ok: false, error: "a child thread cannot be a Jarvis thread" };
    if (!bot) return { ok: false, error: `no bot with id "${args.bot}": use list_bots` };
  }
  if (!bot) return { ok: false, error: `no plain bot for ${args.agent}` };
  if (botNeedsSetup(bot)) {
    const status = bot.setupStatus === "failed" ? "its setup failed" : "its setup has not finished";
    return {
      ok: false,
      error: `${bot.name} is not set up on this machine (${status}). Tell the user; they can finish its setup from the bot in gitbot.`,
    };
  }

  const project = findProject(args.project);
  if (!project) return { ok: false, error: `no project with id "${args.project}": use list_projects, or add_project a folder` };
  if (!args.message?.trim()) return { ok: false, error: "message is required" };

  const agent = threadAgent({}, bot);
  const permission = childPermission(bot, agent, args.permissionMode);
  const child = createThread(bot.id, project.folder, undefined, "chat", agent, jarvisThreadId);
  const turn = startTurn(
    { threadId: child.id, prompt: args.message, permissionMode: permission.permissionMode, mode: permission.mode },
    availableAgents,
  );
  if (!turn.ok) {
    // A thread that never ran is noise in the bot's list.
    deleteThread(child.id);
    return { ok: false, error: turn.message };
  }
  return {
    ok: true,
    threadId: child.id,
    bot: bot.name,
    project: project.name,
    folder: project.folder,
    permissionMode: permission.chosen,
  };
}

// --- SDK wiring ---

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/**
 * A fresh gitbot tool server for one Jarvis turn. It closes over the calling
 * Jarvis thread, so a child it starts knows its owner without Jarvis saying.
 */
export function jarvisToolServer(availableAgents: readonly string[], jarvisThreadId: string) {
  return createSdkMcpServer({
    name: JARVIS_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "list_bots",
        "List the user's gitbot bots (ids and names only), including the plain agent bots. A notReady marker means the bot has not finished setting up this machine.",
        {},
        async () => asText({ bots: listBotsForJarvis(availableAgents) }),
      ),
      tool(
        "get_bots",
        "Details for one or more bots by id: description, agent, default folder and setup status. Set includeInstructions only when the user asks about a bot's instructions.",
        {
          ids: z.array(z.string()).min(1).describe("Bot ids from list_bots"),
          includeInstructions: z.boolean().optional().describe("Also return each bot's instructions. Only when the user asks."),
        },
        async ({ ids, includeInstructions }) => asText({ bots: getBotsForJarvis(ids, includeInstructions ?? false, availableAgents) }),
      ),
      tool(
        "list_projects",
        "List the projects gitbot knows (ids and names only): folders gitbot threads have run in, and folders added with add_project. Colliding names carry their parent folder.",
        {},
        async () => asText({ projects: listProjects() }),
      ),
      tool(
        "get_projects",
        "Details for one or more projects by id: folder, git remote and current branch. git is null for a folder that is not a git repo.",
        { ids: z.array(z.string()).min(1).max(20).describe("Project ids from list_projects, up to 20") },
        async ({ ids }) => asText({ projects: await getProjects(ids) }),
      ),
      tool(
        "add_project",
        "Add a folder to the project index, by absolute path. The folder must exist; one already listed is not added twice.",
        { path: z.string().describe("Absolute path of the project's folder") },
        async ({ path }) => {
          const result = addProject(path);
          return result.ok
            ? asText({ project: result.project, alreadyListed: result.alreadyListed })
            : { ...asText({ error: result.error }), isError: true };
        },
      ),
      tool(
        "start_thread",
        "Start a child thread with a bot or a plain agent, in a project's folder, with its first message. Returns the child's thread id as soon as it starts; it does not wait for the work. Pass exactly one of bot or agent.",
        {
          bot: z.string().optional().describe("Bot id from list_bots"),
          agent: z.enum(BOT_AGENTS).optional().describe("A plain agent, when no bot fits"),
          project: z.string().describe("Project id from list_projects"),
          message: z.string().describe("The child's first message: a complete brief, since it sees nothing of this conversation"),
          permissionMode: z.enum(CHILD_PERMISSION_MODES).optional().describe("Only when the user asked for a mode. Default: auto-approve for a plain agent, the bot's own mode for a bot."),
        },
        async (args) => {
          const result = startChildThread(jarvisThreadId, args, availableAgents);
          if (!result.ok) return { ...asText({ error: result.error }), isError: true };
          const { ok: _ok, ...started } = result;
          return asText(started);
        },
      ),
    ],
  });
}

/**
 * The query() options a preset adds for Jarvis: its tool server. Empty for
 * every other session, which is what keeps the tools Jarvis's alone.
 */
export function jarvisQueryOptions(preset: BotPreset | undefined): Pick<Options, "mcpServers"> {
  if (!preset?.jarvis) return {};
  return { mcpServers: { [JARVIS_SERVER]: jarvisToolServer(preset.jarvis.availableAgents, preset.jarvis.threadId) } };
}
