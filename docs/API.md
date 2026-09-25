# gitbot HTTP API

The bot hub UI talks to the gitbot server over a plain REST + Server-Sent Events (SSE) API. You can use the same API to build your own client.

- **Base URL:** wherever `gitbot start` is listening, e.g. `http://localhost:3000`.
- **Format:** JSON in, JSON out, unless noted. Errors are `{ "error": "<message>" }` with a 4xx/5xx status; some carry extra fields (noted below).
- **Auth:** none. See [Security](../README.md#security) before exposing the port to anything but a trusted network.
- **CORS:** every origin is allowed for `GET`, `POST` and `PATCH`. `DELETE` is not in the allowed methods, so browser clients on another origin cannot delete; same-origin clients (the bundled UI) and non-browser clients can.

Contents: [Workspace](#workspace) · [Bots](#bots) · [Threads](#threads) · [Chat](#chat) · [Sessions](#sessions) · [Event streams](#event-streams)

---

## Workspace

The workspace is the directory `gitbot start` was run in. Repos are its subdirectories.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ status: "ok", cwd, serverVersion, clientVersionRange }` |
| `GET` | `/agents` | `{ agents: string[] }` — the agents installed on this machine, in order of preference. Values: `claude-code`, `opencode`, `codex`, `grok` |
| `GET` | `/repos` | Subdirectories of the workspace as `{ name, path, isGit }[]` |
| `GET` | `/repos/details?repoPath=<path>` | `{ branch, lastCommit, dominantLanguage }`. `lastCommit` has the message, hash and timestamp; `dominantLanguage` is the most common file extension from `git ls-files`, so it respects `.gitignore` |
| `POST` | `/repos/clone` | Clone a git repo into the workspace. Body: `{ url }`. Returns `{ path, name }` |
| `POST` | `/folders` | Create an empty folder in the workspace. Body: `{ name }`. Returns `{ path, name }` |
| `GET` | `/browse?path=<dir>` | Folder picker. Returns `{ path, parent, workspace, home, dirs: { name, path }[] }`. `parent` is `null` at the filesystem root. Without `path` it starts at the workspace. Not confined to the workspace: it lists folders anywhere the gitbot process can read |
| `GET` | `/dir?repoPath=<path>&path=<subpath>` | Directory entries inside a repo. The path is validated to stay inside `repoPath` |
| `GET` | `/file?repoPath=<path>&path=<filePath>` | Read a file. Validated to stay inside `repoPath`. 5 MB max |
| `GET` | `/diffs?repoPath=<path>` | `{ diff }` — the output of `git diff HEAD` |

## Bots

A bot is a named, reusable agent preset.

| Method | Path | Description |
|---|---|---|
| `GET` | `/bots` | `{ bots: Bot[] }` |
| `POST` | `/bots` | Create a bot. Returns `{ bot, setupThread? }` |
| `GET` | `/bots/:id` | `{ bot }` |
| `PATCH` | `/bots/:id` | Update any bot field. Returns `{ bot, setupThread? }` |
| `DELETE` | `/bots/:id` | Delete a bot and its threads |
| `POST` | `/bots/:id/setup` | Set this machine's setup state. Body: `{ action: "complete" \| "reset" \| "fail" }` |

**Bot fields**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required |
| `description`, `emoji` | string | Shown in the hub |
| `agent` | `claude-code` \| `opencode` \| `codex` \| `grok` | Which agent runs the bot. Default `claude-code`. Any other value is a `400` |
| `instructions` | string | The bot's job. Sent to the agent on top of its own system prompt |
| `setupInstructions` | string | What the bot needs from a machine. Blank means no setup run. See [setup](../README.md#bots-set-themselves-up) |
| `model` | string | Optional. OpenCode needs `provider/model` — run `opencode models` for the values that install accepts |
| `repoPath` | string | Default folder for new threads |
| `permissionMode` | `ask-permissions` \| `auto-approve` \| `plan` | Default `ask-permissions` |
| `allowedTools` | string[] | The only tools the bot may use. Blank means all. Not applied to setup runs. Not supported on Codex |
| `disallowedTools` | string[] | Tools the bot may never use. Not supported on Codex |

Read-only fields the server maintains: `id`, `setupStatus` (`pending` \| `complete` \| `failed`), `setupThreadId`, `createdAt`, `updatedAt`.

## Threads

A thread is one conversation between a bot and a folder.

| Method | Path | Description |
|---|---|---|
| `GET` | `/threads?botId=<id>` | `{ threads: Thread[] }`, optionally for one bot |
| `POST` | `/threads` | Open a thread. Body: `{ botId, repoPath?, title? }`. Returns `{ thread }`. `409` with `{ setupRequired: true, setupThreadId }` if the bot has not set up this machine yet |
| `GET` | `/threads/:id` | `{ thread }` |
| `PATCH` | `/threads/:id` | Update a thread, e.g. `{ title }` |
| `DELETE` | `/threads/:id` | Delete the thread. The agent's own transcript stays on disk |
| `GET` | `/threads/:id/messages` | `{ messages }` — history read from the transcript of the agent the thread runs on |

A thread records `agent` and `sdkSessionId` on its first turn and keeps them: a session id only means something to the agent that issued it. Other fields: `kind` (`chat` \| `setup`), `title`, `repoPath`, `preview`, `messageCount`, `createdAt`, `updatedAt`.

Messages are `{ role: "user" | "assistant", content: Block[] }`, where a block is `{ type: "text", text }`, `{ type: "tool_use", tool_name, tool_input }` or `{ type: "image_url", url }`.

## Chat

| Method | Path | Description |
|---|---|---|
| `POST` | `/chat` | Start a turn. Returns `{ sessionId }` immediately; the reply arrives on [`/events`](#event-streams) |

Two body forms:

- **Thread turn** (what the hub uses): `{ threadId, prompt, permissionMode? }`. The thread supplies the folder, the agent, the resume handle and the bot's preset.
- **Bare session:** `{ repoPath, agent, prompt, sessionId?, model?, permissionMode? }`. Pass `sessionId` to continue an earlier session.

Both accept `attachments: { url }[]`. Session `permissionMode` values are `ask-permissions`, `allow-all-edits` and `yolo`.

Errors: `400` with `{ agentUnavailable: "<agent>" }` when the bot's agent is not installed; `409` with `{ setupRequired: true }` when the bot still needs setup; `409` when that session is already running.

## Marketplace

The Discover page reads from a separate service, the gitbot marketplace API, which indexes the
[gitbot-hq/Library](https://github.com/gitbot-hq/Library) repo. gitbot proxies its public routes so
the UI stays on one origin:

| Method | Path | Forwarded to |
|---|---|---|
| GET | `/marketplace/v1/bots` | `GET /v1/bots` — cards; query `q`, `category`, `agent`, `verified`, `featured`, `sort`, `limit`, `offset` |
| GET | `/marketplace/v1/bots/:slug` | `GET /v1/bots/:slug` — full detail incl. `instructions`, `setupInstructions`, `shareCode` |
| GET | `/marketplace/v1/categories` | `GET /v1/categories` |
| GET | `/marketplace/v1/index` | `GET /v1/index` — when the library was last indexed |
| POST | `/marketplace/v1/bots/:slug/installs` | `POST /v1/bots/:slug/installs` — anonymous install counter |

Anything else under `/marketplace/` is 404. Errors from this service are shaped
`{ "error": { "code", "message" } }`; when it cannot be reached gitbot answers
`502 MARKETPLACE_UNAVAILABLE`. The upstream is `GITBOT_MARKETPLACE_API`.

## Sessions

A session is one running (or finished) agent conversation, held in the server's memory.

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions?agent=<agent>&repoPath=<path>` | `{ sessions }` — past sessions for a folder, read from the agent's own store |
| `GET` | `/sessions/:id/history?agent=<agent>&repoPath=<path>` | `{ messages }` for a session |
| `GET` | `/sessions/:id/status` | `{ streaming: boolean, sdkSessionId }` |
| `GET` | `/sessions/:id/config` | `{ gitbotId, sessionId, agent, model, mode, permissionMode }` |
| `PATCH` | `/sessions/:id` | Change the permission mode, also mid-turn. Body: `{ permissionMode }`. Approvals already waiting that the new mode covers are resolved at once. Returns `{ sessionId, permissionMode }`. On Codex the change applies from the next turn |
| `GET` | `/sessions/:id/permissions` | `{ pending: string[] }` — the `toolUseID`s still awaiting an answer |
| `POST` | `/sessions/:id/permission` | Answer an approval. Body: `{ toolUseID, approved: boolean }` |
| `POST` | `/sessions/:id/abort` | Stop a running turn |

`:id` is the `sessionId` from `/chat`. `config`, `status`, `permissions`, `abort` and `/events` also accept the agent's own session id (`sdkSessionId`), which is what a thread stores; answering an approval and `PATCH` need the `sessionId`.

## Event streams

| Method | Path | Description |
|---|---|---|
| `GET` | `/events?sessionId=<id>` | SSE stream for one session. Closes after `done`, `error` or `aborted` |
| `GET` | `/permissions/events` | SSE stream of every pending approval across all sessions |

Events carry a `seq` field and an SSE `id:`, so a client that reconnects with `Last-Event-ID` receives what it missed. A finished session replays its events and closes.

### `/events`

| Event | Payload | Meaning |
|---|---|---|
| `user_prompt` | `prompt`, `attachments?` | The prompt that started the turn |
| `system` | `subtype`, `data` or `session_id` | Agent session initialised |
| `assistant` | `content` | Assistant text |
| `tool_use` | `tool_name`, `tool_input` | The agent is calling a tool |
| `tool_result` | `tool_use_id`, `tool_name`, `output`, `exit_code`, `status` | A command finished (Codex) |
| `status` | `status`, `tool_name?`, `summary?` | Activity: `thinking`, `tool`, `tool_summary` |
| `permission_request` | `toolUseID`, `toolName`, `input` | The agent needs approval (Claude Code, OpenCode — Codex never asks; its permission mode selects a sandbox) |
| `result` | `subtype`, `cost`, `duration_ms`, `num_turns` | Turn statistics (Claude Code) |
| `agent_error` | `message` | The agent itself reported a problem — provider refused, bad model (OpenCode); a connection retry or transport fallback (Codex). Not terminal on its own: it is followed by a terminal event only if the turn actually fails |
| `done` | — | Turn finished |
| `aborted` | `message` | Turn was stopped |
| `error` | `message` | Turn failed |

### `/permissions/events`

| Event | Payload | Meaning |
|---|---|---|
| `permissions` | `permissions[]` | Full snapshot of pending approvals |

Each entry has `sessionId`, `agent`, `repoPath`, `repoName`, `toolUseID`, `toolName` and `input`.
