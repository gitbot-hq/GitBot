# 08 · Lock and Stop

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

While a Jarvis thread has a running child, its composer is locked. The lock state is derived — from children whose `reportTo` is this thread and their session status — not stored.

The locked composer shows a status line ("PR Validator is working on Trophy"), an **Open thread** link that switches the hub to the child, and a **Stop** button where send normally is. Stop aborts the child through the existing abort path and unlocks the Jarvis thread. Jarvis is not woken; `[you stopped <bot> on <project>]` is prepended to the user's next message in that thread. Because each sequence step is started by a report, stopping also ends a sequence. An abort from Stop must not also wake Jarvis via slice 07.

At most one running child per Jarvis thread: `start_thread` refuses if one is already running.

## Acceptance criteria

- [ ] Composer locked exactly while a child is running; unlocks on report or stop
- [ ] Open thread switches to the child
- [ ] Stop aborts the child, does not wake Jarvis, and the note reaches Jarvis with the next message
- [ ] A second `start_thread` while a child runs is refused
- [ ] Tests: derived lock state; stop suppresses the wake; note prepended once

## Blocked by

- 07
