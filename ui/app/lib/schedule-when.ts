// The schedule form's "when" picker as plain functions: a preset choice to
// the server's `when` (toWhen), a stored `when` back to a preset where it is
// a simple one (fromWhen, for editing), and a name suggested from the
// message. No cron is checked or worked out here: the server's preview
// (POST /schedules/preview) says what a `when` means and when it runs.

import type { ProjectFolder, Schedule, ScheduleNotify, SchedulePatch, ScheduleWhen } from "./gitbot";

export type WhenChoice =
  | { preset: "in"; minutes: number }
  /** A wall time ("2026-10-20T09:00") read in the form's zone. */
  | { preset: "once"; localDateTime: string }
  | { preset: "daily"; time: string }
  | { preset: "weekdays"; time: string }
  /** `days`: 0 Sunday to 6 Saturday. */
  | { preset: "weekly"; days: number[]; time: string }
  | { preset: "monthly"; day: number; time: string }
  | { preset: "every"; amount: number; unit: "minutes" | "hours" }
  | { preset: "cron"; expr: string };

export type WhenPreset = WhenChoice["preset"];

/** Once or repeating: the form's segmented control. */
export function isOncePreset(preset: WhenPreset): boolean {
  return preset === "in" || preset === "once";
}

const TIME = /^(\d{2}):(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const pad = (n: number) => String(n).padStart(2, "0");

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `t`, as if it were UTC (ms). */
function wallMs(t: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(t))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The wall time in `tz` at `t`, as a datetime-local value: "2026-10-20T09:00". */
export function localDateTimeIn(t: number, tz: string): string {
  const w = new Date(wallMs(t, tz));
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

/**
 * A wall time ("2026-10-20T09:00") in `tz` as an ISO instant (UTC), or null
 * when it isn't a real time there (a bad date, or one the clocks skip).
 * When the clocks go back and it happens twice, the first.
 */
export function zonedToIso(local: string, tz: string): string | null {
  const m = LOCAL.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) return null;
  let offsets: Set<number>;
  try {
    offsets = new Set([wall - 12 * 3_600_000, wall, wall + 12 * 3_600_000].map((x) => wallMs(x, tz) - x));
  } catch {
    return null;
  }
  const fits = [...offsets].map((o) => wall - o).filter((t) => wallMs(t, tz) === wall).sort((a, b) => a - b);
  return fits.length ? new Date(fits[0]).toISOString() : null;
}

/** Tomorrow at `time` ("09:00") in `tz`, as a datetime-local value. */
export function tomorrowAt(time: string, tz: string, now: number = Date.now()): string {
  const today = localDateTimeIn(now, tz).slice(0, 10);
  const next = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000);
  return `${next.toISOString().slice(0, 10)}T${time}`;
}

