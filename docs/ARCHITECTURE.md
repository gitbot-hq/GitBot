# gitbot architecture

How gitbot is put together, for people who want to change it or build on it. For what it does and how to run it, start with the [README](../README.md); for the endpoints, see the [API reference](API.md).

## The shape of it

```
┌─────────────────────────────┐
│  Browser (any device)       │
│  Bot hub UI (static files)  │
│  ─ bots, threads, chat      │
│  ─ bot studio, folder picker│
│  ─ approval prompts         │
└──────────┬──────────────────┘
           │ HTTP + SSE, one port
┌──────────▼──────────────────┐
│  gitbot server (Node.js)    │
│  ─ bot + thread store       │
│  ─ sessions + event buffer  │
│  ─ approval forwarding      │
│  ─ workspace + file API     │
│  ─ serves the built UI      │
└──────┬───────────┬──────────┬┘
       │           │          │
┌──────▼──────┐ ┌──▼───────┐ ┌▼────────┐
│ Claude Code │ │ OpenCode │ │  Codex  │
│ Agent SDK   │ │   SDK    │ │   SDK   │
└─────────────┘ └──────────┘ └─────────┘
   agents run on this machine, in the thread's folder
```

One Node.js process does everything. There is no database, no separate frontend server, and no cloud component.

## Bots, threads, sessions

- A **bot** is a preset: a name, instructions (its job), an agent, a model, a permission mode, optional tool lists and optional setup instructions.
- A **thread** is one conversation between a bot and a folder. It remembers which agent it runs on and that agent's session id.
- A **session** is one agent conversation held in the server's memory while gitbot runs: its status, its buffered events and its pending approvals.

Bots and threads are stored as two JSON files under `~/.gitbot` (override with `GITBOT_DATA_DIR`). They are per machine, not per workspace. Messages are **not** stored by gitbot: a thread's history is read back from the agent's own transcript (`~/.claude/projects/…` for Claude Code, `~/.codex/sessions` for Codex, the local OpenCode server for OpenCode).

## Transport: SSE, not WebSockets

The client sends ordinary HTTP requests and receives a turn's output over a `GET /events` Server-Sent Events stream.

- Plain HTTP works through proxies and most network setups.
- Every event has a sequence number and an SSE `id:`; a client that reconnects with `Last-Event-ID` gets what it missed.
- `GET /permissions/events` is one global stream of every pending approval, for clients that watch several sessions at once.

## Session lifecycle

- **Survives disconnects.** A turn keeps running when the browser closes. On return the UI checks `/sessions/:id/status`, reattaches to the stream and replays buffered events.
- **Resumes.** A thread's next turn resumes the agent's own session: Claude Code from its `.jsonl` transcript, Codex from its session file, OpenCode from its local store.
- **Scoped to a folder.** The agent runs with the thread's folder as its working directory.
- **Abort.** `POST /sessions/:id/abort` signals an `AbortController` (Claude Code, Codex) or calls the SDK's abort (OpenCode).
- **Cleanup.** Idle-session cleanup is currently disabled; finished sessions stay in memory until gitbot stops.

## Agents

At startup gitbot checks which agents are usable — the `claude` CLI, the `@opencode-ai/sdk` package, the `codex` CLI, the `grok` CLI — and reports them at `GET /agents`.

Each bot picks its agent. A thread stays on the agent that ran its first turn, because a session id only means something to the agent that issued it; switching a bot's agent applies to threads that have not started yet. Chatting with a bot whose agent is not installed fails with a `400` instead of falling back silently.

Every agent gets the same bot framing — the job prompt, the setup prompt and the `SETUP_COMPLETE` / `SETUP_FAILED` markers — from `src/bot-prompt.ts`.

| Bot feature | Claude Code | OpenCode | Codex |
|---|---|---|---|
| Instructions | appended to the system prompt | per-message `system` | `developer_instructions` config |
| Resume + thread history | yes | yes | yes |
| Setup runs | yes | yes | yes |
| Per-call approvals | yes | yes | no — sandbox by permission mode |
| `allowedTools` | yes, MCP tools included | yes | not supported |
| `disallowedTools` | yes | yes | not supported |

`allowedTools` is a restriction, not an auto-approve list: whether a tool needs approval is decided by the permission mode alone. It is not applied to a bot's setup run, which may need tools the job itself never uses.

