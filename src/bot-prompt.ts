import { getBot, setSetupStatus } from "./bot-store";
import type { SessionStore } from "./server-common";

// How a bot's preset is put to an agent. Shared by every harness, so a bot
// behaves the same whichever agent it runs on.

type Preset = NonNullable<SessionStore["botPreset"]>;

/**
 * The system prompt a preset calls for: the setup framing on a setup run, the
 * job framing when the bot has instructions, nothing otherwise.
 */
export function presetSystemPrompt(preset: Preset | undefined): string | undefined {
  if (!preset) return undefined;
  if (preset.setup) return setupSystemPrompt(preset);
  return preset.instructions?.trim() ? botSystemPrompt(preset) : undefined;
}

/**
 * Frames a bot's instructions as a standing job. The instructions alone read as
 * background colour, so a bare "hi" often gets a greeting back instead of the
 * work; naming the job and saying when to start it makes the first turn reliable.
 */
export function botSystemPrompt(preset: NonNullable<SessionStore["botPreset"]>): string {
  return [
    `You are "${preset.name}", an agent with one standing job in this workspace.`,
    "",
    "YOUR JOB:",
    preset.instructions.trim(),
    "",
    "Start this job on the user's first message of the conversation, whatever that",
    "message says — a greeting such as \"hi\" is a signal to begin, not small talk.",
    "Do not ask what to work on and do not wait for a restatement of the job; the",
    "job above is the request. Afterwards, follow the user's messages as usual,",
    "keeping the job's constraints in force for the rest of the conversation.",
  ].join("\n");
}

/**
 * Frames the one-time machine-preparation run. The bot's own job is context
 * here, not the task: the task is making this computer able to do that job.
 * The run stays an ordinary conversation afterwards, so the user can take over
 * when a step needs a human — a password, a licence, a choice of package manager.
 */
export function setupSystemPrompt(preset: NonNullable<SessionStore["botPreset"]>): string {
  return [
    `You are setting up the machine for "${preset.name}", a bot that has just been`,
    "installed here. This thread is the one-time setup run, not the bot's work.",
    "",
    ...(preset.instructions.trim()
      ? ["THE JOB THIS MACHINE IS BEING PREPARED FOR (context only — do not do it now):",
         preset.instructions.trim(), ""]
      : []),
    "SETUP INSTRUCTIONS FROM THE BOT'S AUTHOR:",
    (preset.setupInstructions ?? "").trim(),
    "",
    "HOW TO RUN THIS:",
    "Begin as soon as the user's first message arrives, whatever it says. Check what",
    "is already present before installing anything — a machine that is ready needs no",
    "changes. Prefer the platform's usual package manager, keep changes to what the",
    "instructions call for, and explain anything that touches system state before you",
    "do it. If a step needs the user — a password, a licence key, an account, a choice",
    "you cannot make for them — ask in this thread and wait; this is a normal",
    "conversation and they can answer.",
    "",
    "HOW TO FINISH:",
    "When the machine can do the job, verify it (run the tool, check the version),",
    "then end your final message with a line containing exactly:",
    "SETUP_COMPLETE",
    "If you cannot get there — a missing dependency you may not install, an",
    "unsupported platform, a step the user must do elsewhere — end your final message",
    "with a line of the form:",
    "SETUP_FAILED: <one line saying what is blocked>",
    "Write one of those two markers only when the run has actually reached that",
    "point; never write them while a step is still outstanding, and never mention",
    "them as an example. The user may keep talking to you afterwards, and a later",
    "turn may end with a marker of its own once the situation changes.",
  ].join("\n");
}

/**
 * Reads the run's verdict off the end of the transcript. The last marker wins,
 * so a later turn that fixes a failure can flip the bot to ready.
 */
export function recordSetupOutcome(botId: string, text: string, threadId?: string): void {
  if (threadId && getBot(botId)?.setupThreadId !== threadId) return;
  const matches = text.match(/^\s*SETUP_(COMPLETE|FAILED)\b/gm);
  if (!matches?.length) return;
  const done = /COMPLETE/.test(matches[matches.length - 1]);
  setSetupStatus(botId, done ? "complete" : "failed");
}

/**
 * Reads a setup run's verdict out of the turn's own `assistant` events, for
 * harnesses that do not collect the text themselves. A sub-agent's words are
 * not the run's verdict, so events from inside a task are left out. Call it
 * when the turn ends, before `done`, so the hub sees the new status on refresh.
 */
export function recordSetupOutcomeFromEvents(store: SessionStore): void {
  const preset = store.botPreset;
  if (!preset?.setup) return;
  const text = store.events
    .filter((e) => e.type === "assistant" && !(e as any).parent_tool_use_id)
    .map((e) => String((e as any).content ?? ""))
    .join("\n");
  recordSetupOutcome(preset.id, text, store.threadId);
}
