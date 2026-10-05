/**
 * How full the model's context window is.
 *
 * The agent SDK resends the whole conversation on every request, so what a
 * turn reports as input — the tokens it read, cached or not — plus what it
 * wrote is exactly what occupies the window going into the next turn. The
 * latest assistant message therefore tells us the current occupancy, and it
 * falls on its own after a compaction rather than needing to be reset.
 */
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
/** What Claude Code assumes for any model that does not ask for the long window. */
const DEFAULT_WINDOW = 200_000;

/** The [1m] suffix is how the SDK is told to budget a 1M window; mirror that rule. */
export function contextWindowFor(model?: string): number {
  return model?.includes("[1m]") ? MILLION : DEFAULT_WINDOW;
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
  if (!model) return "";
  const long = model.includes("[1m]");
  const parts = model.replace(/\[1m\]/g, "").replace(/^claude-/, "").split("-").filter(Boolean);
  const family = parts.shift() ?? "";
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const version = parts.join(".");
  return `${[name, version].filter(Boolean).join(" ")}${long ? " (1M context)" : ""}`;
}

export function contextUsage(used: number, model?: string, window?: number): ContextUsage {
  return {
    used,
    window: window && window > 0 ? window : contextWindowFor(model),
    model: model ?? "",
    label: modelLabel(model),
  };
}
