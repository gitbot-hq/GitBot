import { basename } from "path";
import { botNeedsSetup, getBot, getThread, isJarvisBot, threadAgent, updateThread, type Thread } from "./bot-store";
import { sessions } from "./server-common";
import { childPermission } from "./jarvis";
import { startTurn } from "./turns";

// Continuing an existing thread for Jarvis, and who owns a thread. A thread
// reports to the Jarvis thread that last sent it a message (reportTo); when
// the user types in it themselves, ownership passes to them and reports stop.

/**
 * The child of this Jarvis thread that is running a turn Jarvis started, if
 * any. One child at a time: while there is one, Jarvis starts no other.
 */
export function runningChildOf(jarvisThreadId: string): Thread | undefined {
  for (const store of sessions.values()) {
    if (store.status !== "running" || !store.reportable || !store.threadId) continue;
    const thread = getThread(store.threadId);
    if (thread?.reportTo === jarvisThreadId) return thread;
  }
  return undefined;
}

/** True while any session of this thread is mid-turn. */
function threadIsRunning(thread: Thread): boolean {
  if (thread.sdkSessionId && sessions.get(thread.sdkSessionId)?.status === "running") return true;
  return [...sessions.values()].some((s) => s.threadId === thread.id && s.status === "running");
}

/**
 * The user sent a message in this thread themselves: it is theirs now, and
 * no longer reports to Jarvis. Called for user sends only, never for a turn
 * Jarvis or a report started.
 */
export function releaseToUser(threadId: string): void {
  if (getThread(threadId)?.reportTo) updateThread(threadId, { reportTo: undefined });
}

export type SendToThreadResult =
  | { ok: true; threadId: string; title: string; bot: string; project: string }
  | { ok: false; error: string };

/**
 * Sends Jarvis's message into an existing thread, resuming its session with
 * the thread's own bot, agent and folder. The calling Jarvis thread takes
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
  if (running) {
    return { ok: false, error: `one child at a time: "${running.title}" (thread ${running.id}) is still working. Wait for its report.` };
  }

  const permission = childPermission(bot, threadAgent(thread, bot));
  // Ownership first: a turn that ends at once must still find its owner.
  const previousOwner = thread.reportTo;
  updateThread(thread.id, { reportTo: jarvisThreadId });
  let error: string;
  try {
    const turn = startTurn(
      { threadId: thread.id, prompt: args.message, permissionMode: permission.permissionMode, mode: permission.mode, reportable: true },
      availableAgents,
    );
    if (turn.ok) return { ok: true, threadId: thread.id, title: thread.title, bot: bot.name, project: basename(thread.repoPath) };
    error = turn.message;
  } catch (err: any) {
    error = err?.message ?? "the thread's turn could not start";
  }
  updateThread(thread.id, { reportTo: previousOwner });
  return { ok: false, error };
}
