/**
 * Which model gitbot asks the agent to run.
 *
 * gitbot pins no model of its own. A model name is a provider choice, and a bot
 * that carries one stops being portable: the same share code would then ask for
 * a model the importer's account, gateway or plan may not have. So resolution
 * is, in order:
 *
 *   1. the bot's own setting, if it has one
 *   2. `ANTHROPIC_MODEL` from the environment
 *   3. nothing — the Claude Code CLI resolves it from the user's settings files
 *      and its own default
 *
 * `undefined` means "pass no model option at all", which is deliberately not the
 * same as passing an empty string: the option is omitted so the CLI decides,
 * rather than a model name being invented here. An empty or whitespace-only
 * value counts as unset, so a blank field falls through instead of pinning "".
 *
 * The codex and opencode integrations omit the option the same way.
 */
export function resolveModel(
  botModel: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return botModel?.trim() || env.ANTHROPIC_MODEL?.trim() || undefined;
}
