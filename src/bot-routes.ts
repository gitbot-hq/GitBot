import {
  jsonOk,
  jsonError,
  readBody,
  parseQuery,
  IRequest,
  IResponse,
  botPermissionToSession,
  type BotPreset,
  type PermissionMode,
} from "./server-common";
import {
  listBots,
  getBot,
  createBot,
  updateBot,
  deleteBot,
  listThreads,
  getThread,
  createThread,
  updateThread,
  deleteThread,
  botNeedsSetup,
  ensureSetupThread,
  setSetupStatus,
  isBotAgent,
  isBuiltinBot,
  isJarvisBot,
  jarvisDir,
  builtinAgent,
  threadAgent,
  BOT_AGENTS,
  type Bot,
  type BotAgent,
  type Thread,
} from "./bot-store";
import { existsSync, statSync } from "fs";
import { loadThreadMessages } from "./thread-tools";

/**
 * REST surface for the bot hub: bots, their threads, and a thread's messages.
 * Messages are not stored here — they are read back from the transcript of the
 * agent the thread runs on, using the thread's sdkSessionId.
 *
 * Returns true when the request was handled.
 */
export async function handleBotRoutes(
  req: IRequest,
  res: IResponse,
  workspaceCwd: string,
  availableAgents: readonly string[],
): Promise<boolean> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const path = url.split("?")[0];
  const query = parseQuery(url);

  // --- Bots ---

  if (path === "/bots") {
    if (method === "GET") {
      jsonOk(res, { bots: listBots(availableAgents) });
      return true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      if (typeof body.name !== "string" || !body.name.trim()) {
        jsonError(res, 400, "name is required");
        return true;
      }
      if (body.agent !== undefined && !isBotAgent(body.agent)) {
        jsonError(res, 400, `agent must be one of: ${BOT_AGENTS.join(", ")}`);
        return true;
      }
      const bot = createBot({ ...body, name: body.name.trim() });
      // A bot that states what it needs from a machine gets its setup thread the
      // moment it lands here, whether it was made here or imported.
      const setupThread = ensureSetupThread(bot.id, workspaceCwd);
      jsonOk(res, { bot: getBot(bot.id) ?? bot, setupThread });
      return true;
    }
  }

  // Built-in bots are defined in code: nothing about them can be changed here.
  const changedBotId = method === "GET" ? null : matchId(path, "/bots/") ?? matchId(path, "/bots/", "/setup");
  if (changedBotId && isBuiltinBot(changedBotId)) {
    jsonError(res, 403, "Built-in bots cannot be edited or deleted");
    return true;
  }

  // POST /bots/:id/setup — the manual controls beside the automatic run.
  const setupBotId = matchId(path, "/bots/", "/setup");
  if (setupBotId && method === "POST") {
    const bot = getBot(setupBotId);
    if (!bot) { jsonError(res, 404, "Bot not found"); return true; }
    if (!bot.setupInstructions?.trim()) { jsonError(res, 400, "This bot has no setup instructions"); return true; }
    const body = await readBody(req);
    const action = body.action;
    if (action !== "complete" && action !== "reset" && action !== "fail") {
      jsonError(res, 400, "action must be complete, reset or fail");
      return true;
    }
    // A reset re-arms the run and makes sure there is a thread to run it in —
    // the old one may have been deleted.
    const updated = setSetupStatus(bot.id, action === "complete" ? "complete" : action === "fail" ? "failed" : "pending");
    const setupThread = action === "reset" ? ensureSetupThread(bot.id, workspaceCwd) : undefined;
    jsonOk(res, { bot: getBot(bot.id) ?? updated, setupThread });
    return true;
  }

  const botId = matchId(path, "/bots/");
  if (botId) {
    if (method === "GET") {
      const bot = getBot(botId);
      if (!bot) { jsonError(res, 404, "Bot not found"); return true; }
      jsonOk(res, { bot });
      return true;
    }
    if (method === "PATCH") {
      const body = await readBody(req);
      if (body.agent !== undefined && !isBotAgent(body.agent)) {
        jsonError(res, 400, `agent must be one of: ${BOT_AGENTS.join(", ")}`);
        return true;
      }
      const bot = updateBot(botId, body as Partial<Bot>);
      if (!bot) { jsonError(res, 404, "Bot not found"); return true; }
      // Setup instructions can arrive on an edit, not just at creation.
      const setupThread = ensureSetupThread(bot.id, workspaceCwd);
      jsonOk(res, { bot: getBot(bot.id) ?? bot, setupThread });
      return true;
    }
    if (method === "DELETE") {
      if (!deleteBot(botId)) { jsonError(res, 404, "Bot not found"); return true; }
      jsonOk(res, { deleted: true });
      return true;
    }
  }

  // --- Threads ---

  if (path === "/threads") {
    if (method === "GET") {
      jsonOk(res, { threads: listThreads(query.botId) });
      return true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      const bot = body.botId ? getBot(body.botId) : undefined;
      if (!bot) { jsonError(res, 400, "a valid botId is required"); return true; }
      // A thread runs where it is told to: the folder the user picked, else the
      // bot's default, else the directory the CLI was started in. Jarvis is the
      // exception: it always works in its own folder, whatever was asked for.
      const repoPath = isJarvisBot(bot) ? jarvisDir() : body.repoPath ?? bot.repoPath ?? workspaceCwd;
      if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
        jsonError(res, 400, `Not a directory: ${repoPath}`);
        return true;
      }
      if (body.agent !== undefined && !isBotAgent(body.agent)) {
        jsonError(res, 400, `agent must be one of: ${BOT_AGENTS.join(", ")}`);
        return true;
      }
      // Setup comes first: a bot that has not prepared this machine cannot be
      // given work yet. Its own setup thread is made by the server, never here.
      if (botNeedsSetup(bot)) {
        const setupThread = ensureSetupThread(bot.id, workspaceCwd);
        jsonError(res, 409, `${bot.name} still needs to set up this machine`, {
          setupRequired: true,
          setupThreadId: setupThread?.id,
        });
        return true;
      }
      // A built-in bot is pinned to its agent; its threads cannot run on
      // another, and there is no thread to make while that agent is missing.
      const pinned = bot.builtin ? builtinAgent(bot.builtin) : undefined;
      if (pinned && !availableAgents.includes(pinned)) {
        const what = isJarvisBot(bot) ? `${bot.name} needs ${pinned}, which is` : `${bot.name} is`;
        jsonError(res, 400, `${what} not installed on this machine`, { agentUnavailable: pinned });
        return true;
      }
      const agent = pinned ?? body.agent;
      jsonOk(res, { thread: createThread(bot.id, repoPath, body.title, "chat", agent) });
      return true;
    }
  }

  // /threads/:id/messages must be matched before /threads/:id
  const messagesId = matchId(path, "/threads/", "/messages");
  if (messagesId && method === "GET") {
    const thread = getThread(messagesId);
    if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
    // A thread that has not had a turn yet has no transcript on disk.
    jsonOk(res, { messages: await loadThreadMessages(thread) });
    return true;
  }

  const threadId = matchId(path, "/threads/");
  if (threadId) {
    if (method === "GET") {
      const thread = getThread(threadId);
      if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
      jsonOk(res, { thread });
      return true;
    }
    if (method === "PATCH") {
      const body = await readBody(req);
      // A Jarvis thread's folder, agent, kind and session are not the caller's
      // to change.
      const existing = getThread(threadId);
      // Ownership, a Stop's note and approval rows are gitbot's to set, on any thread.
      for (const key of ["reportTo", "pendingNote", "approvals"]) delete body[key];
      if (existing && isJarvisBot(getBot(existing.botId))) {
        for (const key of ["repoPath", "agent", "kind", "sdkSessionId"]) delete body[key];
      }
      const thread = updateThread(threadId, body);
      if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
      jsonOk(res, { thread });
      return true;
    }
    if (method === "DELETE") {
      const thread = getThread(threadId);
      if (!deleteThread(threadId)) { jsonError(res, 404, "Thread not found"); return true; }
      // Deleting the setup thread leaves the bot pointing at nothing; unbind so
      // the next run can make a fresh one.
      if (thread && thread.kind === "setup") updateBot(thread.botId, { setupThreadId: undefined });
      jsonOk(res, { deleted: true });
      return true;
    }
  }

  return false;
}