function cronAt(time: string, rest: string): string | null {
  const m = TIME.exec(time);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${Number(m[2])} ${Number(m[1])} ${rest}`;
}

/**
 * The server's `when` for a choice, in zone `tz` (a cron's, and a once's
 * wall time). Null while the choice is incomplete or can't be a time (no
 * weekday picked, a time the clocks skip). Ranges are left to the server.
 */
export function toWhen(choice: WhenChoice, tz: string, now: number = Date.now()): ScheduleWhen | null {
  const cron = (expr: string | null): ScheduleWhen | null => (expr ? { kind: "cron", expr, tz } : null);
  switch (choice.preset) {
    case "in":
      return { kind: "once", at: new Date(now + choice.minutes * 60_000).toISOString() };
    case "once": {
      const at = zonedToIso(choice.localDateTime, tz);
      return at ? { kind: "once", at } : null;
    }
    case "daily":
      return cron(cronAt(choice.time, "* * *"));
    case "weekdays":
      return cron(cronAt(choice.time, "* * 1-5"));
    case "weekly": {
      const days = [...new Set(choice.days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
      return days.length ? cron(cronAt(choice.time, `* * ${days.join(",")}`)) : null;
    }
    case "monthly":
      return cron(cronAt(choice.time, `${choice.day} * *`));
    case "every": {
      if (!Number.isFinite(choice.amount)) return null;
      return { kind: "interval", everyMinutes: choice.unit === "hours" ? choice.amount * 60 : choice.amount };
    }
    case "cron": {
      const expr = choice.expr.trim();
      return expr ? { kind: "cron", expr, tz } : null;
    }
  }
}

/**
 * A stored `when` as the preset that makes it, best-effort: the crons
 * toWhen writes map back; anything else is "cron". A once reads in `tz`.
 */
export function fromWhen(when: ScheduleWhen, tz: string): WhenChoice {
  // One this build can't read (hand-edited, or a later build's kind): an
  // empty custom cron, for the user to fill in, rather than a throw.
  if (!isReadableWhen(when)) return { preset: "cron", expr: "" };
  if (when.kind === "once") {
    const local = safeLocal(when.at, tz);
    return { preset: "once", localDateTime: local };
  }
  if (when.kind === "interval") {
    const n = when.everyMinutes;
    return n % 60 === 0 ? { preset: "every", amount: n / 60, unit: "hours" } : { preset: "every", amount: n, unit: "minutes" };
  }
  const expr = when.expr.trim().replace(/\s+/g, " ");
  const m = /^(\d{1,2}) (\d{1,2}) (\S+) \* (\S+)$/.exec(expr);
  if (m && Number(m[1]) <= 59 && Number(m[2]) <= 23) {
    const time = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
    const [, , , dom, dow] = m;
    if (dom === "*" && dow === "*") return { preset: "daily", time };
    if (dom === "*" && dow === "1-5") return { preset: "weekdays", time };
    if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
      const days = [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b);
      return { preset: "weekly", days, time };
    }
    if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
      return { preset: "monthly", day: Number(dom), time };
    }
  }
  return { preset: "cron", expr };
}

export const NAME_SUGGEST_MAX = 60;

/**
 * A name from the message: its first 6 words, at most 60 characters, on one
 * line, without the quotes and < > a schedule's name can't have.
 */
export function suggestName(prompt: string): string {
  const words = prompt.replace(/["'`<>“”‘’]/g, "").split(/\s+/).filter(Boolean).slice(0, 6);
  let name = "";
  for (const w of words) {
    const next = name ? `${name} ${w}` : w;
    if (next.length > NAME_SUGGEST_MAX) {
      if (!name) name = w.slice(0, NAME_SUGGEST_MAX);
      break;
    }
    name = next;
  }
  return name;
}

/** The "In 15 min", "In 1 hour" chips. */
export const IN_CHIPS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "In 15 min" },
  { minutes: 60, label: "In 1 hour" },
];

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The browser's zone, or UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every zone the browser knows, with `current` in it. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

/** "Schedule this: <message>, <describe>", the draft Ask Jarvis instead leaves. */
export function askJarvisDraft(prompt: string, describe: string | undefined): string {
  const words = prompt.trim();
  return describe ? `Schedule this: ${words}, ${describe}` : `Schedule this: ${words}`;
}

/** The D4 note on a Jarvis thread target (plan §5). */
export const JARVIS_TARGET_NOTE =
  "Jarvis will receive this as a reminder to pass on, not as a task to do. To have Jarvis do something on a schedule, ask Jarvis.";

/** A thread the form can target, named. */
export type FormTarget = { threadId: string; title: string; botId: string; botName: string; jarvis: boolean };

export type PickerGroup = { botId: string; botName: string; jarvis: boolean; threads: FormTarget[] };

/**
 * The target picker's list: every thread but setup threads, grouped by bot,
 * each group and its threads newest activity first, filtered by `query`
 * (title or bot name). Jarvis threads are offered (D4: the form notes them).
 */
