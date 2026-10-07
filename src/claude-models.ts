/**
 * The Claude Code model and reasoning-effort picker's server side.
 *
 * Two halves:
 *
 * - **Effort** is a fixed, small enum the SDK defines (`EffortLevel`), so it is
 *   spelled out here and validated at the HTTP boundary. Every model gets all
 *   five levels: the CLI accepts any of them for any model and silently ignores
 *   effort on a model that has none (Haiku), so there is nothing to gate on.
 * - **The model list** is the account's own, and only a live session can be
 *   asked for it (`Query.supportedModels()`). It is plan-filtered and changes
 *   when Anthropic ships a model, so it is never hardcoded here. The first turn
 *   of the process captures it and every later request reads the capture; until
 *   then the browser renders its own fallback list (ui/app/lib/claude-models.ts).
 */

/** `EffortLevel` in the SDK (sdk.d.ts:691). Mirrored so the UI and the HTTP
 *  boundary can validate without importing the SDK's types. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What a Claude Code thread runs at when nobody has picked. */
export const DEFAULT_CLAUDE_EFFORT: EffortLevel = "medium";

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The longest model string worth accepting. There is no list to check a model
 * against — the account's own list changes server-side and a value it does not
 * offer must fail on the turn that asks for it, visibly, rather than be refused
 * here — so length is the only bound available. Generous next to the longest
 * real id (`claude-haiku-4-5-20251001[1m]`, 29 characters).
 */
export const MODEL_MAX_LENGTH = 200;

/**
 * A usable `model`: a non-blank string of sane length, and nothing else. Both
 * write paths (`POST /chat` and `PATCH /threads/:id`) check this, because the
 * value reaches both the SDK's argv and `contextWindowFor`, which does string
 * work on it — a non-string there is a TypeError inside the running turn
 * rather than a 400 at the boundary.
 */
export function isModelValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MODEL_MAX_LENGTH;
}

/**
 * One row of `Query.supportedModels()`, as the browser reads it. A structural
 * mirror of the SDK's `ModelInfo` rather than the type itself: this travels
 * over HTTP, and the UI must not depend on the SDK package.
 */
export interface ClaudeModelInfo {
  /** Pass this to `query({ options: { model } })` verbatim, suffix and all. */
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
}

/**
 * The account's model list as the last live session reported it. Process-wide,
 * because the list is the account's rather than the session's, and never
 * invalidated: it changes only when the plan or the SDK does, and a restart
 * re-captures it on the first turn.
 */
let captured: ClaudeModelInfo[] | null = null;

/** The captured list, or null while no session has ever reported one. */
export function supportedClaudeModels(): ClaudeModelInfo[] | null {
  return captured;
}

/**
 * Asks a live query for the account's models and keeps the answer. Called once
 * per turn and awaited by nobody: it rides the SDK's control channel alongside
 * the turn's own messages, so a failure (an old CLI, a transport that went
 * away) must not disturb the turn. Already-captured is left alone — the answer
 * does not vary by session.
 */
export function captureSupportedModels(q: { supportedModels(): Promise<unknown> }): void {
  if (captured) return;
  Promise.resolve()
    .then(() => q.supportedModels())
    .then((models) => {
      if (!Array.isArray(models)) return;
      const rows = models.filter(
        (m): m is ClaudeModelInfo =>
          !!m && typeof (m as any).value === "string" && typeof (m as any).displayName === "string",
      );
      if (rows.length) captured = rows;
    })
    .catch((err: any) => {
      console.warn(`  could not read the account's model list: ${err?.message ?? err}`);
    });
}

/** Test seam: forget the capture so a test can drive the first-paint path. */
export function resetSupportedModels(): void {
  captured = null;
}
