/**
 * How full the model's context window is.
 *
 * The agent SDK resends the whole conversation on every request, so what a
 * turn reports as input — the tokens it read, cached or not — plus what it
 * wrote is exactly what occupies the window going into the next turn. The
 * latest assistant message therefore tells us the current occupancy, and it
 * falls on its own after a compaction rather than needing to be reset.
 */
import { supportedClaudeModels } from "./claude-models";

export interface ContextUsage {
  /** Tokens the next request will carry. */
  used: number;
  /** The model's window, in tokens. */
  window: number;
  /** The model string as configured, suffix and all. */
  model: string;
  /** How to say that model out loud: "Opus 5 (1M context)". */
  label: string;
}

const MILLION = 1_000_000;
/** The short window: Haiku 4.5's, and the 4.6 pair's. Also the point past which
 *  a conversation has outgrown them, which is what the picker greys them on. */
export const SHORT_WINDOW = 200_000;

/**
 * The model a Claude Code thread runs when the thread has not picked one. The
 * SDK's own default row: it resolves to whatever Anthropic currently calls the
 * everyday model, so it never goes a generation stale the way a pinned id does.
 */
export const DEFAULT_CLAUDE_MODEL = "default";

/**
 * Which models have the short window, measured with
 * `Query.getContextUsage({ detail: "summary" })` against a live session — the
 * only source that reports the window a session is actually held to.
 *
 * Everything else the account is offered is natively 1M with no `[1m]` suffix
 * needed: Opus 5.x, Sonnet 5.x, Fable 5.x, Opus 4.7 and 4.8, and the aliases.
 * Only Haiku 4.5 and the 4.6 pair are short — note that 4.7 and 4.8 are *not*,
 * so this is not a "4.x is short" rule and cannot be inferred from the name.
 *
 * This table is static by choice and will go stale: when a new model lands,
 * check `Query.supportedModels()` (served as GET /claude-models) for rows this
 * does not account for, and measure each with `getContextUsage`.
 *
 * Mirrored for the picker in ui/app/lib/claude-models.ts — keep the two in step.
 */
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

/**
 * Families whose every member is short, matched as prefixes so a build the set
 * above has not learned about is still sized correctly. The live model list is
 * forwarded to the picker verbatim and changes server-side without an SDK
 * upgrade — we have already seen it go from five rows to twelve inside one
 * build — so a new row can appear without anyone editing anything here, and
 * **guessing 1M for a 200k model is the harmful direction**: it under-reports
 * how full the window is, which is the error that loses work.
 *
 * `claude-haiku` covers the whole family, not just dated 4.5 builds: Haiku is
 * the tier most likely to stay short, so a future `claude-haiku-5` should be
 * assumed short until measured. (It subsumes `claude-haiku-4-5`, which is why
 * that is not listed separately.) The 4.6 entries are versioned because 4.7
 * and 4.8 are 1M — there, the family says nothing.
 *
 * Mirrored in ui/app/lib/claude-models.ts; a test asserts the two agree.
 */
export const SHORT_WINDOW_PREFIXES = ["haiku", "claude-haiku", "claude-opus-4-6", "claude-sonnet-4-6"];

/**
 * The models known to have the **long** window.
 *
 * This list exists because an unrecognised model is treated as **short**, not
 * long. The two errors are not symmetric: sizing a 200k model as 1M under-
 * reports how full the window is, never greys it out of the picker, and shows
 * nothing wrong until a turn fails — whereas sizing a 1M model as 200k
 * over-reports, which is visible on the meter and can be reported. So the
 * benefit of the doubt goes to the safe direction, and a genuinely new 1M model
 * reads as short until it is added here.
 *
 * Mirrored in ui/app/lib/claude-models.ts; a test asserts the two agree.
 */
export const LONG_WINDOW_MODELS = new Set(["default", "opus", "sonnet", "fable"]);

/** Long families as prefixes: `claude-opus-5` covers `claude-opus-5-5` and any
 *  dated build of it. 4.7 and 4.8 are individual because the rest of 4.x is short. */
export const LONG_WINDOW_PREFIXES = [
  "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7",
];

