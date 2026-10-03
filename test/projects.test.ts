import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { createThread, dataDir, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import { addProject, getProjects, listProjects, projectId, scrubRemote } from "../src/project-index";
import { jarvisSystemPrompt } from "../src/jarvis";

// git here — the tests' own and the index's — must not depend on this
// machine's git config (default branch, hooks, signing, url rewrites).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const PROJECTS_FILE = join(dataDir(), "projects.json");
const THREADS_FILE = join(dataDir(), "threads.json");

const made: string[] = [];
process.on("exit", () => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A fresh temp dir, with symlinks resolved (/tmp on macOS), removed on exit. */
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-proj-")));
  made.push(dir);
  return dir;
}

/** A fresh folder with the given name, alone in its own temp dir. */
function tempFolder(name = "proj"): string {
  const dir = join(tempRoot(), name);
  mkdirSync(dir);
  return dir;
}

function gitInit(dir: string, remote?: string): void {
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "trunk");
  if (remote) run("remote", "add", "origin", remote);
}

function gitCommit(dir: string): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: dir,
    stdio: "ignore",
  });
}

beforeEach(() => {
  rmSync(PROJECTS_FILE, { force: true });
  rmSync(THREADS_FILE, { force: true });
});

test("the index is built on the first list_projects, from the folders threads ran in", () => {
  const a = tempFolder("alpha");
  const b = tempFolder("beta");
  createThread("some-bot", a);
  createThread("some-bot", b);
  createThread("other-bot", a);
  createThread(JARVIS_BOT_ID, jarvisDir());
  assert.equal(existsSync(PROJECTS_FILE), false, "nothing is built before Jarvis asks");

  const projects = listProjects();
  assert.equal(existsSync(PROJECTS_FILE), true);
  assert.deepEqual(projects.map((p) => p.name).sort(), ["alpha", "beta"], "deduped, and Jarvis's folder left out");
  assert.deepEqual(Object.keys(projects[0]).sort(), ["id", "name"], "the list stays light");
  assert.equal(projects.find((p) => p.name === "alpha")!.id, projectId(a));

  const stored = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
  assert.equal(stored.projects.length, 2);
  assert.equal(stored.projects[0].source, "thread");
});

test("a thread started in a new folder joins the index", () => {
  createThread("some-bot", tempFolder("first"));
  assert.deepEqual(listProjects().map((p) => p.name), ["first"]);
  createThread("some-bot", tempFolder("second"));
  assert.deepEqual(listProjects().map((p) => p.name), ["first", "second"]);
});

test("folders that no longer exist are dropped when listed", () => {
  const keep = tempFolder("keep");
  const gone = tempFolder("gone");
  createThread("some-bot", keep);
  createThread("some-bot", gone);
  assert.equal(listProjects().length, 2);

  rmSync(gone, { recursive: true });
  assert.deepEqual(listProjects().map((p) => p.name), ["keep"]);
  const stored = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
  assert.deepEqual(stored.projects.map((p: { path: string }) => p.path), [keep]);
});

test("get_projects on a pruned folder says it is unknown", async () => {
  const gone = tempFolder("gone");
  createThread("some-bot", gone);
  listProjects();
  rmSync(gone, { recursive: true });
  assert.deepEqual(await getProjects([projectId(gone)]), [{ id: projectId(gone), error: "no project with this id" }]);
});

test("colliding names carry their parent folder", () => {
  const root = tempRoot();
  const work = join(root, "work", "api");
  const personal = join(root, "personal", "api");
  mkdirSync(work, { recursive: true });
  mkdirSync(personal, { recursive: true });
  const solo = tempFolder("web");
  createThread("some-bot", work);
  createThread("some-bot", personal);
  createThread("some-bot", solo);
  assert.deepEqual(listProjects().map((p) => p.name), ["personal/api", "web", "work/api"]);
});

test("add_project rejects bad paths and dedupes by folder", () => {
  assert.equal(addProject("").ok, false);
  assert.equal(addProject("relative/path").ok, false);
  const missing = addProject(join(tmpdir(), "gitbot-no-such-folder-xyz"));
  assert.equal(missing.ok, false);
  assert.match((missing as { error: string }).error, /not an existing folder/);
  assert.equal(addProject(jarvisDir()).ok, false, "Jarvis's own folder is not a project");
  assert.equal(addProject(dataDir()).ok, false, "nor is gitbot's data dir");
  assert.equal(addProject("/").ok, false, "nor the filesystem root");
  assert.equal(addProject(homedir()).ok, false, "nor the home folder itself");
  assert.equal(addProject("~").ok, false);

  const dir = tempFolder("found");
  const first = addProject(dir);
  assert.ok(first.ok);
  assert.equal(first.project.name, "found");
  assert.equal(first.alreadyListed, false);

  // The same folder by another route, and one a thread already brought in.
  const link = join(tempRoot(), "link");
  symlinkSync(dir, link);
  const again = addProject(link);
  assert.ok(again.ok);
  assert.equal(again.alreadyListed, true);
  assert.equal(again.project.id, first.project.id);

  const threaded = tempFolder("threaded");
  createThread("some-bot", threaded);
  const fromThread = addProject(threaded);
  assert.ok(fromThread.ok && fromThread.alreadyListed);

  assert.deepEqual(listProjects().map((p) => p.name), ["found", "threaded"]);
  const stored = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
  assert.equal(stored.projects.find((p: { id: string }) => p.id === first.project.id).source, "added");
});