export function pickerGroups(
  threads: readonly { id: string; botId: string; title: string; kind?: string; lastActivityAt?: string; updatedAt?: string }[],
  bots: readonly { id: string; name: string }[],
  query: string,
  jarvisBotId: string,
): PickerGroup[] {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const q = query.trim().toLowerCase();
  const at = (t: { lastActivityAt?: string; updatedAt?: string }) => Date.parse(t.lastActivityAt ?? t.updatedAt ?? "") || 0;
  const groups = new Map<string, { group: PickerGroup; newest: number }>();
  for (const t of [...threads].sort((a, b) => at(b) - at(a))) {
    if (t.kind === "setup") continue;
    const botName = names.get(t.botId) ?? "Unknown bot";
    if (q && !t.title.toLowerCase().includes(q) && !botName.toLowerCase().includes(q)) continue;
    let entry = groups.get(t.botId);
    if (!entry) {
      entry = { group: { botId: t.botId, botName, jarvis: t.botId === jarvisBotId, threads: [] }, newest: at(t) };
      groups.set(t.botId, entry);
    }
    entry.group.threads.push({ threadId: t.id, title: t.title || "Untitled", botId: t.botId, botName, jarvis: t.botId === jarvisBotId });
  }
  return [...groups.values()].sort((a, b) => b.newest - a.newest).map((e) => e.group);
}

// ---- Editing (06) ----------------------------------------------------------

export type { SchedulePatch };

/**
 * The fields whose change takes a Jarvis "own-words" schedule out of
 * Jarvis's hands for good: the server's REARMING_FIELDS (src/schedules.ts),
 * kept equal by a test. `enabled` is not one (D3: a resume doesn't demote).
 */
export const DEMOTING_FIELDS = ["name", "prompt", "when", "maxRuns", "endsAt"] as const;

/** True when saving `patch` would demote an own-words schedule. */
export function patchDemotes(patch: SchedulePatch): boolean {
  return DEMOTING_FIELDS.some((k) => patch[k] !== undefined);
}

/** Whether two `when`s are the same times (a once to the second's instant, a cron's spacing ignored). */
export function sameWhen(a: ScheduleWhen, b: ScheduleWhen): boolean {
  if (a.kind === "once" && b.kind === "once") return Date.parse(a.at) === Date.parse(b.at);
  if (a.kind === "interval" && b.kind === "interval") return a.everyMinutes === b.everyMinutes;
  if (a.kind === "cron" && b.kind === "cron") {
    const norm = (e: string) => e.trim().replace(/\s+/g, " ");
    return norm(a.expr) === norm(b.expr) && a.tz === b.tz;
  }
  return false;
}

/** The form's values after an edit. `when` undefined: the times weren't touched. */
export type EditedSchedule = {
  name: string;
  prompt: string;
  when?: ScheduleWhen;
  notify: ScheduleNotify;
  overlap: "queue" | "skip";
  maxRuns?: number;
  endsAt?: string;
};

type Editable = Pick<Schedule, "name" | "prompt" | "when" | "notify" | "overlap" | "maxRuns" | "endsAt">;

/**
 * The PATCH body for an edit: only the fields that changed, so nothing
 * untouched is sent (and nothing demotes by accident). A cleared limit is
 * null. A schedule that is (or becomes) a once sends no limits: it has none.
 * Empty when nothing changed.
 */
export function diffSchedule(s: Editable, e: EditedSchedule): SchedulePatch {
  const out: SchedulePatch = {};
  if (e.name.trim() !== s.name) out.name = e.name.trim();
  if (e.prompt !== s.prompt) out.prompt = e.prompt;
  if (e.when && !sameWhen(s.when, e.when)) out.when = e.when;
  if (e.notify !== s.notify) out.notify = e.notify;
  if (e.overlap !== (s.overlap ?? "queue")) out.overlap = e.overlap;
  if ((out.when ?? s.when).kind !== "once") {
    if ((e.maxRuns ?? null) !== (s.maxRuns ?? null)) out.maxRuns = e.maxRuns ?? null;
    const at = (x: string | undefined) => (x ? Date.parse(x) : null);
    if (at(e.endsAt) !== at(s.endsAt)) out.endsAt = e.endsAt ?? null;
  }
  return out;
}

/** The form's fields, prefilled from a schedule being edited. */
export type EditInit = {
  choice: WhenChoice;
  /** A cron's own zone; else the viewer's. */
  tz: string;
  /** The end date as a wall time in `tz`, or "". */
  endsLocal: string;
};

