# GitBot UI

GitBot UI is a local web app for managing coding agents and the work they do. Create purpose-built bots, start threads in the right workspace, and follow each conversation as it runs.

## What it includes

- Bot setup with instructions, permissions, workspaces, and agent configuration
- Thread creation with a workspace picker and agent selection
- Live chat with streamed responses, approvals, and a one-message follow-up queue
- Bot profiles, avatars, themes, and status-aware browser notifications
- A same-origin API proxy for connecting the UI to a local GitBot service

## Run locally

You need Node.js and a running GitBot service. The UI expects the service at `http://localhost:3100` by default.

```bash
npm install
```

Start the GitBot service in one terminal:

```bash
gitbot start -p 3100 -l
```

Then start the UI in another:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How it fits together

```text
Browser  ->  Next.js UI  ->  /api/gitbot proxy  ->  GitBot service
```

The browser only talks to the Next.js app. The proxy forwards requests and server-sent events to the local GitBot service, which owns bot and thread state.

## Project structure

| Path | Purpose |
| --- | --- |
| `app/components/` | The app shell, chat, bot studio, profiles, and thread setup UI |
| `app/lib/api.ts` | The single frontend HTTP boundary |
| `app/lib/gitbot.ts` | TypeScript types for the service contract |
| `app/api/gitbot/[...path]/route.ts` | Same-origin proxy to the GitBot service |
| `app/v2-theme.css` and `app/globals.css` | Shared visual tokens and application styles |

## Development checks

Run the TypeScript check before sharing a UI change:

```bash
npx tsc --noEmit
```

Mascot changes also have a focused verification command:

```bash
node --test scripts/mascot-morph.test.mjs
```

## Development notes

- Keep frontend requests in `app/lib/api.ts`. Components should not call `fetch` directly.
- The GitBot backend is a separate package. This repository only contains the UI and proxy.
- Use the visual tokens and avatar guidance in [BRANDING.md](./BRANDING.md) when extending the interface.
- The UI includes internal demo routes for design exploration. The main application is available at `/`.

## Contributing

Keep changes focused, preserve the existing UI conventions, and include the relevant type check with your pull request. If a change needs a new backend capability, coordinate it with the GitBot service rather than adding server logic here.
