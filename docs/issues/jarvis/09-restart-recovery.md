# 09 · Restart recovery

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

Sessions live in memory, so a gitbot restart kills a running child. After restart, a Jarvis thread whose child was mid-turn must not stay locked. It unlocks, and the next message the user sends in it is prepended with `[<bot> on <project> was interrupted by a restart]`.

Since lock state is derived from live sessions, the main work is recognising "was running when gitbot stopped" — e.g. a child with `reportTo` whose last activity has no matching turn end — and delivering the note once.

## Acceptance criteria

- [ ] After a restart mid-child, the Jarvis thread is unlocked
- [ ] The interruption note reaches Jarvis with the next user message, exactly once
- [ ] Threads that finished normally before the restart get no note
- [ ] Tests: interrupted-detection from fixture thread state; note delivered once

## Blocked by

- 08