/** What a hub thread's turn runs with, or why it cannot run. */
export type ThreadTurn =
  | {
      ok: true;
      repoPath: string;
      agent: BotAgent;
      model?: string;
      permissionMode: PermissionMode;
      mode?: "plan" | "build";
      preset: BotPreset;
    }
  | { ok: false; status: number; message: string; extra?: Record<string, unknown> };

/**
 * How /chat runs a turn on a hub thread: the thread supplies the folder and
 * agent, the bot its preset, and the request may override model and
 * permissions. Jarvis is fixed — its folder, the default model and
 * auto-approve, whatever the thread record or the request says.
 */
export function resolveThreadTurn(
  thread: Thread,
  bot: Bot,
  body: { model?: string; permissionMode?: PermissionMode; mode?: "plan" | "build" },
  availableAgents: readonly string[],
): ThreadTurn {
  const agent = threadAgent(thread, bot);
  if (!availableAgents.includes(agent)) {
    return {
      ok: false,
      status: 400,
      message: `${bot.name} runs on ${agent}, which is not installed on this machine`,
      extra: { agentUnavailable: agent },
    };
  }
  const isSetup = thread.kind === "setup";
  // Work waits on setup; the setup thread itself is exempt, since it is
  // the thing that clears the block.
  if (!isSetup && botNeedsSetup(bot)) {
    return {
      ok: false,
      status: 409,
      message: `${bot.name} still needs to set up this machine`,
      extra: { setupRequired: true, setupThreadId: bot.setupThreadId },
    };
  }
  const preset: BotPreset = {
    id: bot.id,
    name: bot.name,
    instructions: bot.instructions,
    // The allow-list fences the bot's work. Its setup run prepares the
    // machine, which can need tools the job itself never uses.
    allowedTools: isSetup ? undefined : bot.allowedTools,
    disallowedTools: bot.disallowedTools,
    ...(isSetup ? { setup: true, setupInstructions: bot.setupInstructions } : {}),
  };
  if (isJarvisBot(bot) && !isSetup) {
    return {
      ok: true,
      repoPath: jarvisDir(),
      agent,
      permissionMode: "yolo",
      preset: { ...preset, jarvis: { availableAgents, threadId: thread.id } },
    };
  }
  // Bot presets speak their own vocabulary ("auto-approve", "plan"); the
  // session speaks PermissionMode. Translate, or nothing auto-approves.
  const botPermission = botPermissionToSession(bot.permissionMode, agent);
  return {
    ok: true,
    repoPath: thread.repoPath,
    agent,
    model: body.model ?? bot.model,
    permissionMode: body.permissionMode ?? botPermission.permissionMode,
    mode: body.mode ?? botPermission.mode,
    preset,
  };
}

/** Extracts a single path segment: matchId("/bots/abc", "/bots/") -> "abc". */
function matchId(path: string, prefix: string, suffix = ""): string | null {
  if (!path.startsWith(prefix)) return null;
  let rest = path.slice(prefix.length);
  if (suffix) {
    if (!rest.endsWith(suffix)) return null;
    rest = rest.slice(0, -suffix.length);
  }
  if (!rest || rest.includes("/")) return null;
  return rest;
}
