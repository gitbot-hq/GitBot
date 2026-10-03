import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dataDir } from "../src/bot-store";
import { addProject, projectId } from "../src/project-index";
import {
  forget,
  getProjectsWithMemory,
  MEMORY_CAP,
  memoryNotes,
  memoryPath,
  readMemory,
  remember,
} from "../src/project-memory";
import { jarvisSystemPrompt } from "../src/jarvis";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const made: string[] = [];
process.on("exit", () => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// The workspace scan walks the cwd; keep it empty.
const EMPTY = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-mem-ws-")));
made.push(EMPTY);

/** A fresh folder, added to the index; returns its project id. */
function newProject(name = "proj"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gitbot-mem-")));
  made.push(root);
  const dir = join(root, name);
  mkdirSync(dir);
  const result = addProject(dir);
  assert.ok(result.ok);
  return result.project.id;
}

beforeEach(() => {
  process.chdir(EMPTY);
  rmSync(join(dataDir(), "projects"), { recursive: true, force: true });
});

test("a project with no memory file reads as empty", async () => {
  const id = newProject();
  assert.equal(readMemory(id), "");
  assert.ok(!existsSync(memoryPath(id)));
  const [details] = await getProjectsWithMemory([id]);
  assert.deepEqual((details as any).memory, { path: join(dataDir(), "projects", id, "memory.md"), contents: "" });
});

test("remember writes plain markdown under the data dir, and get_projects returns it", async () => {
  const id = newProject("trophy");
  const result = remember(id, "Open PRs as drafts");
  assert.ok(result.ok);
  assert.equal(result.notes, 1);
  const file = join(dataDir(), "projects", id, "memory.md");
  assert.equal(memoryPath(id), file);
  const contents = readFileSync(file, "utf-8");
  assert.match(contents, /^# Project memory/);
  assert.match(contents, /^- Open PRs as drafts$/m);

  remember(id, "  - Always use   Codex\nfor this repo ");
  assert.deepEqual(memoryNotes(readMemory(id)), ["Open PRs as drafts", "Always use Codex for this repo"]);

  const [details] = await getProjectsWithMemory([id]);
  assert.equal((details as any).name, "trophy");
  assert.equal((details as any).memory.contents, readFileSync(file, "utf-8"));
});

test("the same note is not added twice; replaces rewrites a note in place", () => {
  const id = newProject();
  remember(id, "Use npm");
  remember(id, "Open PRs as drafts");
  assert.ok(remember(id, "Use npm").ok);
  assert.deepEqual(memoryNotes(readMemory(id)), ["Use npm", "Open PRs as drafts"]);

  assert.ok(remember(id, "Use pnpm", "use NPM").ok);
  assert.deepEqual(memoryNotes(readMemory(id)), ["Use pnpm", "Open PRs as drafts"]);

  const missing = remember(id, "x", "yarn");
  assert.ok(!missing.ok);
  assert.match(missing.error, /no note matches/);
});

test("the cap is enforced: past it remember refuses and lists the notes, replaces still works", () => {
  const id = newProject();
  for (let i = 1; i <= MEMORY_CAP; i++) assert.ok(remember(id, `note ${i}.`).ok);
  const full = remember(id, "one too many");
  assert.ok(!full.ok);
  assert.match(full.error, /full/);
  assert.equal(full.notes?.length, MEMORY_CAP);
  assert.equal(memoryNotes(readMemory(id)).length, MEMORY_CAP);

  assert.ok(remember(id, "rewritten", "note 7.").ok);
  assert.equal(memoryNotes(readMemory(id)).length, MEMORY_CAP);
  assert.ok(forget(id, "note 1.").ok);
  assert.ok(remember(id, "one too many").ok);
  assert.equal(memoryNotes(readMemory(id)).length, MEMORY_CAP);
});

test("a long or empty note is refused", () => {
  const id = newProject();
  assert.ok(!remember(id, "x".repeat(400)).ok);
  assert.ok(!remember(id, "   ").ok);
  assert.ok(!existsSync(memoryPath(id)));
});

test("forget removes one note by its text or a unique part, and refuses ambiguity", () => {
  const id = newProject();
  remember(id, "Open PRs as drafts");
  remember(id, "Run tests with npm test");
  remember(id, "Run lint with npm run lint");

  const ambiguous = forget(id, "run");
  assert.ok(!ambiguous.ok);
  assert.match(ambiguous.error, /more than one/);

  assert.ok(forget(id, "drafts").ok);
  assert.ok(forget(id, "Run lint with npm run lint").ok);
  assert.deepEqual(memoryNotes(readMemory(id)), ["Run tests with npm test"]);
  assert.ok(!forget(id, "drafts").ok);
});

test("hand-written lines that are not bullets are kept", () => {
  const id = newProject();
  mkdirSync(join(dataDir(), "projects", id), { recursive: true });
  writeFileSync(memoryPath(id), "# Trophy\n\n* Ship on Fridays\n\nSome prose the user wrote.\n");
  remember(id, "Open PRs as drafts");
  forget(id, "Fridays");
  assert.equal(readMemory(id), "# Trophy\n\n- Open PRs as drafts\n\nSome prose the user wrote.\n");
});

test("unknown and malformed project ids are refused, and never become paths", async () => {
  const unknown = projectId("/nowhere/at/all");
  assert.match(unknown, /^p-[0-9a-f]{10}$/);
  const r = remember(unknown, "x");
  assert.ok(!r.ok);
  assert.match(r.error, /no project/);
  assert.ok(!forget(unknown, "x").ok);
  assert.ok(!existsSync(join(dataDir(), "projects", unknown)));

  for (const bad of ["../../etc", "p-../../x", "p-0123456789/..", "P-0123456789", "p-0123456789a", "", "p-012345678g"]) {
    assert.throws(() => memoryPath(bad), /invalid project id/);
    assert.throws(() => readMemory(bad), /invalid project id/);
    const res = remember(bad, "x");
    assert.ok(!res.ok);
    assert.match(res.error, /invalid project id/);
    assert.ok(!forget(bad, "x").ok);
  }
  assert.ok(!existsSync(join(dataDir(), "projects")));

  const [missing] = await getProjectsWithMemory([unknown]);
  assert.deepEqual(missing, { id: unknown, error: "no project with this id" });
});

test("Jarvis's prompt says when to remember and never to log tasks", () => {
  const prompt = jarvisSystemPrompt();
  assert.match(prompt, /remember only when the user states a preference/);
  assert.match(prompt, /Never record what you did/);
});
