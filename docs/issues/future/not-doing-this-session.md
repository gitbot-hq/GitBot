# Not fixed or added in this build session (2026-10-03)

Everything we consciously skipped, deferred, or noticed and left alone while building the Jarvis slices. Each line names where it came from so it can be picked up later.

## Deferred on purpose

- **Access guard (slice 18).** gitbot still has no auth and listens on the network. Jarvis can start children in auto-approve (Codex auto-approve = `danger-full-access`). Must land before Jarvis ships. Options were: token on everything (recommended) or Jarvis localhost-only.
- **First-turn parallel session — root cause.** [first-turn-parallel-session.md](first-turn-parallel-session.md). A cheap 409 guard was added in 06; the keying itself (random id on first turn, SDK id later) is not fixed. The session dump can still list a thread twice.
- **Report arriving while Jarvis is mid-turn.** [report-collides-with-jarvis-turn.md](report-collides-with-jarvis-turn.md). Decided in 07: kept parked — a report that arrives while Jarvis is mid-turn is dropped and logged (the 06 409 guard refuses it); aborted children never wake Jarvis. Fix later: hold one report and deliver it when Jarvis's turn ends.

## Noticed, not fixed

- **Jarvis is slow to start a turn** (~45 s to first tool call in browser checks). Likely all user MCP servers loading into its session via `settingSources`. Worth measuring; options: no user settings for Jarvis, or a trimmed MCP set. (04/06 browser checks)
- **"Thinking… Ns" timer** appears to count from the last event, not the turn start. Pre-existing. (04/05 browser checks)
- **Jarvis thread default title** is "New thread in jarvis" until the auto-title lands. (04 review)
- **Tooltips can clip at the viewport edge** on narrow screens. Pre-existing, affects all form tips. (17 review)
- After clicking Allow, the activity line keeps saying "Waiting for your approval…" until the agent's next status event (`answerPerm` doesn't reset it). (06 browser check)
- A needs-you thread row shows raw backticks around the command ("needs permission to run `touch a.txt`"); the row's second line is plain text. Cosmetic. (13 browser check)
- Opening a never-run thread logs one 404 in the browser console from the rejoin status call. Harmless. (06)

## Skipped review items (judged low value for now)

- Project index: sync `stat`/`realpath` on every tool call (only hurts on a hung network mount); no concurrency cap on git calls beyond `ids ≤ 20`; 40-bit project ids; `~user/` paths rejected; temp-file name uses pid only; two gitbot processes on one data dir can lose each other's writes (same as `threads.json` today). (05 review)
- Workspace scan: nested repos and submodules are not reported by the scan; a partial (timed-out or capped) scan is not retried for 24 h; no in-memory fallback if writing the scan result fails. (14 review)
- Project memory: bullet regex counts `* * *` and indented bullets; CRLF files end up with mixed endings; memory dirs of pruned projects are left on disk; a moved or renamed folder loses its memory (ids are path-based). (15 review)
- Jarvis: auto-allow matches `mcp__gitbot__*` by prefix (a user MCP server named `gitbot` would be auto-allowed inside Jarvis sessions — moot while Jarvis runs auto-approve); unrelated `package-lock.json` churn. (04 review)
- Plain bots: `POST /threads` silently replaces a mismatched `agent` for built-ins instead of returning 400. (03 review)
- UI: per-view draft map is unbounded (pre-existing pattern). (16 review)
- Tests: test files aren't type-checked by `tsc`; temp data dirs aren't cleaned up if a test process is killed. (01 review)
- Prompt injection, residual (11 review): `send_to_thread` and `start_thread` take free text, so a child's report that says "tell thread X to …" is only held off by prompt rules. A hard guard (no thread tools in a report-started turn) would also block legitimate sequences, so it's not done.
- Reports (07 review): OpenCode `session.error` ends a turn even if OpenCode would carry on, so Jarvis can get an early error report; OpenCode sub-agent text is only tagged once the parent's task part has been seen; the app-level status hook re-renders the whole shell on any thread's status change (scope it to the open thread); a user send at the exact moment a report turn starts can leave that turn unfollowed until the thread is switched; a user message that begins with a well-formed report header renders as a report row (cosmetic).
- Lock and Stop (08 review): the stop note is cleared when the turn starts, so a runner that fails before the agent sees the prompt (e.g. Codex SDK fails to load) loses it; while the child ends and the report turn starts, an unrelated session's broadcast landing in between can show one unlocked snapshot; the locked-composer timer restarts when you leave and come back to the Jarvis thread.
- Restart recovery (09 review): a hard kill (SIGKILL, power loss) in the instant between a child's turn ending and its turn-end listener running gives a false "interrupted" note; a hard kill after the marker clears but before Jarvis's report turn finishes loses both the report and the note.
- Approvals in Jarvis (12 review): each approvals broadcast reads threads.json twice per owned store with a pending approval (not a hot path); Review on a row whose child thread was deleted opens a thread that no longer exists.
- Attention signals (13 review): a thread that starts needing you jumps to the top of the list live, even mid-click; a stale list fetch can trigger one extra harmless "seen" call; two browsers both open and visible catch up only on focus, a live-update change or a reload (no polling).

## Housekeeping

- Done: all build worktrees and their branches removed, including the 02 spike (its findings live in `docs/issues/jarvis/02-spike-unknowns.md`).
- `docs/JARVIS.md` and `docs/issues/` are kept local and uncommitted, by choice.
