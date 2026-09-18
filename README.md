# GitBot UI

Next.js (v16 + React + Tailwind v4 + TypeScript) revamp of the GitBot
interface. This branch is `codex/gitbot-ui-concepts`.

## The two halves

This repo is **only the frontend**. The backend is Anil's code:

- **What it is:** the `gitbot-ai` npm package (global install), living at
  `/opt/homebrew/lib/node_modules/gitbot-ai` — **read-only, never edit it.**
- **What it does:** owns bots, threads, chat turns, permissions, and the
  actual AI runs (Claude Code / Codex / OpenCode via the user's own plan).
  State lives in `~/.gitbot` (`bots.json`, `threads.json`).
- **How to run it:** `gitbot start -p 3100 -l` (serves `http://localhost:3100`).
- **How we talk to it:** the browser calls same-origin
  `app/api/gitbot/*`, a thin proxy (`app/api/gitbot/[...path]/route.ts`)
  that forwards to `:3100`. The proxy exists only because the local test
  browser can't hit `:3100` directly — merge prep is to delete it and point
  the adapter at a relative base. **Merge rule: frontend-only, zero new
  backend surface** (`app/lib/gitbot.ts` mirrors the server routes;
  components take props, never fetch).

Frontend dev: `npm run dev` (`:3000`). `npx tsc --noEmit` must stay clean.

## Routes

| Route | What |
|---|---|
| `/` | Main page. Shows onboarding when the user has no bots |
| `/blank` | Previous build (light/dark system theme) |
| `/onboarding` | Standalone first-run route (same flow as the empty state) |
| `/bot-maker` | Character-studio playground (bot-maker system demo, internal) |
| `/mascot-lab`, `/cta` | Internal demos, not public |

## Key files

- `app/components/app-shell.tsx` — the app shell (bots sidebar +
  threads + chat/tray). Theme in `app/v2-theme.css`.
- `app/components/chat.tsx` — live chat (SSE, typewriter reveal because the
  server emits whole messages, approvals, markdown).
- `app/lib/api.ts` — backend adapter (incl. `browse()` folder picker,
  `repoPath` thread creation).
- `app/components/bot-form.tsx` — bot studio (preview + mascot/color
  pickers + progressive form, original copy verbatim).
- `app/components/bot-face.tsx` — avatar renderer + mood director (idle
  cycles, hover cheer, 60s-idle sleep, reduced-motion aware).
- `app/components/thread-panel.tsx` — new-thread folder picker; mirrors the
  original client's `openFolderPicker` strings/flow verbatim.
- `app/components/mascot-depth.{tsx,css}` — subtle 3D shading as an SVG
  filter applied to body art only (faces stay crisp).
- `app/lib/avatar-prefs.ts` — localStorage avatar picks (frontend-only).
- `app/components/theme-button.tsx` + `TopBar actions` slot — light/dark switch.
- `BRANDING.md` — palette/tokens source of truth. `AGENTS.md` — agent rules.

## Mascots: two generations

- **New (live): `app/components/bot-maker/`** — `BotMascot` (18 bodies,
  12 expressions + looking-around, activity director, geometry morphs).
  Artwork generated from `Design/Mascots2/` via `node
  scripts/import-mascots.mjs`; morph math tested with
  `node --test scripts/mascot-morph.test.mjs`. Adopted verbatim — don't
  refactor it; integrate by wrapping.
- **Old (retired from app surfaces):** `app/components/mascots/`,
  `studio-mascots.tsx`, spider CSS, blink-desync rules. Still rendered by
  the internal demo pages only. `mascot-art.tsx` stays — the logo imports
  its faces. `app/components/logo.tsx` exports both `Logo` (lockup) and
  `LogoMark` (mark only) from one shared live-face implementation.

## Gotchas (earned the hard way)

- Turbopack dev goes stale — `edit` can report success on ghost paths.
  Verify with grep/curl/screenshots; when in doubt kill dev, `rm -rf
  .next`, restart.
- Brave shows stale renders persistently; Playwright screenshots are
  ground truth (the `N` circle bottom-left is the Next dev indicator).
- `body` resolves `color` before scoped theme vars — re-resolve `color`
  at theme boundaries (see `.page.v2`).
- Server emits whole assistant messages (no token deltas) — the typewriter
  simulates streaming.
- `confirm()` dialogs need `pg.on('dialog', accept)` in tests. AI test
  turns cost real runs — keep e2e prompts tiny.
- Known residue: an inert "Set up X-Bot" setup thread (no delete
  endpoint; X-Bot itself restored byte-for-byte).
