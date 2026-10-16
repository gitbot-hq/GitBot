import { getBot, getThread, isJarvisBot, setScheduleNote, type ScheduleNote } from "./bot-store";
import { NAME_MAX, targetThreadId, type Schedule } from "./schedules";

// Schedule notes: how a Jarvis thread learns what the schedules it made did,
// without a turn of its own. Each schedule keeps one status line on its
// notesTo thread (Thread.scheduleNotes), replaced as things happen, never
// appended to:
//   [schedule "Nightly audit": 3 runs since your last message, last done, thread <id>]
//   [schedule "Nightly audit" missed 2 runs while gitbot was down]
//   [schedule "Nightly audit" paused after 3 failed runs]
// (and those joined with "; " when more than one happened). The lines go to
// Jarvis with the user's next message there, after its pending note
// (child-lock.ts, pendingNoteFor), and are then cleared, so the count starts
// again. A note never starts a turn: it waits for the user. Its words are
// gitbot's own, the schedule's name (no quotes or <>) and ids: never a
// run's text, so nothing in it can pose as the user. The UI hides the lines
// in the user's bubble (ui/app/lib/gitbot-note.ts), and Jarvis's prompt says
// they are status, not instructions.

/** What happened to a schedule, for its note. */
export type ScheduleNoteEvent =
  /** A run ended (a started turn's end), or failed to start. */
  | { kind: "run"; outcome: "done" | "failed" | "stopped" | "failed to start"; threadId?: string }
  /** Runs that came due while gitbot was down (at startup, or a suspended process). */
  | { kind: "missed"; count: number }
  /** It paused itself: gitbot's fixed words, e.g. "paused after 3 failed runs". */
  | { kind: "paused"; words: string };

/**
 * Updates the schedule's line on its notesTo Jarvis thread. A run on that
 * thread itself leaves none: Jarvis saw it, as a turn of its own. Nothing
 * when it has no notesTo, or that thread is gone or no Jarvis thread. Never
 * throws: a note is worth a log line, never a run.
 */
export function noteSchedule(s: Pick<Schedule, "id" | "name" | "notesTo" | "target">, event: ScheduleNoteEvent): void {
  const jarvisId = s.notesTo;
  if (!jarvisId) return;
  if (event.kind === "run" && targetThreadId(s) === jarvisId) return;
  if (event.kind === "missed" && !(event.count > 0)) return;
  try {
    const jarvis = getThread(jarvisId);
    if (!jarvis || !isJarvisBot(getBot(jarvis.botId))) return;
    setScheduleNote(jarvisId, s.id, (before) => {
      const note = withEvent(before, event);
      return { ...note, line: scheduleNoteLine(s.name, note) };
    });
  } catch (err: any) {
    console.error(`[schedules] ${s.id}: could not note it on thread ${jarvisId}: ${err?.message ?? err}`);
  }
}

/** The note with one more thing that happened since the user's last message. */
function withEvent(before: ScheduleNote | undefined, event: ScheduleNoteEvent): Omit<ScheduleNote, "line"> {
  const note: Omit<ScheduleNote, "line"> = {
    runs: Number.isInteger(before?.runs) && before!.runs > 0 ? before!.runs : 0,
    ...(before?.last ? { last: before.last } : {}),
    ...(before?.missed ? { missed: before.missed } : {}),
    ...(before?.paused ? { paused: before.paused } : {}),
  };
  if (event.kind === "run") {
    note.runs += 1;
    note.last = { outcome: event.outcome, ...(event.threadId ? { threadId: event.threadId } : {}) };
    // It ran, so it is no longer paused.
    delete note.paused;
  } else if (event.kind === "missed") {
    if (event.count > 0) note.missed = (note.missed ?? 0) + event.count;
  } else {
    note.paused = event.words;
  }
  return note;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The line itself. The name is cleaned again here (it was checked on create,
 * but the file can be edited by hand): one line, no quotes, brackets or <>.
 */
export function scheduleNoteLine(name: string, note: Omit<ScheduleNote, "line">): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/["'<>[\]\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX) || "unnamed";
  const head = `[schedule "${clean}"`;
  const states = [
    note.missed ? `missed ${plural(note.missed, "run")} while gitbot was down` : "",
    note.paused ?? "",
  ].filter(Boolean);
  const runs = note.runs > 0
    ? `${plural(note.runs, "run")} since your last message, last ${note.last?.outcome ?? "done"}${note.last?.threadId ? `, thread ${note.last.threadId}` : ""}`
    : "";
  if (!states.length) return `${head}: ${runs}]`;
  return `${head} ${[...states, runs].filter(Boolean).join("; ")}]`;
}
