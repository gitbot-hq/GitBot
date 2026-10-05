# 15 · Project memory

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

One lean memory file per project at `projects/<id>/memory.md` under the data dir, outside the repo, shared by every Jarvis thread and read by Jarvis only. `get_projects` returns its path and contents. Jarvis edits it with its ordinary file tools.

Jarvis's prompt keeps it lean: write only when the user states a preference, corrects Jarvis, or a fact changes how work happens in the project — never observations; one short bullet per entry; rewrite or remove rather than append; a soft limit of about 20 bullets. Jarvis passes what's relevant to a child in its first message.

Demo: tell Jarvis "always use Codex for Trophy" in one thread; a new Jarvis thread honours it.

## Acceptance criteria

- [ ] `get_projects` includes memory path and contents (empty when none)
- [ ] Memory written in one Jarvis thread is used in another
- [ ] File is plain markdown the user can edit by hand
- [ ] Tests: memory round-trip through `get_projects`

## Blocked by

- 05
