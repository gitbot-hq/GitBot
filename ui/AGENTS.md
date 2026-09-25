<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# GitBot UI — agent guide

Next.js 16 + React + Tailwind v4 + TypeScript UI for the GitBot CLI repository.
The backend lives in the repository root under `src/`, serves the static export,
and stores machine-local state in `~/.gitbot` (`bots.json`, `threads.json`).

## Commands

- From `ui/`, `npm run dev` starts the standalone Next.js development server.
- From the repository root, `npm run dev` starts the GitBot backend and
  `npm run build` builds both the CLI and the static UI export.
- `npm run build` uses `next build --webpack`; `npm start` serves the production build.
- `npx tsc --noEmit` must stay clean (no typecheck script; README mandates it).
- `npm run lint` is broken repo-wide (no `eslint.config.*` — fails whether or not
  your change is involved). Trust `npx tsc --noEmit` instead.
- No test runner. Small checks live in `scripts/*.test.mjs`; the ones that import
  `.ts` need Node's type stripping: `node --experimental-strip-types --test scripts/*.test.mjs`.
- Regenerate mascot art after `Design/Mascots2/` changes:
  `node scripts/import-mascots.mjs` (writes `app/components/bot-maker/artwork.json` + `morphs.json`).

## Architecture (where things live)

- Entry: `app/page.tsx` → `app/components/app-shell.tsx` (bots sidebar + threads + chat/tray). Theme in `app/v2-theme.css`.
- HTTP boundary: `app/lib/api.ts` is the **only** fetch layer (same-origin API);
  `app/lib/gitbot.ts` is frontend-only types mirroring
  server routes — no fetches there. Use existing service endpoints through the
  adapter; never invent new backend endpoints or implement backend capabilities here.
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
- Routes: `/` is the app (onboarding empty state when no bots);
  `/onboarding`, `/bot-maker`, `/mascot-lab`, `/cta`
  are standalone/internal demos, not public. `scripts/build-ui.mjs` strips
  `/bot-maker`, `/mascot-lab` and `/cta` from the shipped export.
- Source art (Figma/kawaii expression SVGs, `creature-expressions.svg`) lives in
  `Design/expressions/`, not `public/` — nothing loads it at runtime.
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

- UI additions go in `app/components/` + `app/lib/`; components take props and
  HTTP stays in `api.ts`. Backend changes belong in the repository root `src/`.
- `app/components/bot-maker/` (live `BotMascot`: 18 bodies, 12 expressions) was
  adopted verbatim — integrate by wrapping, don't refactor.
- Old mascot set (`mascots/`, `studio-mascots.tsx`) renders on internal demo pages
  only; `mascot-art.tsx` stays (logo imports its faces), `logo.tsx` exports both
  `Logo` and `LogoMark`.
- Avatar prefs: `app/lib/avatar-prefs.ts` (localStorage, frontend-only).

### Pending: include mascot details in share codes

Bot share codes currently omit the mascot: its body ID (`mascot`) and color
live only in local avatar preferences. The import preview therefore cannot
show the original mascot, and importing does not preserve its appearance.

When implementing this, include the mascot body ID and color in the JSON
payload encoded as Base64URL after `gitbot:v1:` (`app/lib/share.ts`). Validate
both fields on import, show the mascot in the import preview, and save its
appearance under the newly created bot's ID using `avatar-prefs.ts`. Keep
older codes without mascot details working with the existing defaults.
Preserve the share field allowlist and exclusions for chats and machine-local
state. This is a pending implementation note, not an implemented feature.

### Other local preferences

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
  queue slot (`queueRef`, flushed by `finish()`), with edit and remove
  actions. `startTurn` owns no streaming check — callers (`sendPrompt`,
  `maybeFlush`) guarantee state. Steer (abort + send now) is commented out
  in `chat.tsx`/`queue-tray.tsx`, not deleted — Stop returns a queued
  message to the composer, so that is the interrupt path for now.
- `body` resolves `color` before scoped theme vars — re-resolve `color` at theme
  boundaries (see `.page.v2`).
- `confirm()` dialogs need `pg.on('dialog', accept)` in tests. AI e2e turns cost
  real backend runs — keep prompts tiny.
