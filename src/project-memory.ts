import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { dataDir } from "./bot-store";
import { findProject, getProjects, type ProjectLookup } from "./project-index";

// Project memory: one lean markdown file per project, at
// <dataDir>/projects/<id>/memory.md, outside the repo. Shared by every Jarvis
// thread and read by Jarvis only, through get_projects. Jarvis changes it with
// remember and forget, which keep it to short bullets under a cap; the user
// can edit the file by hand, and lines that are not bullets are left alone.

/** The most bullets a project's memory holds; remember refuses past it. */
export const MEMORY_CAP = 20;

/** The longest note remember accepts, in characters. */
export const NOTE_MAX = 300;

/** Project ids as project-index makes them. Nothing else ever becomes a path. */
const PROJECT_ID = /^p-[0-9a-f]{10}$/;

const BULLET = /^\s*[-*+]\s+/;

export function isProjectId(id: string): boolean {
  return PROJECT_ID.test(id);
}

/** The memory file's path for a well-formed project id; throws otherwise. */
export function memoryPath(id: string): string {
  if (!isProjectId(id)) throw new Error(`invalid project id: ${id}`);
  return join(dataDir(), "projects", id, "memory.md");
}

/** The memory file's contents; empty when there is none yet. */
export function readMemory(id: string): string {
  try {
    return readFileSync(memoryPath(id), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** The bullets in a memory file, as plain text. */
export function memoryNotes(contents: string): string[] {
  return contents.split("\n").filter((l) => BULLET.test(l)).map((l) => l.replace(BULLET, "").trim());
}

function writeMemory(id: string, contents: string): void {
  const file = memoryPath(id);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, "utf-8");
  renameSync(tmp, file);
}

/** One line, no bullet marker, whitespace collapsed. */
function normalise(note: string): string {
  return (note ?? "").replace(BULLET, "").replace(/\s+/g, " ").trim();
}

type Match = { ok: true; line: number } | { ok: false; error: string };

/**
 * The line of the bullet a note names: exact text first, else the one bullet
 * containing it (case-insensitive). Ambiguity is an error, never a guess.
 */
function findBullet(lines: string[], wanted: string): Match {
  const bullets = lines.map((l, i) => ({ i, text: BULLET.test(l) ? normalise(l) : null })).filter((b) => b.text !== null);
  const exact = bullets.find((b) => b.text === wanted);
  if (exact) return { ok: true, line: exact.i };
  const needle = wanted.toLowerCase();
  const partial = bullets.filter((b) => b.text!.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, line: partial[0].i };
  if (partial.length > 1) return { ok: false, error: `more than one note matches "${wanted}"; quote one in full` };
  return { ok: false, error: `no note matches "${wanted}"` };
}

export type MemoryResult =
  | { ok: true; project: string; memory: string; notes: number }
  | { ok: false; error: string; notes?: string[] };

function checkProject(id: string): string | undefined {
  if (!isProjectId(id)) return `invalid project id: ${id}`;
  if (!findProject(id)) return "no project with this id";
  return undefined;
}

/**
 * Adds a note, or rewrites the one `replaces` names. A note already there is
 * not added twice. Past the cap it refuses and returns the notes, so Jarvis
 * can replace or forget one instead.
 */
export function remember(id: string, note: string, replaces?: string): MemoryResult {
  const bad = checkProject(id);
  if (bad) return { ok: false, error: bad };
  const text = normalise(note);
  if (!text) return { ok: false, error: "note is empty" };
  if (text.length > NOTE_MAX) return { ok: false, error: `note is too long (${text.length} characters, at most ${NOTE_MAX}); keep it to one short line` };

  const current = readMemory(id);
  const lines = current ? current.replace(/\n+$/, "").split("\n") : [`# Project memory · ${findProject(id)!.path}`, ""];
  const notes = memoryNotes(current);

  if (replaces !== undefined && normalise(replaces)) {
    const match = findBullet(lines, normalise(replaces));
    if (!match.ok) return { ok: false, error: match.error, notes };
    lines[match.line] = `- ${text}`;
  } else if (notes.includes(text)) {
    return { ok: true, project: id, memory: memoryPath(id), notes: notes.length };
  } else {
    if (notes.length >= MEMORY_CAP) {
      return {
        ok: false,
        error: `memory is full (${MEMORY_CAP} notes); replace or forget one first`,
        notes,
      };
    }
    // After the last bullet, so hand-written text below the list stays below it.
    let last = -1;
    lines.forEach((l, i) => { if (BULLET.test(l)) last = i; });
    lines.splice(last === -1 ? lines.length : last + 1, 0, `- ${text}`);
  }
  const contents = lines.join("\n") + "\n";
  writeMemory(id, contents);
  return { ok: true, project: id, memory: memoryPath(id), notes: memoryNotes(contents).length };
}

/** Removes the note `note` names (exact text, or a unique part of it). */
export function forget(id: string, note: string): MemoryResult {
  const bad = checkProject(id);
  if (bad) return { ok: false, error: bad };
  const wanted = normalise(note);
  if (!wanted) return { ok: false, error: "note is empty" };
  const current = readMemory(id);
  const lines = current.replace(/\n+$/, "").split("\n");
  const match = findBullet(lines, wanted);
  if (!match.ok) return { ok: false, error: match.error, notes: memoryNotes(current) };
  lines.splice(match.line, 1);
  const contents = lines.join("\n") + "\n";
  writeMemory(id, contents);
  return { ok: true, project: id, memory: memoryPath(id), notes: memoryNotes(contents).length };
}

export type ProjectWithMemory = ProjectLookup & { memory?: { path: string; contents: string } };

/** get_projects for Jarvis: each project's details plus its memory file. */
export async function getProjectsWithMemory(ids: readonly string[]): Promise<ProjectWithMemory[]> {
  const projects = await getProjects(ids);
  return projects.map((p) => ("error" in p ? p : { ...p, memory: { path: memoryPath(p.id), contents: readMemory(p.id) } }));
}
