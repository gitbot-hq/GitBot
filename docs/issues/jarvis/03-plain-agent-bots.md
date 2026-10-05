# 03 · Plain agent bots

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

Built-in bots with no instructions, one per installed agent: **Claude Code**, **Codex**, **OpenCode**. They are defined in code, not stored in `bots.json`, cannot be edited, shared, published or deleted, and appear in their own section of the Bots panel apart from the user's bots. Only agents detected as installed get one.

A user can start a thread with a plain agent bot directly, in any folder, exactly like any other bot thread. This makes every thread a bot thread, which later slices rely on.

## Acceptance criteria

- [ ] `GET /bots` (or equivalent) includes the built-in plain bots, marked as built-in, only for installed agents
- [ ] Built-in bots reject edit / delete / share requests
- [ ] Bots panel shows them in their own section
- [ ] A user can start and resume a thread with each plain bot; no system prompt is added
- [ ] Tests: built-in bot listing per installed-agent set; edit/delete refused

## Blocked by

- 01
