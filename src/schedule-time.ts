import { Cron } from "croner";

// Time maths for schedules: when a `when` next comes due, how many times it
// came due in a span, and the shortest gap between two of its runs. Cron
// patterns go through croner (IANA timezones, DST). Pure: no storage, no
// clock of its own; every function takes the times it works from.
//
// One rule holds everywhere here: an occurrence "after t" is strictly later
// than t. croner alone does not promise that across a DST change (from inside
// a repeated hour it can answer with an earlier time, and at a spring-forward
// it can answer with the same time twice), so cronAfter checks and steps past
// it. A schedule's next run therefore always moves forward, and can never be
// fired again in a loop.

export type When =
  | { kind: "once"; at: string }
  | { kind: "cron"; expr: string; tz: string }
  | { kind: "interval"; everyMinutes: number; anchor: string };

/** The shortest gap allowed between two runs. */
export const MIN_GAP_MINUTES = 1;
/** The longest interval: a year. */
export const EVERY_MINUTES_MAX = 366 * 24 * 60;
export const CRON_EXPR_MAX = 100;
/**
 * Counting a cron's missed runs (a 1-minute cron after a month down is
 * 43,200 of them) must not block the event loop. croner's timezone maths
 * costs about 0.25 ms a run, so only the first COUNT_EXACT_MAX are walked
 * exactly, through it. The rest are counted on the zone's wall clock with
 * croner's fixed-offset mode (about 0.01 ms a run), for up to
 * COUNT_WALL_MAX, and past that estimated from the average gap; the last
 * TAIL_EXACT_MS are walked exactly again when the offset changes in them.
 * Worst case about 10 ms a schedule, or 55 ms when it ends just after a DST change.
 * The middle stretch makes the count approximate: across a DST change inside
 * it, the wall clock can differ from the real runs by up to the shift's
 * worth of them.
 */
export const COUNT_EXACT_MAX = 20;
export const COUNT_WALL_MAX = 500;
/** The last stretch of a long count that spans an offset change, walked exactly through croner (≤ 180 runs, about 45 ms). */
export const TAIL_EXACT_MS = 3 * 60 * 60_000;
/** Runs sampled (on the wall clock, cheaply) for a cron's closest gap: a day of 1-minute runs. */
export const GAP_SAMPLE_MAX = 1_440;
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** The server's own IANA timezone: the default for a cron. */
export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The server's zone if it is a region name, else UTC (a server set to "EST" gets no DST surprise). */
function defaultTimeZone(): { ok: true; tz: string } {
  const own = canonicalTimeZone(serverTimeZone());
  return own.ok ? own : { ok: true, tz: "UTC" };
}

const knownZones = new Set<string>();

/** Any zone Intl accepts (a stored schedule's, however it was written). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  if (knownZones.has(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return false;
  }
  if (knownZones.size < 500) knownZones.add(tz);
  return true;
}

/**
 * A new schedule's zone, as its canonical IANA name ("US/Eastern" becomes
 * "America/New_York", "utc" becomes "UTC"), or why it can't be used. Only
 * region names (Area/Location) and UTC are taken: a bare offset ("+05:30")
 * or an abbreviation ("EST", "IST") has no DST rules of its own, or
 * different ones from what was meant (Intl reads "EST" as America/Panama),
 * which is the classic way to get a schedule an hour off for half the year.
 */
export function canonicalTimeZone(tz: unknown): { ok: true; tz: string } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `when.tz ${JSON.stringify(tz)} ${why}` });
  if (typeof tz !== "string" || !tz.trim()) return bad("is not a known IANA timezone, e.g. \"Europe/London\"");
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).resolvedOptions().timeZone;
  } catch {
    return bad("is not a known IANA timezone, e.g. \"Europe/London\"");
  }
  if (canonical === "UTC") return { ok: true, tz: "UTC" };
  // Etc/GMT+5 is UTC-5 (the sign is inverted), with no DST: a fixed offset too.
  if (/^[+-]\d/.test(tz.trim()) || /^Etc\//i.test(canonical) || /^Etc\//i.test(tz.trim())) return bad("is a fixed offset, not a timezone: use a region name, e.g. \"Asia/Kolkata\", so DST is followed");
  if (!tz.includes("/")) return bad("is an abbreviation, not a timezone: use a region name, e.g. \"America/New_York\" or \"Europe/London\"");
  return { ok: true, tz: canonical };
}

