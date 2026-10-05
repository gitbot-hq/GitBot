# 16 · Jarvis first

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

gitbot opens on a new Jarvis thread, ready to type into. Onboarding no longer assumes an empty hub means "create a bot first": Jarvis always exists, and creating bots is optional. First launch goes straight to Jarvis.

## Acceptance criteria

- [ ] Opening `/` lands on a new Jarvis thread
- [ ] First launch with no user bots goes to Jarvis, not bot-creation onboarding
- [ ] Bot creation still reachable from the Bots panel

## Blocked by

- 04

## Notes from 04 review

- Jarvis is hidden from `GET /bots` when Claude Code isn't installed (same as plain bots). The design says Jarvis always exists — decide here whether to always show it with a "needs Claude Code" state, so existing Jarvis threads keep their sidebar entry.
- Onboarding's "Skip — use … directly" goes to a plain agent bot; point it at Jarvis.
- Browser check of 04: Jarvis's empty state says "Choose a folder, then tell Jarvis…" (it has no folder step), and creating a Jarvis thread still goes through a "Create thread" confirmation with nothing to choose. Jarvis-first should open straight into a new thread and fix the copy.
