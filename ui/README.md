# GitBot UI

Next.js (v16 + React + Tailwind v4 + TypeScript) web UI for GitBot. It
lives in `ui/` of the GitBot repo and ships inside the `gitbot-ai` npm
package as a static build. (Originally developed on the
`codex/gitbot-ui-concepts` branch.)

## The two halves

- **Backend:** the gitbot CLI at the repo root (`../src`). It owns bots,
  threads, chat turns, permissions, and the actual AI runs (Claude Code /
  Codex / OpenCode via the user's own plan). State lives in `~/.gitbot`
  (`bots.json`, `threads.json`).
- **Frontend:** this folder. `next.config.ts` sets `output: "export"`, so
  `next build` writes plain HTML/CSS/JS to `out/`. The root
  `npm run build` copies that into `dist/ui` (see
  `../scripts/build-ui.mjs`), and `gitbot start` serves it from the same
  port as the API (`../src/static-ui.ts`).
- **How we talk to it:** `app/lib/api.ts` calls the API on the same origin
  (`BASE = ""`). There is no proxy. Static export means no route handlers,
  rewrites, or other server-only Next features.
- **Contract rule:** `app/lib/gitbot.ts` mirrors the server routes;
  components take props, never fetch.

Run it: from the repo root, `npm run build && node dist/index.js start -p 3000`.
`npm run dev` here shows the UI but cannot reach a gitbot server (no
rewrites with static export). `npx tsc --noEmit` must stay clean.

## Routes

| Route | Shipped | What |
|---|---|---|
| `/` | yes | First-run redirect: no bots → `/onboarding`, otherwise `/v2` |
| `/v2` | yes | The app: bots sidebar + threads + chat, dark and light themes |
| `/onboarding` | yes | First-run hero (mascot, explainer carousel, studio/import) |
| `/blank` | no | Earlier main build (light/dark system theme) |
| `/bot-maker` | no | Character-studio playground (bot-maker system demo, internal) |
| `/mascots`, `/mascot`, `/mascot-lab`, `/cta` | no | Internal demos |

Pages marked "no" still build, but `build-ui.mjs` leaves them out of the
published package.

## Key files

- `app/blank/page.tsx`, `app/v2/page.tsx` — app shells (bots sidebar +
  threads + chat/tray). v2 theme in `app/v2/v2-theme.css`.
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
- `app/v2/theme-button.tsx` + `TopBar actions` slot — light/dark switch.
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