**Claude Code** (`claude-code`) uses `@anthropic-ai/claude-agent-sdk`'s `query()`. The default model is `claude-sonnet-4-6`. Approvals come through the SDK's `canUseTool` callback. It loads your Claude settings, so bots can use the MCP servers you have configured; a bot's allow-list is enforced with the SDK's `tools` option plus a pre-tool hook, which is what covers MCP tools.

**OpenCode** (`opencode`) uses `@opencode-ai/sdk`. gitbot starts an OpenCode server (or connects to one already on port 4096), keeps one client per folder, and listens to OpenCode's event stream, reconnecting after two seconds if it drops. Bots need a `model` in `provider/model` form; OpenCode's free default model refuses requests made through the SDK.

**Codex** (`codex`) uses `@openai/codex-sdk`, which runs the Codex binary bundled with it rather than the `codex` on your PATH; your own install supplies the login (`codex login`). If the bundled binary cannot be found, gitbot falls back to the `codex` on PATH and logs a warning, since the two versions may differ. Codex has no per-call approvals in gitbot, and cannot have them: `codex exec` has no channel to ask on and reports its approval policy as `never` whichever policy it is handed, so a permission mode picks a sandbox and nothing else — `ask-permissions` → `read-only`, `allow-all-edits` → `workspace-write`, `yolo` → `danger-full-access` — and plan mode forces `read-only`. A mode change applies from the next turn. Because a codex bot cannot be asked, a *bot* set to `ask-permissions` opens its codex threads in `allow-all-edits`; the alternative is a bot that can never act and never prompts. Read-only stays reachable per conversation from the chat composer. Bot tool lists are enforced by the Claude Code and OpenCode harnesses only — codex has no equivalent, so a codex turn carrying one says so in the thread and runs unfenced.

**Grok** (`grok`) runs the `grok` CLI already on PATH (`grok -p --output-format streaming-messages-json`). The stream is the same NDJSON shape Claude Code emits (`system` / `assistant` / `result`), and the session id in the `init` event is the resume handle (`--resume`). A headless turn has no approval callback, so the permission mode is a flag: plan refuses edits, ask-permissions allows reads and refuses writes, and auto-approve passes `--always-approve`. Tool allow and deny lists are passed as `--tools` and `--disallowed-tools`. Transcripts are read back from `~/.grok/sessions`.

## Workspace and file API

The directory you run `gitbot start` in is the workspace; its subdirectories are listed as repos. `GET /dir` and `GET /file` are a small file browser: both check that the requested path stays inside the given `repoPath` before serving anything, and file reads are capped at 5 MB. `GET /browse` is the folder picker. It is deliberately not confined to the workspace — a thread may run in any folder the gitbot process can read — so it lists folder names across the filesystem.

When listing Claude Code sessions, gitbot uses a session's `custom-title` entry as its preview if there is one, and otherwise builds a short preview from the first few messages.

## The web UI

The UI is a Next.js app in [`ui/`](../ui/). `npm run build` exports it to static HTML, CSS and JS and copies it into `dist/ui`, so the published package ships a ready-built UI. `src/static-ui.ts` serves those files from the same port as the API; UI files and API routes never share a path.

Opening `/` loads the bot hub, which shows onboarding when no bots exist. The legacy `/v2` URL redirects to `/`.

## Project structure

```
GitBot/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── server.ts             # Request routing, chat + session routes
│   ├── server-common.ts      # HTTP server, SSE, session store, workspace routes
│   ├── bot-store.ts          # Bot + thread persistence (JSON files)
│   ├── bot-routes.ts         # /bots and /threads
│   ├── bot-prompt.ts         # Bot + setup prompts, setup verdict — shared by all agents
│   ├── start-claude-code.ts  # Claude Code integration
│   ├── start-opencode.ts     # OpenCode integration
│   ├── start-codex.ts        # Codex integration
│   ├── start-grok.ts         # Grok CLI integration
│   ├── workspace.ts          # Repo listing, file browser, git details, clone
│   └── static-ui.ts          # Serves the built web UI
├── ui/                       # Web UI source (Next.js static export) — not published
├── scripts/build-ui.mjs      # Builds ui/ and copies the export into dist/ui
├── docs/                     # API reference and this document
└── dist/                     # Build output — the only thing published to npm
```

## Tech stack

| Part | Technology |
|---|---|
| Language | TypeScript (CommonJS, ES2020), Node.js 18+ |
| CLI | Commander |
| Transport | HTTP + Server-Sent Events |
| Agents | `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`, `@openai/codex-sdk` |
| UI | Next.js 16 static export, React 19, Tailwind v4, `react-markdown` |
| Terminal QR code | `qrcode-terminal` |
