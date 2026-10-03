// Preloaded into every test process by `npm test` (--import). bot-store reads
// GITBOT_DATA_DIR once, at module load, so it is set here, before any test file
// pulls the store in. Each test process gets its own throwaway directory, removed
// on exit, so a test run never reads or writes the real ~/.gitbot or ~/.grass.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PREFIX = join(tmpdir(), "gitbot-test-");

// A test file that imports this for TEST_DATA_DIR may get a second module
// instance alongside the preloaded one; reuse the directory the preload made.
const existing = process.env.GITBOT_DATA_DIR;
export const TEST_DATA_DIR = existing?.startsWith(PREFIX) ? existing : mkdtempSync(PREFIX);
process.env.GITBOT_DATA_DIR = TEST_DATA_DIR;

process.on("exit", () => rmSync(TEST_DATA_DIR, { recursive: true, force: true }));
