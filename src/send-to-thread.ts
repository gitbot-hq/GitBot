import { basename } from "path";
import { botNeedsSetup, getBot, getThread, isJarvisBot, setThreadOwner, type Thread } from "./bot-store";
import { sessions, type SessionStore } from "./server-common";
import { liveStoreFor } from "./thread-tools";
import { startTurn } from "./turns";
import { oneChildAtATime, runningChildOf } from "./child-lock";

// Continuing an existing thread for Jarvis, and who owns a thread. A thread
// reports to the Jarvis thread that last sent it a message (reportTo); when
// the user types in it themselves, ownership passes to them and reports stop.

/** True while any session of this thread is mid-turn. */
function threadIsRunning(thread: Thread): boolean {
  if (thread.sdkSessionId && sessions.get(thread.sdkSessionId)?.status === "running") return true;
  return [...sessions.values()].some((s) => s.threadId === thread.id && s.status === "running");
}

/** The thread's session as the server holds it: the one its next turn resumes, else its newest. */
function storeOf(thread: Thread): SessionStore | undefined {
  return (thread.sdkSessionId ? sessions.get(thread.sdkSessionId) : undefined) ?? liveStoreFor(thread.id);
}

/**
 * The user sent a message in this thread themselves: it is theirs now, and
 * no longer reports to Jarvis. Called for user sends only, never for a turn
 * Jarvis or a report started.
 */
export function releaseToUser(threadId: string): void {
  setThreadOwner(threadId, undefined);
}

export type SendToThreadResult =
  | { ok: true; threadId: string; title: string; bot: string; project: string }
  | { ok: false; error: string };

/**
 * Sends Jarvis's message into an existing thread, resuming its session with
 * the thread's own bot, agent, folder and permission mode — never a more
 * permissive one: the live session's mode, else the bot's own. The calling Jarvis thread takes
 * ownership, so the turn's end reports back to it. Returns once the turn runs.
 */
export function sendToThread(
  jarvisThreadId: string,
  args: { threadId: string; message: string },
  availableAgents: readonly string[],
): SendToThreadResult {
  const owner = getThread(jarvisThreadId);
  if (!owner || !isJarvisBot(getBot(owner.botId))) return { ok: false, error: "only a Jarvis thread can send to a thread" };

  const thread = getThread(args.threadId);
  if (!thread) return { ok: false, error: `no thread with id "${args.threadId}": use list_threads` };
  const bot = getBot(thread.botId);
  if (isJarvisBot(bot)) return { ok: false, error: "that is a Jarvis thread; you cannot send to Jarvis threads" };
  if (thread.kind === "setup") return { ok: false, error: "that is a bot's setup thread, which is not yours to send to" };
  if (!bot) return { ok: false, error: "that thread's bot no longer exists" };
  if (botNeedsSetup(bot)) {
    const status = bot.setupStatus === "failed" ? "its setup failed" : "its setup has not finished";
    return {
      ok: false,
      error: `${bot.name} is not set up on this machine (${status}). Tell the user; they can finish its setup from the bot in gitbot.`,
    };
  }
  if (!args.message?.trim()) return { ok: false, error: "message is required" };
  if (threadIsRunning(thread)) {
    return { ok: false, error: `"${thread.title}" is mid-turn; you can send to it only once its turn has ended. Tell the user, or check it with thread_status.` };
  }
  const running = runningChildOf(jarvisThreadId);
  if (running) return { ok: false, error: oneChildAtATime(running) };

  // The live session's own mode; without one, startTurn falls back to the bot's.
  const live = storeOf(thread);
  // Ownership first: startTurn reads the turn's report owner from the thread.
  const previousOwner = thread.reportTo;
  setThreadOwner(thread.id, jarvisThreadId);
  let error: string;
  try {
    const turn = startTurn(
      { threadId: thread.id, prompt: args.message, permissionMode: live?.permissionMode, mode: live?.mode, reportable: true },
      availableAgents,
    );
    if (turn.ok) return { ok: true, threadId: thread.id, title: thread.title, bot: bot.name, project: basename(thread.repoPath) };
    error = turn.message;
  } catch (err: any) {
    error = err?.message ?? "the thread's turn could not start";
  }
  setThreadOwner(thread.id, previousOwner);
  return { ok: false, error };
}
