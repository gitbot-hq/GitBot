import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createThread, dataDir, JARVIS_BOT_ID, jarvisDir } from "../src/bot-store";
import { addProject, getProjects, listProjects, projectId } from "../src/project-index";
import { jarvisSystemPrompt } from "../src/jarvis";

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
  assert.match(prompt, /Starting threads is not available yet/);
});