const wallFormats = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock time in `tz` at `t`, as if it were UTC (ms). */
function wallMs(t: number, tz: string): number {
  let f = wallFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    if (wallFormats.size >= 500) wallFormats.clear();
    wallFormats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(t)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

/**
 * An ISO instant whose fields are all real: no 30 February, no hour 24.
 * (Date.parse rolls impossible dates over to the next month, so the regex
 * alone would store a "2026-02-30" that fires on 2 March.)
 */
export function isIsoInstant(at: unknown): at is string {
  if (typeof at !== "string") return false;
  const m = ISO_INSTANT_FIELDS.exec(at);
  if (!m || Number.isNaN(Date.parse(at))) return false;
  const [, y, mo, d, h, mi, sec, oh, om] = m.map((x) => (x === undefined ? undefined : Number(x)));
  const daysInMonth = new Date(Date.UTC(y!, mo!, 0)).getUTCDate();
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > daysInMonth) return false;
  if (h! > 23 || mi! > 59 || (sec ?? 0) > 59) return false;
  if ((oh ?? 0) > 23 || (om ?? 0) > 59) return false;
  return true;
}
/** An ISO instant: a date, a time, and an explicit zone (Z or ±hh:mm). */
const ISO_INSTANT_FIELDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// --- croner ---

const crons = new Map<string, Cron>();

/**
 * A parsed pattern, cached (parsing is cheap, but the scheduler asks on every
 * tick). Never given a function, so croner never sets a timer of its own.
 * Throws on a bad pattern or timezone.
 */
function cronFor(expr: string, tz: string): Cron {
  const key = `${tz}\u0000${expr}`;
  let c = crons.get(key);
  if (!c) {
    // croner reads any string with a ":" as a one-off date, not a pattern.
    if (expr.includes(":")) throw new Error(`"${expr}" is not a cron pattern`);
    c = new Cron(expr, { timezone: tz, mode: "5-part", paused: true });
    if (crons.size >= 500) crons.clear();
    crons.set(key, c);
  }
  return c;
}

const wallCrons = new Map<string, Cron>();

/**
 * The same pattern on a fixed UTC offset of 0: the fast path for walking a
 * zone's wall clock (wallMs) when only counts matter, not exact instants.
 */
function wallCronFor(expr: string): Cron {
  let c = wallCrons.get(expr);
  if (!c) {
    if (expr.includes(":")) throw new Error(`"${expr}" is not a cron pattern`);
    c = new Cron(expr, { utcOffset: 0, mode: "5-part", paused: true });
    if (wallCrons.size >= 500) wallCrons.clear();
    wallCrons.set(expr, c);
  }
  return c;
}

/** Patterns whose next run needed a retry step, already logged once. */
const steppedPast = new Set<string>();

/**
 * How far past `after` to ask croner again when its answer is not later than
 * `after` (a DST change). The first answer that is later wins; a skipped
 * wall time inside the shifted hour is the price, once a year.
 */
const CRON_RETRY_STEPS_MS = [0, MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS, 2 * 60 * MINUTE_MS, 3 * 60 * MINUTE_MS, DAY_MS];

/** The first occurrence of a cron strictly after `after`, or null if there is none. */
function cronAfter(expr: string, tz: string, after: number): number | null {
  const c = cronFor(expr, tz);
  for (const step of CRON_RETRY_STEPS_MS) {
    const d = c.nextRun(new Date(after + step));
    if (!d) return null;
    const t = d.getTime();
    if (t > after) {
      // Seen at DST changes (croner answers with an earlier or the same time).
      // Logged once a pattern, so a croner upgrade that changes this shows.
      const key = `${tz}\u0000${expr}`;
      if (step > 0 && !steppedPast.has(key)) {
        if (steppedPast.size < 500) steppedPast.add(key);
        console.warn(`[schedules] croner gave no run after ${new Date(after).toISOString()} for "${expr}" in ${tz}; asked again ${step / MINUTE_MS} min later`);
      }
      return t;
    }
  }
  return null;
}

// --- Occurrences ---

/**
 * The first time `when` comes due strictly after `after` (ms), or null if it
 * never does again. An interval runs at anchor, anchor + N min, anchor + 2N
 * min, …; a schedule made now with the default anchor (now) first runs N
 * minutes from now.
 */
