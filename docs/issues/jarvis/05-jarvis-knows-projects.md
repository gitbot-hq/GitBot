# 05 · Jarvis knows your projects

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

A project index stored in `projects.json` under the data dir, built lazily on the first `list_projects` call — never at server start. In this slice its sources are the folders gitbot threads have run in, plus folders Jarvis adds. (Workspace scanning is slice 14.)

A project is a folder: a git repo root, or any folder a thread ran in. Name is the folder name.

Tools:
- `list_projects()` — ids and names only
- `get_projects([ids])` — folder, git remote, current branch
- `add_project(path)` — adds a folder Jarvis found with its shell

A thread starting in a new folder adds it to the index. Entries whose folder no longer exists are dropped when listed. Jarvis's prompt gets the folder rule: a project the user named (earlier in the thread counts), else a named bot's default folder, else ask.

## Acceptance criteria

- [ ] Index created on first `list_projects`, not at startup
- [ ] Folders from existing threads appear; a new thread's folder is added
- [ ] `add_project` rejects paths that don't exist; dedupes by path
- [ ] Deleted folders disappear from listings
- [ ] `get_projects` returns remote and branch for git repos, nothing for plain folders
- [ ] Tests: index build from fixture threads, add/dedupe, prune, git details on a temp repo

## Blocked by

- 04
