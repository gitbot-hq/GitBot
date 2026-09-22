<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# GitBot UI — agent guide

Frontend-only Next.js 16 + React + Tailwind v4 + TypeScript repo. The backend is
**not here**: it's the read-only `gitbot-ai` npm package
(`/opt/homebrew/lib/node_modules/gitbot-ai` — never edit). Run it with
`gitbot start -p 3100 -l`; its state lives in `~/.gitbot` (`bots.json`, `threads.json`).

## Commands

- `npm run dev` → `:3000` (expects backend on `:3100`).
- `npm run build` uses `next build --webpack`; `npm start` serves the production build.
- `npx tsc --noEmit` must stay clean (no typecheck script; README mandates it).
- `npm run lint` is broken repo-wide (no `eslint.config.*` — fails whether or not
  your change is involved). Trust `npx tsc --noEmit` instead.
- No test runner. Mascot morph math only: `node --test scripts/mascot-morph.test.mjs`.
- Regenerate mascot art after `Design/Mascots2/` changes:
  `node scripts/import-mascots.mjs` (writes `app/components/bot-maker/artwork.json` + `morphs.json`).

## Architecture (where things live)

- Entry: `app/page.tsx` → `app/components/app-shell.tsx` (bots sidebar + threads + chat/tray). Theme in `app/v2-theme.css`.
- HTTP boundary: `app/lib/api.ts` is the **only** fetch layer (same-origin
  `BASE = "/api/gitbot"`); `app/lib/gitbot.ts` is frontend-only types mirroring
  server routes — no fetches there. Use existing service endpoints through the
  adapter; never invent new backend endpoints or implement backend capabilities here.
- Proxy: `app/api/gitbot/[...path]/route.ts` forwards to `$GITBOT_URL` (default
  `http://localhost:3100`), incl. SSE passthrough. Exists only because the local
  test browser can't hit `:3100` directly.
- No CI, no `opencode.json`.
- Live chat: `app/components/chat.tsx` (SSE via `streamUrl(sessionId)`, approvals,
  markdown). Bot studio: `bot-form.tsx`; profile: `bot-profile.tsx`;
  new-thread folder picker: `thread-panel.tsx` (mirrors original client's
  `openFolderPicker` strings verbatim — keep them).
- Tab alerts: `app/lib/status-favicon.ts` (`useStatusFavicon`: swaps
  `<link rel="icon">` hrefs to pre-made notif SVGs (mascot + colored dot)
  + standout `document.title` while hidden). Driven from `chat.tsx` signal
  (attention > error > working > done flash > idle). SVGs live in
  `public/notif/` (8 files: 4 states × light/dark).
- Routes: `/` is the app (onboarding empty state when no bots); `/blank` is the
  previous build; `/onboarding`, `/bot-maker`, `/mascot-lab`, `/cta`
  are standalone/internal demos, not public.
- `/marketplace` is linked from the app. Its catalog, authors, and install counts
  are currently hardcoded UI data in `app/marketplace/page.tsx`, not a live catalog
  or installation service. Styles live in `app/marketplace/marketplace.css`.
- Shared header: `app/components/top-bar.tsx`. User profile UI:
  `app/components/user-profile.tsx`; local profile storage: `app/lib/user-prefs.ts`.
- Bot sharing/import: `app/components/share-modals.tsx` + `app/lib/share.ts`.
  Codes use `gitbot:v1:`; parsing also accepts legacy `grassbot:v1:` and raw JSON.
  Preserve the field allowlist and validation; machine-local workspace and setup
  state do not travel with shared bots.
- Branding source of truth: `BRANDING.md` (tokens, avatar rules). Check it before
  adding any color. Bot tile color = stable hash of id (`botTile()` in
  `bot-avatar.tsx`) — never random per render.

## Conventions for new changes

- **Merge rule: frontend-only, zero new backend surface.** Additions go in
  `app/components/` + `app/lib/`; components take props, HTTP stays in `api.ts`.
- `app/components/bot-maker/` (live `BotMascot`: 18 bodies, 12 expressions) was
  adopted verbatim — integrate by wrapping, don't refactor.
- Old mascot set (`mascots/`, `studio-mascots.tsx`) renders on internal demo pages
  only; `mascot-art.tsx` stays (logo imports its faces), `logo.tsx` exports both
  `Logo` and `LogoMark`.
- Avatar prefs: `app/lib/avatar-prefs.ts` (localStorage, frontend-only).
- User profiles are localStorage-only (`gitbot-user`); email verification is a
  placeholder for a future server capability, not something to grant in client UI.
- Theme (`gitbot-theme`) and panel widths (`gitbot-v2-side-width`,
  `gitbot-v2-threads-width`) restore before paint in `app/layout.tsx`.
  Keep width clamps synchronized with `app/components/app-shell.tsx`.

## Gotchas (earned the hard way)

- Turbopack dev goes stale — `edit` can succeed on ghost paths. Verify with
  grep/curl/screenshots; when in doubt kill dev, `rm -rf .next`, restart.
- Brave shows stale renders; Playwright screenshots are ground truth
  (the `N` circle bottom-left is the Next dev indicator).
- Server emits whole assistant messages, no token deltas — the typewriter in
  `chat.tsx` simulates streaming. Don't "fix" it into real deltas.
- Chat reattaches to running sessions using status and pending-permission checks
  before reopening SSE. Preserve catch-up filtering so old approvals are not
  presented again. Drafts and tool/run-summary overlays are in-memory; switching
  threads moves a queued follow-up back into that thread's draft.
- One turn per thread (server 409s a second `POST /chat` while running).
  The composer stays enabled: mid-turn sends park in a single "up next"
  queue slot (`queueRef`, flushed by `finish()`), with steer (abort +
  send) and remove actions. `startTurn` owns no streaming check — callers
  (`sendPrompt`, `maybeFlush`) guarantee state.
- `body` resolves `color` before scoped theme vars — re-resolve `color` at theme
  boundaries (see `.page.v2`).
- `confirm()` dialogs need `pg.on('dialog', accept)` in tests. AI e2e turns cost
  real backend runs — keep prompts tiny.
- Known residue: an inert "Set up X-Bot" setup thread (no delete
  endpoint; X-Bot itself restored byte-for-byte).
