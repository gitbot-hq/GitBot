# 14 · Workspace project scan

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

Add the workspace as a project source. Scan for `.git` directories under the folder gitbot was started in, to a depth of about 4, skipping `node_modules`, `.next`, `dist` and similar, and not descending into a repo once found. A folder holding several repos is not a project; each repo is. The scan does not report nested repos or submodules; one becomes a project of its own when a thread runs in it or Jarvis adds it.

The scan runs on first `list_projects` and again when the index is over about a day old — never at server start. Agents' own session histories are not a source.

Name collisions get the parent folder added (`work/api`, `personal/api`).

## Acceptance criteria

- [ ] Repos found at depths 1–4, including several repos inside one plain folder
- [ ] Skipped directories are not entered; scan stops at a repo root
- [ ] Rescan only when stale; merged with thread-derived and added projects without duplicates
- [ ] Colliding names disambiguated
- [ ] Tests: scan over a temp directory tree with nested and sibling repos; staleness; naming

## Blocked by

- 05
