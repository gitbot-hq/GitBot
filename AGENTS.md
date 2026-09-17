<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project docs

- Branding (palette, avatar rules): read `BRANDING.md` before adding any color.
- UI/backend contract: frontend-only types in `app/lib/gitbot.ts` mirror the
  live GitBot server routes (`/chat`, `/history`, `/sessions`, `/status`,
  `/abort`, `/permission`). Components take props, never fetch.