test("get_projects gives remote and branch for a git repo, and no git details for a plain folder", async () => {
  const repo = tempFolder("repo");
  gitInit(repo, "git@github.com:example/repo.git");
  const bare = tempFolder("bare");
  gitInit(bare);
  const plain = tempFolder("plain");
  createThread("some-bot", repo);
  createThread("some-bot", bare);
  createThread("some-bot", plain);
  listProjects();

  const [r, b, p, unknown] = await getProjects([projectId(repo), projectId(bare), projectId(plain), "p-nope"]);
  assert.deepEqual(r, {
    id: projectId(repo),
    name: "repo",
    folder: repo,
    git: { remote: "git@github.com:example/repo.git", branch: "trunk" },
  });
  assert.deepEqual(b, { id: projectId(bare), name: "bare", folder: bare, git: { remote: null, branch: "trunk" } });
  assert.deepEqual(p, { id: projectId(plain), name: "plain", folder: plain, git: null });
  assert.deepEqual(unknown, { id: "p-nope", error: "no project with this id" });
});

test("a folder inside a repo names the repo's root", async () => {
  const repo = tempFolder("mono");
  gitInit(repo);
  const sub = join(repo, "packages", "app");
  mkdirSync(sub, { recursive: true });
  const added = addProject(sub);
  assert.ok(added.ok);
  const [details] = await getProjects([added.project.id]);
  assert.deepEqual((details as { git: unknown }).git, { root: repo, remote: null, branch: "trunk" });
});

test("Jarvis's prompt resolves folders through the project tools", () => {
  const prompt = jarvisSystemPrompt();
  for (const name of ["list_projects", "get_projects", "add_project"]) assert.match(prompt, new RegExp(name));
  assert.match(prompt, /a project the user names \(earlier in this thread counts\),\s+resolved with list_projects/);
  assert.doesNotMatch(prompt, /not available yet/);
});

test("a thread folder reached through a symlink is one project, at its real path", () => {
  const real = tempFolder("real");
  const link = join(tempRoot(), "alias");
  symlinkSync(real, link);
  createThread("some-bot", link);
  createThread("some-bot", real);
  assert.deepEqual(listProjects(), [{ id: projectId(real), name: "real" }]);
});

test("a folder reached in another letter case is one project on a case-insensitive disk", (t) => {
  const real = tempFolder("Mixed");
  const upper = real.toUpperCase();
  if (!existsSync(upper)) return t.skip("case-sensitive filesystem");
  createThread("some-bot", real);
  createThread("some-bot", upper);
  assert.deepEqual(listProjects(), [{ id: projectId(real), name: "Mixed" }]);
});

test("a corrupt projects.json is set aside and the tools still work", async () => {
  writeFileSync(PROJECTS_FILE, "{ not json", "utf-8");
  const dir = tempFolder("survivor");
  createThread("some-bot", dir);
  assert.deepEqual(listProjects().map((p) => p.name), ["survivor"]);
  const aside = readdirSync(dataDir()).filter((f) => f.startsWith("projects.json.corrupt-"));
  assert.ok(aside.length >= 1, "the unreadable file is kept beside the new one");
  assert.equal(readFileSync(join(dataDir(), aside[aside.length - 1]), "utf-8"), "{ not json");
  assert.equal((await getProjects([projectId(dir)]))[0].id, projectId(dir));
  aside.forEach((f) => rmSync(join(dataDir(), f)));
});

test("malformed entries are skipped, not fatal", () => {
  const good = tempFolder("good");
  writeFileSync(
    PROJECTS_FILE,
    JSON.stringify({
      version: 1,
      builtAt: new Date().toISOString(),
      projects: [null, { id: 7, path: good }, { path: good }, { id: projectId(good), path: good, source: "added", addedAt: "" }],
    }),
    "utf-8",
  );
  assert.deepEqual(listProjects(), [{ id: projectId(good), name: "good" }]);
});

test("a detached HEAD reports the commit it sits on", async () => {
  const repo = tempFolder("detached");
  gitInit(repo);
  gitCommit(repo);
  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo, stdio: "ignore" });
  const added = addProject(repo);
  assert.ok(added.ok);
  const [details] = await getProjects([added.project.id]);
  assert.match((details as { git: { branch: string } }).git.branch, /^detached at [0-9a-f]{4,}$/);
});

test("remote URLs come back without credentials", async () => {
  assert.equal(scrubRemote("https://user:s3cret@github.com/acme/app.git"), "https://github.com/acme/app.git");
  assert.equal(scrubRemote("https://ghp_token@github.com/acme/app.git"), "https://github.com/acme/app.git");
  assert.equal(scrubRemote("ssh://git@host.example:2222/acme/app.git"), "ssh://host.example:2222/acme/app.git");
  assert.equal(scrubRemote("https://github.com/acme/app.git"), "https://github.com/acme/app.git");
  assert.equal(scrubRemote("git@github.com:acme/app.git"), "git@github.com:acme/app.git");
  assert.equal(scrubRemote("/srv/repos/app.git"), "/srv/repos/app.git");

  const repo = tempFolder("secret");
  gitInit(repo, "https://bob:tok3n@example.com/acme/secret.git");
  const added = addProject(repo);
  assert.ok(added.ok);
  const [details] = await getProjects([added.project.id]);
  assert.equal((details as { git: { remote: string } }).git.remote, "https://example.com/acme/secret.git");
  assert.doesNotMatch(JSON.stringify(details), /tok3n|bob/);
});

test("git ignores GIT_DIR and friends inherited from the server's environment", async () => {
  const other = tempFolder("other");
  gitInit(other, "git@example.com:wrong/repo.git");
  const repo = tempFolder("right");
  gitInit(repo, "git@example.com:right/repo.git");
  const added = addProject(repo);
  assert.ok(added.ok);
  process.env.GIT_DIR = join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  try {
    const [details] = await getProjects([added.project.id]);
    assert.equal((details as { git: { remote: string } }).git.remote, "git@example.com:right/repo.git");
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
  }
});
