import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// bot-store sits under everything; schedules clean up after a deleted thread
// through its onThreadDeleted hook, so it never needs them. A plain static
// read of import statements: no module is loaded.

const SRC = join(__dirname, "..", "src");

/** The ./ modules a source file imports (or re-exports from), type-only ones included. */
function localImports(file: string): string[] {
  const text = readFileSync(join(SRC, `${file}.ts`), "utf-8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?\bfrom\s+["'](\.\/[^"']+)["']|(?:^|\n)\s*import\s+["'](\.\/[^"']+)["']|\brequire\(\s*["'](\.\/[^"']+)["']\s*\)|\bimport\(\s*["'](\.\/[^"']+)["']\s*\)/g)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? m[4]).slice(2).replace(/\.(?:ts|js)$/, ""));
  }
  return out;
}

/** Every local module `file` reaches through its imports. */
function reaches(file: string): Set<string> {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length) {
    const next = queue.shift()!;
    for (const dep of localImports(next)) {
      if (seen.has(dep) || !existsSync(join(SRC, `${dep}.ts`))) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return seen;
}

test("bot-store does not import schedules or scheduler", () => {
  const direct = localImports("bot-store");
  assert.ok(direct.includes("json-store"), `the import reader works: ${direct.join(", ")}`);
  const reached = reaches("bot-store");
  for (const banned of ["schedules", "scheduler", "schedule-notes"]) {
    assert.ok(!reached.has(banned), `bot-store reaches ${banned}: ${[...reached].join(", ")}`);
  }
});
