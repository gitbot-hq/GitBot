import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, sep } from "path";
import { dataDir, jarvisDir, listThreads } from "./bot-store";

// The project index Jarvis resolves folders against. A project is a folder:
// one a gitbot thread has run in, or one Jarvis added after finding it with
// its shell. Stored in projects.json under the data dir, and built the first
// time Jarvis asks for it — never at server start.
//
// Only folders are stored. Names are worked out when listed, since they
// depend on which other folders collide; git details are read live, on
// request, so they are never stale.
//
// Agents' own histories (~/.claude/projects and the like) are deliberately not
// a source: gitbot does not own those formats.

export type ProjectSource = "thread" | "added";

export interface ProjectEntry {
  /** Stable for a folder: derived from its path, so it survives rebuilds. */
  id: string;
  path: string;
  source: ProjectSource;
  addedAt: string;
}

interface ProjectIndex {
  version: 1;
  builtAt: string;
  projects: ProjectEntry[];
}

const indexFile = () => join(dataDir(), "projects.json");

/** A folder's id: a short hash of its resolved path. */
export function projectId(path: string): string {
  return `p-${createHash("sha1").update(path).digest("hex").slice(0, 10)}`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folder's real path (symlinks resolved), or null when it is not a folder. */
function resolveFolder(path: string): string | null {
  if (!path || !isDirectory(path)) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Jarvis's own scratch folder, and anything under it, is not a project. */
function isJarvisFolder(path: string): boolean {
  const own = resolveFolder(jarvisDir()) ?? jarvisDir();
  const rel = relative(own, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readIndex(): ProjectIndex | null {
  const file = indexFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed && Array.isArray(parsed.projects)) return parsed as ProjectIndex;
  } catch (err: any) {
    console.error(`[projects] could not read ${file}: ${err.message}`);
  }
  return null;
}

function writeIndex(index: ProjectIndex): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = indexFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), "utf-8");
  renameSync(tmp, file);
}

/** Adds a folder unless it is already there; true when it was added. */
function addEntry(index: ProjectIndex, path: string, source: ProjectSource): boolean {
  if (isJarvisFolder(path)) return false;
  const id = projectId(path);
  if (index.projects.some((p) => p.id === id)) return false;
  index.projects.push({ id, path, source, addedAt: new Date().toISOString() });
  return true;
}

/**
 * The index, brought up to date: created on first use, every thread folder
 * merged in (so a thread in a new folder shows up), and folders that no
 * longer exist dropped. Written back only when something changed.
 */
function syncedIndex(): ProjectIndex {
  const existing = readIndex();
  const index: ProjectIndex = existing ?? { version: 1, builtAt: new Date().toISOString(), projects: [] };
  let changed = !existing;

  const before = index.projects.length;
  index.projects = index.projects.filter((p) => isDirectory(p.path) && !isJarvisFolder(p.path));
  if (index.projects.length !== before) changed = true;

  // Oldest threads first, so entries keep the order their folders appeared in.
  const seen = new Set<string>();
  for (const thread of listThreads().reverse()) {
    if (seen.has(thread.repoPath)) continue;
    seen.add(thread.repoPath);
    const folder = resolveFolder(thread.repoPath);
    if (folder && addEntry(index, folder, "thread")) changed = true;
  }

  if (changed) writeIndex(index);
  return index;
}

/**
 * Display names: the folder's name, with parent folders added only as far as
 * needed to tell colliding names apart (`work/api`, `personal/api`).
 */
function displayNames(entries: readonly ProjectEntry[]): Map<string, string> {
  const parts = new Map(entries.map((e) => [e.id, e.path.split(sep).filter(Boolean)]));
  const depth = new Map(entries.map((e) => [e.id, 1]));
  const nameOf = (id: string) => {
    const p = parts.get(id)!;
    return p.slice(Math.max(0, p.length - depth.get(id)!)).join("/") || "/";
  };
  for (;;) {
    const groups = new Map<string, string[]>();
    for (const e of entries) {
      const name = nameOf(e.id);
      groups.set(name, [...(groups.get(name) ?? []), e.id]);
    }
    let grew = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        if (depth.get(id)! < parts.get(id)!.length) {
          depth.set(id, depth.get(id)! + 1);
          grew = true;
        }
      }
    }
    if (!grew) return new Map(entries.map((e) => [e.id, nameOf(e.id)]));
  }
}

// --- Tool handlers ---
// Plain functions, so they can be tested without the SDK.

export interface ProjectListing {
  id: string;
  name: string;
}

/** Every project's id and name, by name. Builds the index the first time. */
export function listProjects(): ProjectListing[] {
  const { projects } = syncedIndex();
  const names = displayNames(projects);
  return projects
    .map((p) => ({ id: p.id, name: names.get(p.id)! }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface GitDetails {
  /** The repo's top folder, when it is not the project folder itself. */
  root?: string;
  remote: string | null;
  branch: string | null;
}

export interface ProjectDetails {
  id: string;
  name: string;
  folder: string;
  /** Null when the folder is not in a git repo. */
  git: GitDetails | null;
}

export type ProjectLookup = ProjectDetails | { id: string; error: string };

const GIT_TIMEOUT_MS = 3000;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        // Never prompt, never take locks: these are read-only peeks.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (err, stdout) => resolve(err ? null : stdout.toString().trim()),
    );
  });
}

/** Remote and branch for a folder, from a few cheap git calls; null outside a repo. */
export async function gitDetails(folder: string): Promise<GitDetails | null> {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const [symbolic, remotes] = await Promise.all([
    // Works on a repo with no commits yet; fails on a detached HEAD.
    git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(folder, ["remote"]),
  ]);
  let branch = symbolic || null;
  if (!branch) {
    const sha = await git(folder, ["rev-parse", "--short", "HEAD"]);
    branch = sha ? `detached at ${sha}` : null;
  }
  const names = (remotes ?? "").split("\n").filter(Boolean);
  const remoteName = names.includes("origin") ? "origin" : names[0];
  const remote = remoteName ? await git(folder, ["remote", "get-url", remoteName]) : null;
  const root = resolveFolder(top) ?? top;
  return { ...(root !== folder ? { root } : {}), remote: remote || null, branch };
}

/** Folder and git details for each id asked for, in order. */
export async function getProjects(ids: readonly string[]): Promise<ProjectLookup[]> {
  const { projects } = syncedIndex();
  const names = displayNames(projects);
  return Promise.all(
    ids.map(async (id): Promise<ProjectLookup> => {
      const entry = projects.find((p) => p.id === id);
      if (!entry) return { id, error: "no project with this id" };
      return { id, name: names.get(id)!, folder: entry.path, git: await gitDetails(entry.path) };
    }),
  );
}

export type AddProjectResult =
  | { ok: true; project: ProjectListing; alreadyListed: boolean }
  | { ok: false; error: string };

/** Adds a folder Jarvis found. It must exist; a folder already listed is not added twice. */
export function addProject(path: string): AddProjectResult {
  const raw = (path ?? "").trim();
  if (!raw) return { ok: false, error: "path is required" };
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) return { ok: false, error: `path must be absolute: ${raw}` };
  const folder = resolveFolder(expanded);
  if (!folder) return { ok: false, error: `not an existing folder: ${raw}` };
  if (isJarvisFolder(folder)) return { ok: false, error: "that is Jarvis's own folder, not a project" };

  const index = syncedIndex();
  const added = addEntry(index, folder, "added");
  if (added) writeIndex(index);
  const id = projectId(folder);
  const names = displayNames(index.projects);
  return { ok: true, project: { id, name: names.get(id) ?? basename(folder) }, alreadyListed: !added };
}
