import { execFile } from "child_process";
import { createHash } from "crypto";
import { type Dirent, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { readdir } from "fs/promises";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, sep } from "path";
import { dataDir, listThreads } from "./bot-store";

// The project index Jarvis resolves folders against. A project is a folder:
// a git repo found under the workspace (the folder gitbot was started in),
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

export type ProjectSource = "scan" | "thread" | "added";

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
  /** The last workspace scan: which folder, and when. Absent until the first. */
  scan?: { root: string; at: string; partial?: true };
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

/**
 * True only when the folder is known to be gone: missing, or not a folder.
 * Any other failure (permissions, a slow mount) keeps the entry.
 */
function folderGone(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch (err: any) {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR";
  }
}

/**
 * The folder's real path, or null when it is not a folder. The native
 * realpath also gives the on-disk letter case, so a folder reached as
 * ~/Code/App and ~/code/app on macOS is one project, not two.
 */
function resolveFolder(path: string): string | null {
  if (!path || !isDirectory(path)) return null;
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** True when `path` is `base` or below it. */
function isWithin(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
}

/**
 * gitbot's own data dir — which holds Jarvis's scratch folder — is never a
 * project. Resolved once and passed around, not once per entry.
 */
function ownFolder(): string {
  return resolveFolder(dataDir()) ?? dataDir();
}

/** The index on disk, or null when there is none (or it could not be used). */
function readIndex(): ProjectIndex | null {
  const file = indexFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) throw new Error("unrecognised shape");
    // One bad entry must not take every project tool down with it.
    const projects = (parsed.projects as unknown[]).filter(
      (p): p is ProjectEntry =>
        !!p && typeof (p as ProjectEntry).path === "string" && typeof (p as ProjectEntry).id === "string",
    );
    return { ...parsed, projects };
  } catch (err: any) {
    // Set it aside rather than overwrite it: folders Jarvis added are only here.
    const aside = `${file}.corrupt-${Date.now()}`;
    console.error(`[projects] could not read ${file} (${err.message}); moved to ${aside} and rebuilding`);
    try {
      renameSync(file, aside);
    } catch {
      // Rebuilding over it is still better than every tool failing.
    }
    return null;
  }
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
function addEntry(index: ProjectIndex, path: string, source: ProjectSource, own: string): boolean {
  if (isWithin(own, path)) return false;
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

  const own = ownFolder();
  const before = index.projects.length;
  index.projects = index.projects.filter((p) => !folderGone(p.path) && !isWithin(own, p.path));
  if (index.projects.length !== before) changed = true;

  // Oldest threads first, so entries keep the order their folders appeared in.
  const threads = [...listThreads()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const seen = new Set<string>();
  for (const thread of threads) {
    if (seen.has(thread.repoPath)) continue;
    seen.add(thread.repoPath);
    const folder = resolveFolder(thread.repoPath);
    if (folder && addEntry(index, folder, "thread", own)) changed = true;
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

// --- Workspace scan ---
// Repos under the workspace, found by their .git (a folder, or the file a
// worktree or submodule has). Run on the first list_projects, and again when
// the last scan is over a day old or was of another folder — never at server
// start. A big or slow tree must not stall the server: the walk is async,
// bounded in depth, in entries read and in time, and never follows symlinks.
// A scan cut short keeps what it found and is marked partial.

/** How far below the workspace repos are looked for. */
const SCAN_DEPTH = 4;
/** Directory entries read before the walk leaves the rest of the tree alone. */
const SCAN_ENTRY_CAP = 50_000;
/** One folder's read; a hung mount must not hold the walk. */
const READDIR_TIMEOUT_MS = 2_000;
/** The whole walk. */
const SCAN_DEADLINE_MS = 10_000;
const SCAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Heavy dependency and cache folders: never entered. Hidden ones are skipped
 * too. Names a real repo might have (build, out, dist) are walked as usual —
 * the walk stops at repo roots anyway.
 */
const SCAN_SKIP = new Set(["node_modules", "bower_components", "__pycache__", "venv", "Pods", "DerivedData"]);
/** Skipped only directly under home: macOS's Library, and folders that raise privacy prompts. */
const HOME_SKIP = new Set(["Library", "Pictures", "Music", "Movies"]);

/**
 * The workspace: the folder gitbot was started in. The server never changes
 * directory, so that is the process's working directory.
 */
function workspaceRoot(): string | null {
  return resolveFolder(process.cwd());
}

const isFsRoot = (folder: string) => folder === resolveFolder("/");

function scanStale(index: ProjectIndex | null, root: string, now = Date.now()): boolean {
  if (!index?.scan || index.scan.root !== root) return true;
  const at = Date.parse(index.scan.at);
  return !Number.isFinite(at) || at > now || now - at > SCAN_MAX_AGE_MS;
}

type ReadDir = (dir: string) => Promise<Dirent[]>;

export interface ScanOptions {
  readdir?: ReadDir;
  readdirTimeoutMs?: number;
  deadlineMs?: number;
}

export interface ScanResult {
  repos: string[];
  /** True when the walk was cut short — by the entry cap, a deadline or a hung read. */
  partial: boolean;
}

/** The promise's value, or "timeout" once `ms` has passed; never rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout" | "error"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  return Promise.race([promise.catch(() => "error" as const), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Git repos at `root` or up to SCAN_DEPTH folders below it, breadth first.
 * The walk stops at a repo, so a repo's nested repos and submodules are not
 * listed separately. A folder that cannot be read is passed over.
 */
export async function scanWorkspace(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const read1: ReadDir = opts.readdir ?? ((dir) => readdir(dir, { withFileTypes: true }));
  const perRead = opts.readdirTimeoutMs ?? READDIR_TIMEOUT_MS;
  const deadline = Date.now() + (opts.deadlineMs ?? SCAN_DEADLINE_MS);
  const repos: string[] = [];
  const own = ownFolder();
  // Resolved once, not once per folder.
  const home = resolveFolder(homedir()) ?? homedir();
  const fsRoot = resolveFolder("/");
  let read = 0;
  let partial = false;
  let level = [root];
  for (let depth = 0; depth <= SCAN_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const left = deadline - Date.now();
      if (read >= SCAN_ENTRY_CAP || left <= 0) return { repos, partial: true };
      if (isWithin(own, dir)) continue;
      const entries = await within(read1(dir), Math.min(perRead, left));
      if (entries === "timeout") {
        partial = true;
        continue;
      }
      if (entries === "error") continue;
      read += entries.length;
      const isRepo = entries.some((e) => e.name === ".git" && (e.isDirectory() || e.isFile()));
      // A home folder kept in git (dotfiles) is not a project: look inside it.
      if (isRepo && dir !== home && dir !== fsRoot) {
        repos.push(dir);
        continue;
      }
      if (depth === SCAN_DEPTH) continue;
      for (const e of entries) {
        // A Dirent for a symlink is never isDirectory(), so links are not followed.
        if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP.has(e.name)) continue;
        if (HOME_SKIP.has(e.name) && dir === home) continue;
        next.push(join(dir, e.name));
      }
    }
    level = next;
  }
  return { repos, partial };
}

let scansStarted = 0;
/** How many workspace scans this process has started. For tests. */
export function workspaceScanCount(): number {
  return scansStarted;
}

let inFlight: Promise<void> | null = null;
let loggedRootSkip = false;
let scanOverrides: ScanOptions = {};

/** Swaps in a readdir or shorter deadlines for the scans list_projects runs. For tests. */
export function setScanOptionsForTests(opts: ScanOptions): void {
  scanOverrides = opts;
}

/**
 * Rescans the workspace when the last scan is stale or was of another folder,
 * merging what it finds into the index. Concurrent callers share one scan.
 * Never throws: a failed scan leaves the index as it was.
 */
function ensureScanned(): Promise<void> {
  if (inFlight) return inFlight;
  let root: string | null;
  try {
    root = workspaceRoot();
    if (!root) return Promise.resolve();
    // The filesystem root is no one's workspace; walking it finds nothing useful.
    if (isFsRoot(root)) {
      if (!loggedRootSkip) console.log("[projects] not scanning: gitbot was started in /, which is too broad a workspace");
      loggedRootSkip = true;
      return Promise.resolve();
    }
    if (!scanStale(readIndex(), root)) return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  const scanRoot = root;
  scansStarted++;
  console.log(`[projects] scanning ${scanRoot}`);
  inFlight = (async () => {
    try {
      const { repos, partial } = await scanWorkspace(scanRoot, scanOverrides);
      if (partial) console.warn(`[projects] scan of ${scanRoot} was cut short; the project list may be incomplete`);
      // Read afresh: the index may have changed while the walk was out.
      const index = syncedIndex();
      const own = ownFolder();
      for (const folder of repos) {
        if (isDirectory(folder)) addEntry(index, folder, "scan", own);
      }
      index.scan = { root: scanRoot, at: new Date().toISOString(), ...(partial ? { partial: true } : {}) };
      writeIndex(index);
    } catch (err: any) {
      console.error(`[projects] workspace scan of ${scanRoot} failed: ${err?.message ?? err}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// --- Tool handlers ---
// Plain functions, so they can be tested without the SDK.

export interface ProjectListing {
  id: string;
  name: string;
}

/**
 * Every project's id and name, by name. Builds the index the first time, and
 * rescans the workspace when the last scan is stale.
 */
export async function listProjects(): Promise<{ projects: ProjectListing[]; partial?: true }> {
  await ensureScanned();
  const { projects, scan } = syncedIndex();
  const names = displayNames(projects);
  const listing = projects
    .map((p) => ({ id: p.id, name: names.get(p.id)! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // The last workspace scan was cut short: some repos may be missing.
  return scan?.partial ? { projects: listing, partial: true } : { projects: listing };
}

/**
 * A project's folder by id, from the index as it stands — no workspace scan.
 * Ids come from list_projects or add_project.
 */
export function findProject(id: string): { id: string; path: string } | undefined {
  const entry = syncedIndex().projects.find((p) => p.id === id);
  return entry && { id: entry.id, path: entry.path };
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

/**
 * Variables that would point git somewhere other than the folder asked
 * about, should the server have been started with them set.
 */
const REPO_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_CEILING_DIRECTORIES",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of REPO_LOCATION_VARS) delete env[name];
  return env;
}

/**
 * A remote URL without its credentials: https://user:token@host/x becomes
 * https://host/x. scp-style git@host:path has no secret and is left as is.
 */
export function scrubRemote(remote: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return remote;
  try {
    const url = new URL(remote);
    if (!url.username && !url.password) return remote;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Unparseable but scheme-shaped: drop anything before an @ in the authority.
    return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

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
        env: gitEnv(),
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
  return { ...(root !== folder ? { root } : {}), remote: remote ? scrubRemote(remote) : null, branch };
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

/** One project's name and folder, without the git peek; undefined for an unknown id. */
export function findProject(id: string): { id: string; name: string; folder: string } | undefined {
  const { projects } = syncedIndex();
  const entry = projects.find((p) => p.id === id);
  if (!entry) return undefined;
  return { id, name: displayNames(projects).get(id)!, folder: entry.path };
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
  const own = ownFolder();
  if (isWithin(own, folder)) return { ok: false, error: "that is gitbot's own data folder, not a project" };
  const home = resolveFolder(homedir()) ?? homedir();
  if (folder === home || folder === resolveFolder("/")) {
    return { ok: false, error: `too broad to be a project: ${folder}` };
  }

  const index = syncedIndex();
  const added = addEntry(index, folder, "added", own);
  if (added) writeIndex(index);
  const id = projectId(folder);
  const names = displayNames(index.projects);
  return { ok: true, project: { id, name: names.get(id) ?? basename(folder) }, alreadyListed: !added };
}