export function nextOccurrence(when: When, after: number): number | null {
  switch (when.kind) {
    case "once": {
      const at = Date.parse(when.at);
      return at > after ? at : null;
    }
    case "interval": {
      const anchor = Date.parse(when.anchor);
      const step = when.everyMinutes * MINUTE_MS;
      if (!(step > 0) || Number.isNaN(anchor)) return null;
      if (after < anchor) return anchor;
      return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    case "cron":
      return cronAfter(when.expr, when.tz, after);
    default:
      return null;
  }
}

/**
 * How many times `when` comes due from `first` (itself an occurrence, and
 * counted) up to `last`, both inclusive, counting no more than `max`.
 * Bounded work: an interval is arithmetic; a cron is walked exactly for
 * COUNT_EXACT_MAX runs, then counted on the wall clock and estimated (see
 * COUNT_EXACT_MAX), in which case `estimated` is true.
 */
export function countOccurrences(
  when: When,
  first: number,
  last: number,
  max = Infinity,
): { count: number; estimated: boolean } {
  if (first > last || max <= 0) return { count: 0, estimated: false };
  if (when.kind === "once") return { count: 1, estimated: false };
  if (when.kind === "interval") {
    const step = when.everyMinutes * MINUTE_MS;
    const after = nextOccurrence(when, first);
    const more = after == null || after > last ? 0 : Math.floor((last - after) / step) + 1;
    return { count: Math.min(max, 1 + more), estimated: false };
  }
  // Exactly, through croner, for the first few.
  let count = 1;
  let t = first;
  for (;;) {
    if (count >= max) return { count: max, estimated: false };
    const n = nextOccurrence(when, t);
    if (n == null || n > last) return { count, estimated: false };
    count += 1;
    t = n;
    if (count >= COUNT_EXACT_MAX) break;
  }
  // The middle on the wall clock. If the zone's offset changes in the last
  // TAIL_EXACT_MS (a span that ends inside a DST change, say inside the
  // repeated autumn hour), the wall clock stops that far before `last` and
  // the tail is walked exactly again, through croner. Otherwise the wall
  // clock is exact up to `last` itself, and costs no croner calls.
  const offset = (x: number) => wallMs(x, when.tz) - Math.floor(x / 1000) * 1000;
  const tailStart = offset(last) !== offset(last - TAIL_EXACT_MS) ? last - TAIL_EXACT_MS : last;
  const estimated = t < tailStart;
  if (estimated) {
    const fast = wallCronFor(when.expr);
    const wallStart = wallMs(t, when.tz);
    const wallEnd = wallMs(tailStart, when.tz);
    let w = wallStart;
    let walked = 0;
    let reached = false;
    while (count < max && walked < COUNT_WALL_MAX) {
      const d = fast.nextRun(new Date(w));
      if (!d || d.getTime() > wallEnd) { reached = true; break; }
      w = d.getTime();
      count += 1;
      walked += 1;
    }
    if (count >= max) return { count: max, estimated: true };
    if (!reached) {
      // Past that, from the average gap on the wall clock so far.
      const avg = (w - wallStart) / walked;
      if (avg > 0) count += Math.floor((wallEnd - w) / avg);
      if (count >= max) return { count: max, estimated: true };
    }
    t = tailStart;
  }
  for (;;) {
    const n = nextOccurrence(when, t);
    if (n == null || n > last) break;
    count += 1;
    t = n;
    if (count >= max) return { count: max, estimated };
  }
  return { count, estimated };
}

/**
 * The next `n` run times from `from` (inclusive: `from` is the next run
 * itself), strictly increasing, stopping before `endsAt` and after
 * `runsLeft` of them.
 */
export function upcomingRuns(
  when: When,
  from: number,
  n: number,
  limits: { endsAt?: number; runsLeft?: number } = {},
): number[] {
  const out: number[] = [];
  const endsAt = limits.endsAt ?? Infinity;
  const cap = Math.min(n, limits.runsLeft ?? Infinity);
  let t: number | null = from;
  while (t != null && out.length < cap && t < endsAt) {
    out.push(t);
    t = when.kind === "once" ? null : nextOccurrence(when, t);
  }
  return out;
}

/**
 * The shortest gap between two consecutive runs, in minutes, from `from`
 * on. An interval's is its step. A cron's is measured on the zone's wall
 * clock (croner's fast fixed-offset mode, so a few ms) over a day of its
 * runs or GAP_SAMPLE_MAX of them, whichever comes first, stopping early at
 * 1 minute. A 5-field cron can't go below that (minutes are its finest
 * field, and nextOccurrence is strictly forward), so this is for choosing
 * defaults by gap (notify, slice 06), not a check that can refuse one.
 * Infinity for a once, or a cron that runs at most once more.
 */
export function minGapMinutes(when: When, from: number): number {
  if (when.kind === "once") return Infinity;
  if (when.kind === "interval") return when.everyMinutes;
  const fast = wallCronFor(when.expr);
  const first = fast.nextRun(new Date(wallMs(from, when.tz)));
  if (!first) return Infinity;
  let t = first.getTime();
  const start = t;
  let min = Infinity;
  for (let i = 0; i < GAP_SAMPLE_MAX; i++) {
    const n = fast.nextRun(new Date(t));
    if (!n) break;
    min = Math.min(min, n.getTime() - t);
    t = n.getTime();
    if (min <= MINUTE_MS || t - start >= DAY_MS) break;
  }
  return min / MINUTE_MS;
}

// --- Validation ---

/**
 * A `when` from a request, checked and filled in (a cron's default tz, an
 * interval's default anchor `now`), or why it can't be used. `now` is the
 * time it is made at: a once must be after it, and a cron must still run.
 */
export function parseWhen(when: any, now: number): { ok: true; when: When } | { ok: false; error: string } {
  if (!when || typeof when !== "object") return { ok: false, error: "when is required" };
  switch (when.kind) {
    case "once": {
      if (!isIsoInstant(when.at)) {
        return { ok: false, error: "when.at must be an ISO 8601 time with a zone, e.g. 2026-10-14T17:00:00Z" };
      }
      if (Date.parse(when.at) <= now) return { ok: false, error: "when.at must be in the future" };
      return { ok: true, when: { kind: "once", at: when.at } };
    }
    case "interval": {
      const every = when.everyMinutes;
      if (typeof every !== "number" || !Number.isInteger(every)) {
        return { ok: false, error: "when.everyMinutes must be a whole number of minutes" };
      }
      if (every < MIN_GAP_MINUTES) {
        return { ok: false, error: `when.everyMinutes must be at least ${MIN_GAP_MINUTES}: the shortest gap between runs is ${MIN_GAP_MINUTES} minute` };
      }
      if (every > EVERY_MINUTES_MAX) return { ok: false, error: `when.everyMinutes must be at most ${EVERY_MINUTES_MAX} (a year)` };
      let anchor: string;
      if (when.anchor === undefined) anchor = new Date(now).toISOString();
      else if (isIsoInstant(when.anchor)) anchor = when.anchor;
      else return { ok: false, error: "when.anchor must be an ISO 8601 time with a zone, e.g. 2026-10-14T17:00:00Z" };
      return { ok: true, when: { kind: "interval", everyMinutes: every, anchor } };
    }
    case "cron": {
      if (typeof when.expr !== "string" || !when.expr.trim()) return { ok: false, error: "when.expr is required: a 5-field cron pattern, e.g. \"0 9 * * 1-5\"" };
      const expr = when.expr.trim().replace(/\s+/g, " ");
      if (expr.length > CRON_EXPR_MAX) return { ok: false, error: `when.expr must be at most ${CRON_EXPR_MAX} characters` };
      const fields = expr.split(" ").length;
      // A nickname (@hourly, @daily, …) is one word; croner checks it.
      if (fields !== 5 && !expr.startsWith("@")) {
        const seconds = fields === 6 || fields === 7 ? "; seconds and years are not supported" : "";
        return { ok: false, error: `when.expr has ${fields} field${fields === 1 ? "" : "s"}: use a 5-field cron pattern (minute hour day month weekday), e.g. "0 9 * * 1-5"${seconds}` };
      }
      const zone = when.tz === undefined ? defaultTimeZone() : canonicalTimeZone(when.tz);
      if (!zone.ok) return zone;
      const parsed: When = { kind: "cron", expr, tz: zone.tz };
      let first: number | null;
      try {
        cronFor(expr, zone.tz);
        wallCronFor(expr);
        first = nextOccurrence(parsed, now);
      } catch (err: any) {
        return { ok: false, error: `when.expr is not a valid cron pattern: ${String(err?.message ?? err).replace(/^CronPattern: /, "")}` };
      }
      if (first == null) return { ok: false, error: "when.expr never comes due" };
      // No closest-gap check: a 5-field pattern's runs are never under a
      // minute apart (6 and 7 fields, the only way below it, are refused
      // above). See minGapMinutes.
      return { ok: true, when: parsed };
    }
    default:
      return { ok: false, error: `when.kind must be "once", "cron" or "interval"` };
  }
}

/**
 * Whether a stored `when` (perhaps written by hand, or by another build) is
 * one this build can work out times for. Cheap: patterns are cached.
 */
export function isUsableWhen(when: unknown): when is When {
  const w = when as any;
  if (!w || typeof w !== "object") return false;
  switch (w.kind) {
    case "once":
      return typeof w.at === "string" && !Number.isNaN(Date.parse(w.at));
    case "interval":
      return Number.isInteger(w.everyMinutes) && w.everyMinutes >= MIN_GAP_MINUTES
        && typeof w.anchor === "string" && !Number.isNaN(Date.parse(w.anchor));
    case "cron":
      if (typeof w.expr !== "string" || !isTimeZone(w.tz)) return false;
      try {
        cronFor(w.expr, w.tz);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}
