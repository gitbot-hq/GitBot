// The composer's model and effort picker, for Claude Code threads only.
//
// The real model list is the account's own and only a live session can be asked
// for it, so GET /claude-models answers `null` until a turn has run in this
// gitbot process. The list below is what the picker shows until then: it is a
// fallback for first paint, not a catalog — the live answer replaces it whole,
// verbatim and in the SDK's own order.

/** One row of the model menu: the SDK's `ModelInfo`, as the server forwards it. */
export type ClaudeModelInfo = {
  /** Sent back as `model` exactly as given — aliases and `[1m]` suffixes alike. */
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

/**
 * What the picker offers before any session has reported the real list: a
 * transcription of `Query.supportedModels()` as captured on 2026-10-07, rows,
 * order, values and wording alike.
 *
 * `default` and `opus` both resolve to the same model and are both kept: they
 * are two rows in the SDK's own answer, and the picker mirrors that answer
 * rather than tidying it. The pinned `claude-*` rows are here so a thread that
 * stored one is shown its name rather than its id on first paint.
 */
export const FALLBACK_CLAUDE_MODELS: ClaudeModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Efficient for routine tasks" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "Best for everyday, complex tasks" },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5", description: "Most capable for your hardest and longest-running tasks" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "Best for everyday, complex tasks" },
  { value: "claude-opus-4-7", resolvedModel: "claude-opus-4-7", displayName: "Opus 4.7", description: "Best for everyday, complex tasks" },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Best for everyday, complex tasks" },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Efficient for routine tasks" },
];

/** The model a thread runs when it has not picked one (the SDK's own alias). */
export const DEFAULT_CLAUDE_MODEL = "default";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_CLAUDE_EFFORT: EffortLevel = "medium";

/**
 * Every level is offered for every model. The CLI accepts all five whatever the
 * model is, and a model with no effort support (Haiku) ignores the value rather
 * than refusing it — so there is nothing here to gate on, and gating would only
 * make the control move about as the model changes.
 */
export const EFFORT_OPTIONS: { level: EffortLevel; label: string; detail: string }[] = [
  { level: "low", label: "Low", detail: "Least thinking, fastest answers" },
  { level: "medium", label: "Medium", detail: "The usual balance of speed and care" },
  { level: "high", label: "High", detail: "More thinking on harder work" },
  { level: "xhigh", label: "Extra high", detail: "Longer reasoning before acting" },
  { level: "max", label: "Max", detail: "As much thinking as the model allows" },
];

/** The short context window: past this a thread no longer fits a model that has it. */
export const SHORT_WINDOW = 200_000;

/** The long one, which most current models have natively. */
export const LONG_WINDOW = 1_000_000;

/** Mirrors SHORT_WINDOW_MODELS in src/context-window.ts — a test asserts the
 *  two agree, since the picker greying and the meter must not disagree. */
export const SHORT_WINDOW_MODELS = new Set([
  "haiku",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  // Not offered to this account today, but `supportedModels()` is plan-filtered
  // and server-driven, so another plan can be shown them with no build change.
  // Named explicitly so they are right by name rather than by the fallback.
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-1",
  "claude-3-5-haiku",
]);

/** Mirrors SHORT_WINDOW_PREFIXES in src/context-window.ts: families matched as
 *  prefixes, so a build the set above does not name is still treated as short.
 *  `claude-haiku` covers the whole family (a future `claude-haiku-5` included,
 *  and it subsumes `claude-haiku-4-5`); the 4.6 entries are versioned because
 *  Opus 4.7 and 4.8 are 1M. */
export const SHORT_WINDOW_PREFIXES = ["haiku", "claude-haiku", "claude-opus-4-6", "claude-sonnet-4-6"];

/**
 * The models known to have the **long** window. Mirrors LONG_WINDOW_MODELS in
 * src/context-window.ts.
 *
 * This list exists because an unrecognised model is treated as **short**, not
 * long. The two errors are not symmetric: sizing a 200k model as 1M under-
 * reports how full the window is, never greys it out, and shows nothing wrong
 * until a turn fails — whereas sizing a 1M model as 200k over-reports, which is
 * visible on the meter and can be reported. So the benefit of the doubt goes to
 * the safe direction, and a genuinely new 1M model reads as short until it is
 * added here.
 */
export const LONG_WINDOW_MODELS = new Set(["default", "opus", "sonnet", "fable"]);

/** Long families, matched as prefixes: `claude-opus-5` covers `claude-opus-5-5`
 *  and any dated build of it. 4.7 and 4.8 are listed individually because the
 *  rest of 4.x is short. Mirrors LONG_WINDOW_PREFIXES in src/context-window.ts. */
export const LONG_WINDOW_PREFIXES = [
  "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7",
];

/**
 * How big a model's context window is, and whether that is known or assumed.
 *
 * `resolvedModel` is consulted as well as `value`, because an alias row says
 * nothing about its family: `default` happens to resolve to a 1M model today,
 * but a row named anything at all could resolve to Haiku, and matching the
 * name alone would size it long and never grey it.
 */
