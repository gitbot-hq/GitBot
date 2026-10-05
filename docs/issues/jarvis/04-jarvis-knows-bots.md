# 04 · Jarvis exists and knows your bots

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

The built-in **Jarvis** bot, pinned at the top of the Bots panel and visually set apart. Not editable, not shareable. A Jarvis thread always runs Claude Code, on gitbot's default model, in auto-approve, with its working directory fixed to `~/.gitbot/jarvis/` (under `GITBOT_DATA_DIR`) — the thread offers no folder choice. Its fixed system prompt states its job is delegation.

Jarvis's tools are an in-process SDK MCP server created per Jarvis session and passed only to Jarvis sessions. This slice adds the first two:

- `list_bots()` — ids and names only, with a marker on bots whose setup is pending or failed
- `get_bots([ids], includeInstructions?)` — description, agent, default folder, setup status; instructions only with the flag

Demo: open a Jarvis thread, ask "what bots do I have?", and get a correct answer.

## Acceptance criteria

- [ ] Jarvis appears pinned; cannot be edited, shared, or deleted
- [ ] Jarvis thread runs in `~/.gitbot/jarvis/` regardless of any folder passed
- [ ] Jarvis session runs in auto-approve on Claude Code
- [ ] `list_bots` returns ids + names only, with not-ready markers; built-in bots are included as abilities but Jarvis is not
- [ ] `get_bots` handles several ids in one call; never returns instructions without the flag
- [ ] Tools are not visible to any non-Jarvis session
- [ ] Tests: tool outputs against a fixture bot store; instructions gating; tool server only attached for Jarvis

## Blocked by

- 01
- 02
