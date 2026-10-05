# 06 · Jarvis starts a child thread

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

`start_thread({ bot } | { agent }, project, message, permissionMode?)` — Jarvis starts a child thread with a bot, or with a plain agent (via its built-in plain bot), in a project's folder, with its first message, and the turn begins. The tool returns immediately with the child's thread id.

The child records its owner: `Thread.reportTo = <jarvisThreadId>`, known to the tool from its per-session server, not passed by Jarvis.

Permissions: plain agent children default to auto-approve; bot children use the bot's own mode; `permissionMode` overrides either when the user asked for it. Bots whose setup isn't complete are refused with a clear message (Jarvis tells the user; it does not run setup).

The child appears under its own bot in the thread list. The Jarvis thread shows a panel of the threads it started, each linking to the child.

Nothing wakes Jarvis when the child finishes yet — the user checks the child themselves.

## Acceptance criteria

- [ ] Starting with a bot and with a plain agent both work, in the resolved project folder
- [ ] Child has `reportTo` set to the calling Jarvis thread
- [ ] Permission defaults and override behave as specified
- [ ] Not-ready bot is refused with a message Jarvis can relay
- [ ] Child visible under its bot; Jarvis thread panel lists its children
- [ ] Tests: permission resolution table; `reportTo` set; not-ready refusal

## Blocked by

- 03
- 05

## Notes from 04 review

- Jarvis's prompt (`src/jarvis.ts`) says starting threads "is not available yet" and tells Jarvis to name the bot and folder instead. Remove that line when `start_thread` lands.
