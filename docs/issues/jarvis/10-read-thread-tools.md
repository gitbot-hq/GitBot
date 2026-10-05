# 10 · Jarvis can look at threads

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

Read-only thread tools for Jarvis:

- `list_threads(project?, bot?)` — gitbot threads (ids, titles, bot, project), filterable
- `thread_status(threadId)` — running, waiting on approval, done, failed, or stopped, with the last message
- `read_thread_tail(threadId, n)` — the last n messages, from the agent's own transcript as gitbot already reads it

Demo: "what's going on in my Trophy threads?" answered correctly.

## Acceptance criteria

- [ ] `list_threads` filters by project and by bot; excludes Jarvis threads
- [ ] `thread_status` reflects live session state, including waiting on approval
- [ ] `read_thread_tail` works for Claude Code, Codex and OpenCode threads
- [ ] Tests: filtering; status mapping from session state

## Blocked by

- 06
