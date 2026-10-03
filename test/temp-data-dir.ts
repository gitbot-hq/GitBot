// Import this first in every test file. bot-store reads GITBOT_DATA_DIR once, at
// module load, so it has to be set before anything pulls the store in. Each test
// process gets its own throwaway directory, removed on exit, so a test run never
// reads or writes the real ~/.gitbot.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "gitbot-test-"));
process.env.GITBOT_DATA_DIR = TEST_DATA_DIR;

process.on("exit", () => rmSync(TEST_DATA_DIR, { recursive: true, force: true }));
