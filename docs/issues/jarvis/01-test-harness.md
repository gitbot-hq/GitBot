# 01 · Test harness

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

The repo has no tests. Add a minimal harness so every later slice ships with tests: `npm test` runs Node's built-in `node:test` through `tsx`, with no new test framework. Prove it with one real test against existing code — the setup verdict parser (`SETUP_COMPLETE` / `SETUP_FAILED`, last marker wins) — so the harness is exercised on something that matters, not a placeholder.

Tests must not touch the real `~/.gitbot`: point `GITBOT_DATA_DIR` at a temporary directory per test run.

## Acceptance criteria

- [ ] `npm test` runs and passes from a clean checkout
- [ ] Tests for the setup verdict: complete, failed, last marker wins, no marker leaves status unchanged
- [ ] Tests run against a temporary data dir, never the user's `~/.gitbot`
- [ ] Short note in the README or ARCHITECTURE on how to run tests

## Blocked by

None - can start immediately