/**
 * How many tokens the model's window holds.
 *
 * `resolvedModel` is consulted as well, because an alias row's name says
 * nothing about its family — a row called anything at all could resolve to
 * Haiku. When it is not supplied, the account's captured model list is asked;
 * pass it explicitly where determinism matters.
 *
 * No model at all means the thread runs `DEFAULT_CLAUDE_MODEL`, which is long —
 * that is "nothing configured", not "unrecognised". An unusable value (a
 * malformed `threads.json`) is treated the same way, because the turn will
 * drop it and fall back to the default too.
 */
export function contextWindowFor(model?: string, resolvedModel?: string): number {
  if (typeof model !== "string" || model === "") return MILLION;
  const resolved = resolvedModel
    ?? supportedClaudeModels()?.find((row) => row.value === model)?.resolvedModel;
  return isShortWindow(model, resolved) ? SHORT_WINDOW : MILLION;
}

/** True for a model held to the short window, unrecognised ones included. */
export function isShortWindow(model: string, resolvedModel?: string): boolean {
  // A `[1m]` suffix asks for the long window explicitly, and on the models
  // where it still means something (Opus 4.6) it is granted. The CLI refuses
  // the suffix outright where the model or the account cannot have it, so a
  // run that got as far as reporting usage really does have the long window.
  // Checked first: `claude-opus-4-6[1m]` is in a short family and is still 1M.
  for (const name of [model, resolvedModel]) {
    if (name?.includes("[1m]")) return false;
  }
  for (const name of [model, resolvedModel]) {
    if (name && (SHORT_WINDOW_MODELS.has(name) || SHORT_WINDOW_PREFIXES.some((p) => inFamily(name, p)))) return true;
  }
  for (const name of [model, resolvedModel]) {
    if (name && (LONG_WINDOW_MODELS.has(name) || LONG_WINDOW_PREFIXES.some((p) => inFamily(name, p)))) return false;
  }
  return true;
}

/**
 * Whether a model id belongs to a family prefix. The prefix has to end on a
 * token boundary, or `claude-opus-4-6` would also claim a future
 * `claude-opus-4-61`, which is a different model and may well be 1M.
 */
export function inFamily(model: string, prefix: string): boolean {
  if (!model.startsWith(prefix)) return false;
  const rest = model.slice(prefix.length);
  return rest === "" || !/^[0-9a-z]/i.test(rest);
}

/** Everything the next request resends, from one message's usage block. */
export function tokensInContext(usage: any): number {
  if (!usage) return 0;
  const n = (v: any) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
  return n(usage.input_tokens)
    + n(usage.cache_read_input_tokens)
    + n(usage.cache_creation_input_tokens)
    + n(usage.output_tokens);
}

/**
 * "claude-opus-5[1m]" -> "Opus 5 (1M context)", "claude-sonnet-4-6" ->
 * "Sonnet 4.6". Derived rather than looked up, so a model released tomorrow
 * still reads properly.
 */
export function modelLabel(model?: string): string {
  // Not just `!model`: this does string work on whatever it is handed, and the
  // values that reach it are not all ours. `threads.json` is a plain file and
  // a transcript's `message.model` is read raw from JSONL, so a non-string gets
  // here without TypeScript ever seeing it — and an unguarded `.includes` threw
  // out of the thread view, which is the whole of finding 2.
  if (typeof model !== "string" || model === "") return "";
  const long = model.includes("[1m]");
  const parts = model.replace(/\[1m\]/g, "").replace(/^claude-/, "").split("-").filter(Boolean);
  const family = parts.shift() ?? "";
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const version = parts.join(".");
  return `${[name, version].filter(Boolean).join(" ")}${long ? " (1M context)" : ""}`;
}

export function contextUsage(used: number, model?: string, window?: number): ContextUsage {
  // Normalized once, here, rather than at each of the three fields. Guarding
  // only the string work would stop the throw and still let a non-string into
  // `ContextUsage.model`, which goes out over SSE and `GET /.../messages` to a
  // browser that does its own `.indexOf` on it — moving the crash rather than
  // removing it.
  const name = typeof model === "string" ? model : "";
  return {
    used,
    window: window && window > 0 ? window : contextWindowFor(name),
    model: name,
    label: modelLabel(name),
  };
}