export function modelWindow(value: string, resolvedModel?: string): { window: number; known: boolean } {
  for (const name of [value, resolvedModel]) {
    if (!name) continue;
    // A `[1m]` suffix asks for the long window and the CLI refuses it where it
    // cannot be had, so a suffixed value that runs at all is long.
    if (name.includes("[1m]")) return { window: LONG_WINDOW, known: true };
  }
  for (const name of [value, resolvedModel]) {
    if (name && (SHORT_WINDOW_MODELS.has(name) || SHORT_WINDOW_PREFIXES.some((p) => inFamily(name, p)))) {
      return { window: SHORT_WINDOW, known: true };
    }
  }
  for (const name of [value, resolvedModel]) {
    if (name && (LONG_WINDOW_MODELS.has(name) || LONG_WINDOW_PREFIXES.some((p) => inFamily(name, p)))) {
      return { window: LONG_WINDOW, known: true };
    }
  }
  return { window: SHORT_WINDOW, known: false };
}

/** True for a model whose window a long conversation can outgrow. */
export function isShortWindowModel(value: string, resolvedModel?: string): boolean {
  return modelWindow(value, resolvedModel).window <= SHORT_WINDOW;
}

/** Mirrors inFamily in src/context-window.ts: the prefix has to end on a token
 *  boundary, or `claude-opus-4-6` would also claim `claude-opus-4-61`. */
export function inFamily(model: string, prefix: string): boolean {
  if (!model.startsWith(prefix)) return false;
  const rest = model.slice(prefix.length);
  return rest === "" || !/^[0-9a-z]/i.test(rest);
}

/**
 * How close to a window a conversation may get before the model behind it stops
 * being offered. A turn resends the whole conversation and then writes a reply,
 * so a thread sitting just under a window is certain to pass it on the next
 * turn — offering the model right up to the line means offering one that cannot
 * work.
 */
export const WINDOW_HEADROOM = 0.9;

/** Whether a row can be picked for a conversation this size, and what to say. */
export type ModelFit = {
  /** True when the row must not be choosable. Never true for the current pick. */
  blocked: boolean;
  /** Why, when there is something to say — shown as the row's tooltip. */
  note?: string;
};

/**
 * Can this model be picked for a conversation of `used` tokens?
 *
 * `current` — the thread's own model — is **never blocked**, however full the
 * conversation is. Disabling the row a thread is already running would say "you
 * cannot pick what you have picked", would strand a thread on a model it could
 * not change away from once every alternative was also unknown, and an
 * `aria-checked` row that is also `disabled` drops out of the menu's
 * open-on-current-choice focus query. It gets the warning without the block.
 */
export function modelFit(row: ClaudeModelInfo, used: number, current: boolean): ModelFit {
  const { window, known } = modelWindow(row.value, row.resolvedModel);
  if (used <= window * WINDOW_HEADROOM) return { blocked: false };
  const held = `This conversation holds ${used.toLocaleString()} tokens`;
  // An assumed window is stated as an assumption: GitBot's table goes stale,
  // and claiming a model is small when we simply do not know it would be a
  // lie the user cannot check.
  const limit = known
    ? `${row.displayName}'s ${window.toLocaleString()}-token window`
    : `the ${window.toLocaleString()} tokens GitBot assumes for ${row.displayName}, whose context window it does not know`;
  return current
    ? { blocked: false, note: `${held} — at or past ${limit}. The next turn may be compacted or refused; pick a model with a larger window.` }
    : { blocked: true, note: `${held} — too close to ${limit} for the next turn to fit.` };
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The row for a stored value: its own, else the row it resolves to.
 *
 * Several rows can share a `resolvedModel` — `default` and `opus` both resolve
 * to `claude-opus-5-5` — so the second lookup needs a tie-break, or a thread
 * pinned to the literal id reads "Default (recommended)", which names the
 * recommendation rather than the model that is pinned. A row that is only a
 * pointer to whatever is currently recommended is the worst available label for
 * an explicitly pinned id, so it loses to any other match.
 */
export function modelRow(models: ClaudeModelInfo[], value: string): ClaudeModelInfo | null {
  const exact = models.find((m) => m.value === value);
  if (exact) return exact;
  const resolved = models.filter((m) => m.resolvedModel === value);
  return resolved.find((m) => !GENERIC_ROWS.has(m.value)) ?? resolved[0] ?? null;
}

/** Rows that name a recommendation rather than a model. */
const GENERIC_ROWS = new Set(["default"]);

/**
 * A readable name for a value no list in hand accounts for — a thread pinned to
 * a model this build predates, or any value seen before the live list lands:
 * "claude-opus-6-1[1m]" → "Opus 6.1". Derived rather than looked up, so a model
 * released tomorrow still reads as a name instead of an id. A value that does
 * not parse is shown as-is rather than mangled.
 */
export function derivedModelName(value: string): string {
  const parts = value.replace(/\[1m\]/g, "").replace(/^claude-/, "").split("-").filter(Boolean);
  const family = parts.shift();
  if (!family) return value;
  // Version digits only: a trailing date stamp ("20251001") is not a version.
  const version = parts.filter((p) => /^\d{1,2}$/.test(p));
  if (parts.some((p) => !/^\d+$/.test(p))) return value;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return [name, version.join(".")].filter(Boolean).join(" ");
}

/** What to call a model value: the list's own name, else a derived one. */
export function modelDisplayName(models: ClaudeModelInfo[], value: string): string {
  return modelRow(models, value)?.displayName ?? derivedModelName(value);
}