export function editInit(s: Pick<Schedule, "when" | "endsAt">, viewerTz: string): EditInit {
  const cronTz = s.when?.kind === "cron" && typeof s.when.tz === "string" ? s.when.tz : "";
  const tz = cronTz && isZone(cronTz) ? cronTz : viewerTz;
  return {
    choice: fromWhen(s.when, tz),
    tz,
    endsLocal: s.endsAt ? safeLocal(s.endsAt, tz) : "",
  };
}

/**
 * True when this build can read a stored `when` (a once with a real instant,
 * a cron with a pattern and a zone it knows, an interval of whole minutes).
 * Edit isn't offered otherwise: the form would have nothing to start from.
 */
export function isReadableWhen(when: unknown): when is ScheduleWhen {
  if (!when || typeof when !== "object") return false;
  const w = when as Record<string, unknown>;
  if (w.kind === "once") return typeof w.at === "string" && Number.isFinite(Date.parse(w.at));
  if (w.kind === "cron") return typeof w.expr === "string" && !!w.expr.trim() && (w.tz === undefined || (typeof w.tz === "string" && isZone(w.tz)));
  if (w.kind === "interval") return typeof w.everyMinutes === "number" && Number.isInteger(w.everyMinutes) && w.everyMinutes > 0;
  return false;
}

function isZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** An instant as a wall time in `tz`, or "" when either can't be read. */
function safeLocal(at: string, tz: string): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  try {
    return localDateTimeIn(t, tz);
  } catch {
    return "";
  }
}

/**
 * "Suggested for <describe>: <label>", when the times changed and the
 * default for the new gap isn't what is picked. Null otherwise. It is only
 * a suggestion: the form never changes notify by itself.
 */
export function notifySuggestion(
  whenChanged: boolean,
  preview: { describe: string; defaultNotify: ScheduleNotify } | null,
  notify: ScheduleNotify,
): { text: string; notify: ScheduleNotify } | null {
  if (!whenChanged || !preview || preview.defaultNotify === notify) return null;
  return { text: `Suggested for ${preview.describe}: ${NOTIFY_LABELS[preview.defaultNotify]}`, notify: preview.defaultNotify };
}

export const NOTIFY_LABELS: Record<ScheduleNotify, string> = {
  always: "every run",
  "on-failure": "only if it fails",
  never: "never",
};

/** The own-words confirmation (plan §5). */
export const OWN_WORDS_CONFIRM =
  "Jarvis made this schedule from your request. If you change it here, Jarvis will treat its message as information, not as your instruction, from now on. To keep Jarvis acting on it, ask Jarvis to change it instead.";

// --- A new thread each run (sidebar slice 07) ---

export type NewThreadBot = { id: string; name: string; agent: boolean; disabled?: string };

/**
 * The bots a new-thread schedule can start: the user's bots, then the plain
 * agents, never Jarvis (the server refuses it). A bot whose setup hasn't
 * finished is listed but disabled, with why. An agent not installed here is
 * left to the preview: the server knows what is installed.
 */
export function newThreadBots(
  bots: readonly { id: string; name: string; builtin?: string; setupInstructions?: string; setupStatus?: string }[],
  jarvisId: string,
): NewThreadBot[] {
  const out = bots
    .filter((b) => b.id !== jarvisId && b.builtin !== "jarvis")
    .map((b): NewThreadBot => {
      const needsSetup = !!b.setupInstructions?.trim() && b.setupStatus !== "complete";
      return {
        id: b.id,
        name: b.name,
        agent: !!b.builtin,
        ...(needsSetup ? { disabled: b.setupStatus === "failed" ? "its setup failed" : "needs setup" } : {}),
      };
    });
  return [...out.filter((b) => !b.agent), ...out.filter((b) => b.agent)];
}

/** The project picker's list, filtered by name or folder; gone folders stay listed (disabled). */
export function projectMatches(projects: readonly ProjectFolder[], query: string): ProjectFolder[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
}

/** The note under a new-thread target. No model or effort: the bot decides (L1). */
export function newThreadNote(name: string, project: string): string {
  return `Each run makes a thread named “${name.trim() || "<name>"} · <date>” in ${project}. It runs the bot's own model and auto-approves.`;
}
