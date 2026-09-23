export type SetupOutcome = "complete" | "failed";

export type SetupRunKind = "start" | "continue" | "changed";

/**
 * The server frames every setup run for all three agents (src/bot-prompt.ts)
 * and records the verdict from the agent's own final reply. This client
 * prompt repeats the same completion contract so a continued or changed run
 * can say which kind it is; the markers below match the server's exactly.
 */
export function setupPrompt({
  setupInstructions,
  botInstructions,
  kind = "start",
}: {
  setupInstructions: string;
  botInstructions?: string;
  kind?: SetupRunKind;
}): string {
  const opening =
    kind === "continue"
      ? "Continue the one-time setup. Check what is still missing and resolve it."
      : kind === "changed"
        ? "The setup requirements changed. Verify this machine against the updated requirements."
        : "Run this bot's one-time setup now.";

  return [
    "[GitBot setup run]",
    opening,
    "",
    ...(botInstructions?.trim()
      ? [
          "The job this machine is being prepared for (context only; do not do it now):",
          botInstructions.trim(),
          "",
        ]
      : []),
    "Setup requirements from the bot's author:",
    setupInstructions.trim(),
    "",
    "Begin now. Check what is already present before changing anything. Keep changes to what the requirements call for. If you need information from the user, ask one clear question and end that response with a line containing exactly SETUP_NEEDS_INPUT.",
    "",
    "When every requirement is satisfied, verify it and end your final response with a line containing exactly SETUP_COMPLETE. If setup is blocked, end your final response with SETUP_FAILED: followed by a one-line reason. Only use a marker after reaching that outcome.",
  ].join("\n");
}

/** The last verdict wins, allowing a later turn to recover from a failure. */
export function readSetupOutcome(text: string): SetupOutcome | null {
  const matches = [...text.matchAll(/^\s*SETUP_(COMPLETE|FAILED)\b.*$/gim)];
  const last = matches.at(-1);
  if (!last) return null;
  return last[1].toUpperCase() === "COMPLETE" ? "complete" : "failed";
}

export function readSetupNeedsInput(text: string): boolean {
  return /^\s*SETUP_NEEDS_INPUT\s*$/im.test(text);
}

/** Control markers are for GitBot, not conversation UI or clipboard text. */
export function presentSetupText(text: string): string {
  const lines = text.split("\n");
  const last = lines.at(-1)?.trim() ?? "";
  const marker = ["SETUP_COMPLETE", "SETUP_FAILED", "SETUP_NEEDS_INPUT"].some(
    (control) => control.startsWith(last),
  );
  if (last && marker) lines.pop();
  return lines
    .filter((line) => !/^\s*SETUP_(?:COMPLETE|FAILED|NEEDS_INPUT)\b/i.test(line))
    .join("\n")
    .trimEnd();
}
