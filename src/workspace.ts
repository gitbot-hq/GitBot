import { existsSync } from "fs";
import { mkdir, readdir, stat, readFile as fsReadFile } from "fs/promises";
import { join, resolve, extname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

export interface RepoInfo {
  name: string;   // folder name
  path: string;   // absolute path
  isGit: boolean; // has .git directory
}

// List subdirectories in workspace that are (or can be) git repos
export async function listRepos(workspaceDir: string): Promise<RepoInfo[]> {
  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    const repos: RepoInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const absPath = join(workspaceDir, entry.name);
      const isGit = existsSync(join(absPath, ".git"));
      repos.push({ name: entry.name, path: absPath, isGit });
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
    return repos;
  } catch {
    return [];
  }
}

export interface LastCommit {
  message: string;
  hash: string;
  timestamp: number; // unix seconds
}

export interface RepoDetails {
  branch: string | null;
  lastCommit: LastCommit | null;
  dominantLanguage: string | null;
}

export function getRepoDetails(repoPath: string): RepoDetails {
  // Branch
  let branch: string | null = null;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch { /* not a git repo or no commits */ }

  // Last commit
  let lastCommit: LastCommit | null = null;
  try {
    const raw = execSync("git log -1 --format=%s|%H|%ct", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }).trim();
    const [message, hash, ct] = raw.split("|");
    if (hash) {
      lastCommit = { message: message ?? "", hash, timestamp: parseInt(ct ?? "0", 10) };
    }
  } catch { /* empty repo or no commits */ }

  // Dominant language via git ls-files (fast, respects .gitignore)
  let dominantLanguage: string | null = null;
  try {
    const files = execSync("git ls-files -z", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" });
    const counts = new Map<string, number>();
    for (const file of files.split("\0")) {
      const ext = extname(file).toLowerCase().slice(1);
      if (!ext) continue;
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
    if (counts.size > 0) {
      dominantLanguage = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  } catch { /* not a git repo */ }

  return { branch, lastCommit, dominantLanguage };
}

// Create a new empty folder in workspaceDir; returns the absolute path
export async function createFolder(name: string, workspaceDir: string): Promise<string> {
  // Strip path separators to prevent traversal
  const safeName = name.replace(/[/\\]/g, "").trim();
  if (!safeName) throw new Error("Invalid folder name");
  const absPath = join(workspaceDir, safeName);
  if (existsSync(absPath)) throw new Error(`Folder "${safeName}" already exists`);
  await mkdir(absPath, { recursive: false });
  return absPath;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
}

// List entries in dirPath, validated to be inside repoRoot
export async function listDir(dirPath: string, repoRoot: string): Promise<DirEntry[]> {
  const resolvedDir = resolve(dirPath);
  const resolvedRoot = resolve(repoRoot);
  if (!resolvedDir.startsWith(resolvedRoot)) {
    throw new Error("Path is outside the selected repository");
  }
  const entries = await readdir(resolvedDir, { withFileTypes: true });
  const result: DirEntry[] = [];
  for (const entry of entries) {
    const entryPath = join(resolvedDir, entry.name);
    if (entry.isDirectory()) {
      result.push({ name: entry.name, path: entryPath, type: "directory", size: null });
    } else if (entry.isFile()) {
      const s = await stat(entryPath);
      result.push({ name: entry.name, path: entryPath, type: "file", size: s.size });
    }
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return result;
}

// Read a file, validated to be inside repoRoot; enforces 5 MB max
export async function readFile(filePath: string, repoRoot: string): Promise<{ content: string; size: number }> {
  const resolvedFile = resolve(filePath);
  const resolvedRoot = resolve(repoRoot);
  if (!resolvedFile.startsWith(resolvedRoot)) {
    throw new Error("Path is outside the selected repository");
  }
  const s = await stat(resolvedFile);
  const MAX_SIZE = 5 * 1024 * 1024;
  if (s.size > MAX_SIZE) {
    throw new Error(`File exceeds 5 MB limit (${s.size} bytes)`);
  }
  const content = await fsReadFile(resolvedFile, "utf-8");
  return { content, size: s.size };
}

// Clone a repo URL into workspaceDir; returns the absolute path to the cloned folder
export function cloneRepo(url: string, workspaceDir: string): string {
  // Parse folder name from URL (strip .git suffix if present)
  const raw = url.split("/").pop() ?? "repo";
  const folderName = raw.replace(/\.git$/, "") || "repo";
  execSync(`git clone ${JSON.stringify(url)} ${JSON.stringify(folderName)}`, {
    cwd: workspaceDir,
    stdio: "pipe",
  });
  return join(workspaceDir, folderName);
}

export interface BrowseResult {
  path: string;              // absolute path being listed
  parent: string | null;     // absolute path one level up, null at the filesystem root
  workspace: string;         // the directory the CLI was started in
  home: string;              // the user's home directory
  dirs: { name: string; path: string }[];
}

// List the subdirectories of dirPath for the folder picker. The picker roams the
// whole filesystem: a thread may run anywhere the CLI's own user can read.
export async function browseDirs(dirPath: string, workspaceDir: string): Promise<BrowseResult> {
  const target = resolve(dirPath);
  const entries = await readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: join(target, e.name) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const up = resolve(target, "..");
  return {
    path: target,
    parent: up === target ? null : up,
    workspace: resolve(workspaceDir),
    home: homedir(),
    dirs,
  };
}
