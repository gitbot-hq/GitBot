import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// The data directory and its JSON collections. Small collections, read fully
// and written atomically (a temp file, then a rename). Dependency-free, so any
// store (bot-store, schedules) can use it without importing another store.

// ~/.grass is the pre-rename location: keep using it when it exists and the new
// directory does not, so an upgrade doesn't orphan someone's bots and threads.
function resolveDataDir(): string {
  if (process.env.GITBOT_DATA_DIR) return process.env.GITBOT_DATA_DIR;
  if (process.env.GRASS_DATA_DIR) return process.env.GRASS_DATA_DIR;
  const current = join(homedir(), ".gitbot");
  const legacy = join(homedir(), ".grass");
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

const DATA_DIR = resolveDataDir();

/** The resolved gitbot data directory, shared by every module that persists state. */
export function dataDir(): string {
  return DATA_DIR;
}

/**
 * A JSON array file's items: none when the file is missing, or unreadable
 * (logged, under `tag`), or not an array.
 */
export function readCollection<T>(file: string, tag = "bot-store"): T[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    console.error(`[${tag}] could not read ${file}: ${err.message}`);
    return [];
  }
}

/**
 * Moves a collection file that is not a JSON array aside, to
 * `<file>.bad-<time>`, and logs where. A store calls it before a write, so a
 * file it could not read is kept rather than overwritten with what it holds
 * now. Returns the new path, or undefined when the file is fine or missing.
 */
export function quarantineCorrupt(file: string, tag: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    if (Array.isArray(JSON.parse(readFileSync(file, "utf-8")))) return undefined;
  } catch {
    // Unparseable (or unreadable): set it aside below.
  }
  const aside = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(file, aside);
    console.error(`[${tag}] ${file} could not be read; moved it to ${aside}`);
    return aside;
  } catch (err: any) {
    console.error(`[${tag}] could not move unreadable ${file} aside: ${err.message}`);
    // Refuse the write rather than lose the file.
    throw err;
  }
}

/** Writes the items as pretty JSON, atomically: a reader never sees half a file. */
export function writeCollection<T>(file: string, items: T[]): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2), "utf-8");
  renameSync(tmp, file);
}
