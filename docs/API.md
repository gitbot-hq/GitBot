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
| `GET` | `/agents` | `{ agents: string[] }` — the agents installed on this machine, in order of preference. Values: `claude-code`, `opencode`, `codex` |
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
| `GET` | `/bots` | `{ bots: Bot[] }` — Jarvis (always, even without Claude Code; its threads then cannot be made or run), your bots by name, then the built-in plain agent bots for the installed agents |
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
| `agent` | `claude-code` \| `opencode` \| `codex` | Which agent runs the bot. Default `claude-code`. Any other value is a `400` |
| `instructions` | string | The bot's job. Sent to the agent on top of its own system prompt |
| `setupInstructions` | string | What the bot needs from a machine. Blank means no setup run. See [setup](../README.md#bots-set-themselves-up) |
| `model` | string | Optional. OpenCode needs `provider/model` — run `opencode models` for the values that install accepts |
| `repoPath` | string | Default folder for new threads |
| `permissionMode` | `ask-permissions` \| `auto-approve` \| `plan` | Default `ask-permissions` |
| `allowedTools` | string[] | The only tools the bot may use. Blank means all. Not applied to setup runs. Not supported on Codex |
| `disallowedTools` | string[] | Tools the bot may never use. Not supported on Codex |

Read-only fields the server maintains: `id`, `setupStatus` (`pending` \| `complete` \| `failed`), `setupThreadId`, `createdAt`, `updatedAt`.

**Built-in bots.** Each installed agent has a plain bot with no instructions — **Claude Code**, **Codex**, **OpenCode** — with id `builtin-<agent>` and `builtin` set to its agent. They are defined in code, not stored. `PATCH`, `DELETE` and `POST /setup` on them return `403`. A thread made with one always runs on that bot's agent; an `agent` in the request is ignored, and `POST /threads` returns `400` while that agent is not installed. Records in `bots.json` cannot take a built-in's id or claim `builtin`.

**Jarvis.** A built-in bot with id `builtin-jarvis` and `builtin: "jarvis"`, refused like the others on change. Its threads always run Claude Code in `<dataDir>/jarvis/`, in auto-approve: `repoPath`, `agent`, `permissionMode` and `mode` in `POST /threads` or `POST /chat` are ignored for it, as are `repoPath`, `agent`, `kind` and `sdkSessionId` in `PATCH /threads/:id`. Its `model` and `effort` are *not* fixed: they resolve like any Claude Code thread's — `POST /chat`'s `model`/`effort`, else the thread's own (set with `PATCH /threads/:id`), else `default` / `medium` — and are sent to the SDK on every turn, resume included. `PATCH /sessions/:id` with a `permissionMode` or `mode` returns `409` on a Jarvis session, and a `POST /chat` without `threadId` that reaches one returns `400`. Only Jarvis sessions get its tools (`mcp__gitbot__list_bots`, `mcp__gitbot__get_bots`, `mcp__gitbot__list_projects`, `mcp__gitbot__get_projects`, `mcp__gitbot__add_project`, `mcp__gitbot__remember`, `mcp__gitbot__forget`, `mcp__gitbot__start_thread`), an in-process MCP server built per turn (`src/jarvis.ts`). `start_thread` makes a child thread under its own bot in a project's folder, with `reportTo` set to the calling Jarvis thread, and starts its first turn through the same path as `POST /chat` (`startTurn` in `src/turns.ts`): plain agent children run in auto-approve, bot children in the bot's own mode, unless Jarvis passes a `permissionMode`. The project tools read `<dataDir>/projects.json` (`src/project-index.ts`), created on the first `list_projects` call from the folders threads ran in; no route serves it. Each project's memory is plain markdown at `<dataDir>/projects/<id>/memory.md` (`src/project-memory.ts`): `get_projects` returns its contents (cut at 8 KB), and `remember` / `forget` change it a bullet at a time, at most 20 bullets.

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

A thread records `agent` and `sdkSessionId` on its first turn and keeps them: a session id only means something to the agent that issued it. Other fields: `kind` (`chat` \| `setup`), `title`, `repoPath`, `preview`, `messageCount`, `reportTo` (the Jarvis thread that started it, when one did), `createdAt`, `updatedAt`.

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

## Schedules

A schedule sends a prompt into a thread at a given time, as a real turn: it goes through the same path as `POST /chat`, so it is streamed, stoppable and in the thread's history like any other. Stored in `<dataDir>/schedules.json` (`src/schedules.ts`) and fired by `src/scheduler.ts`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/schedules?threadId=<id>` | `{ schedules: Schedule[], owner: { pid, thisProcess: true } }`, optionally for one target thread |
| `POST` | `/schedules` | Create one. Body: `{ name, prompt, when: { kind: "once", at }, target: { kind: "thread", threadId } }`. Returns the stored schedule |
| `DELETE` | `/schedules/:id` | Delete it; a fire still due never happens. `{ ok: true }` |
| `POST` | `/schedules/:id/run` | Fire it now. Returns `{ schedule, run }`. Counts as a run (`runCount`, `history`) and leaves `nextRunAt` as it was, unless that time has already come — then this is that fire. `400` for a schedule of a kind this build does not run |

Only `when.kind: "once"` and `target.kind: "thread"` are supported so far; other kinds are refused with `400` "not supported yet". `400` too for: `at` not an ISO time with a zone (`Z` or `±hh:mm`), not a real date and time (`2026-02-30T10:00Z` is refused), or not in the future; an unknown thread or a setup thread; a `name` that is empty, over 60 characters, or contains `"`, `'`, `<` or `>`; a `prompt` that is empty or over 4000 characters; `attachments`; more than 20 *active* schedules on one thread (ones that can still fire: a fired or missed `once` is kept for its history but does not count), or 100 stored in all (every schedule counts). Every write is logged as `[schedules] <verb> <id> from <remote address>`, and a created schedule records it as `createdBy: { kind: "user", remote }`. The address is the connection's peer: behind a proxy, that is the proxy (the log adds any `X-Forwarded-For`, which is never trusted or stored). There is no access guard yet.

**Scheduled turns always auto-approve.** Nobody is there to answer an approval when a schedule fires, so every scheduled turn runs with `permissionMode: "yolo"` (tools run without asking) and never in plan-only mode, whatever the bot's default and whatever permission mode the user picked for the thread in the composer. That pick is a browser setting and is left untouched: the user's own next message runs in it as before, and the chat never adopts a scheduled turn's mode as the thread's. `GET /sessions/:id/config` returns `scheduled` for a session whose current (or last) turn a schedule started. Jarvis threads run auto-approve anyway. A scheduled turn's model and effort are the thread's own, as for any turn.

A schedule of a kind this build does not run (a `cron` or `interval`, or a `new-thread` target, written by a later build or by hand) is left exactly as it is: it never fires here and is logged once. A `schedules.json` that does not parse is read as no schedules (gitbot still starts), and is moved aside to `schedules.json.bad-<time>` before the next write, so nothing overwrites it.

A schedule has `id`, `name`, `prompt`, `when`, `target`, `createdBy`, `enabled`, `overlap` (`queue`), `notify` (`always`), `runCount`, `consecutiveFailures`, `nextRunAt` (null once it will not fire again), `lastRunAt`, `history` (the last 20 runs) and `createdAt` / `updatedAt`. A run is `{ at, outcome, threadId?, turnOutcome?, error?, missedCount? }`, where `outcome` is:

- `started`: its turn began; `turnOutcome` (`done`, `failed` or `stopped`) is added when it ends
- `skipped-busy`: the thread had a turn running (or is a Jarvis thread waiting on a child), so nothing started
- `failed-to-start`: the turn was refused (the thread is gone, its agent is not installed, its bot still needs to set up this machine, …); `error` says why
- `missed`: its time passed while gitbot was not running. A missed `once` is never fired late

A fire is claimed before its turn starts: `runCount` and `lastRunAt` are saved first (and a `once` is disabled, with `nextRunAt: null`), so a crash in between never fires it twice. A scheduled turn never reports to Jarvis, never changes who owns the thread, and does not take a Jarvis thread's pending note (that waits for the user's next message).

**What the agent sees.** The agent's prompt starts with `<gitbot-schedule id="…" name="…" run="N"/>` on its own line. When history is read back, only a tag at the very start of a user message counts (never one quoted later in a message, or in a compaction summary). Nowhere else carries it: the thread's title and preview, the `user_prompt` event and `GET /threads/:id/messages` all have the prompt as written. Instead, `user_prompt` and the user message in history carry `scheduled: { id, name, run }`, and the chat draws "⏰ Scheduled · name · run N" on the bubble from that. The transcript side is Claude Code's only, for now: on Codex and OpenCode threads a schedule's turn runs untagged, so its message loses `scheduled` (and the chip) once it is read back from the agent's own transcript.

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
| `user_prompt` | `prompt`, `attachments?`, `scheduled?` | The prompt that started the turn; `scheduled` when a [schedule](#schedules) sent it |
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
