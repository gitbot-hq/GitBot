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
| `GET` | `/threads/:id/messages` | `{ messages }` — history read from the transcript of the agent the thread runs on, plus the scheduled runs that failed before their agent started (see Schedules) |

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

A schedule sends a prompt into a thread at a given time, or again and again (a cron pattern in a timezone, or every N minutes), as a real turn: it goes through the same path as `POST /chat`, so it is streamed, stoppable and in the thread's history like any other. Stored in `<dataDir>/schedules.json` (`src/schedules.ts`) and fired by `src/scheduler.ts`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/schedules?threadId=<id>` | `{ schedules: Schedule[], owner: { pid, thisProcess: true } }`, optionally for one target thread |
| `POST` | `/schedules` | Create one. Body: `{ name, prompt, when, target: { kind: "thread", threadId }, overlap?, maxRuns?, endsAt? }` (see below). Returns the stored schedule plus `nextRuns`: its next 3 run times (ISO, fewer if `maxRuns` or `endsAt` stops it sooner) |
| `PATCH` | `/schedules/:id` | Pause, resume or edit it. Body: any of `{ enabled, name, prompt, when, overlap, maxRuns, endsAt }` (`null` clears `maxRuns` or `endsAt`), checked as `POST` checks them; anything else is `400`, and a refused edit changes nothing. Returns the schedule plus `nextRuns`. See **Pausing** below |
| `DELETE` | `/schedules/:id` | Delete it; a fire still due never happens. `{ ok: true }` |
| `POST` | `/schedules/:id/run` | Fire it now. Returns `{ schedule, run }`. Counts as a run (`runCount`, `history`; it can use up `maxRuns`) and leaves `nextRunAt` as it was, unless that time has already come — then this is that fire. Never held by the rate cap, though it counts toward it. On a busy thread it is queued like any fire (`overlap: "queue"`): `{ schedule, queued: true }`, with `schedule.pending`. `400` for a schedule of a kind this build does not run |

`when` is one of:

- `{ kind: "once", at }`: one run at `at`, an ISO time with a zone (`Z` or `±hh:mm`).
- `{ kind: "cron", expr, tz? }`: a 5-field cron pattern (`minute hour day month weekday`, e.g. `"0 9 * * 1-5"`; `@hourly`, `@daily` and the like work too) in the IANA timezone `tz`, default the server's own (`Intl.DateTimeFormat().resolvedOptions().timeZone`, or `UTC` if that isn't a region name). `tz` must be a region name (`Area/Location`, e.g. `Europe/London`) or `UTC`, and is stored in the canonical form Intl reports (`US/Eastern` becomes `America/New_York`, and `utc`, `GMT` and `Etc/UTC` become `UTC`; some aliases, like `Asia/Calcutta`, are kept as given, and work the same). A bare offset (`+05:30`), a fixed-offset `Etc/` zone (`Etc/GMT+5`, which is UTC−5) or an abbreviation (`EST`, `IST`) is refused: none follows DST the way the region it stands for does. Times come from [croner](https://croner.56k.guru), DST included: a wall time that happens twice when clocks go back runs once, and one that doesn't exist when they go forward runs an hour later. The next run is always strictly later than the last.
- `{ kind: "interval", everyMinutes, anchor? }`: every `everyMinutes` (a whole number, 1 to a year's worth) from `anchor` (an ISO time, default the time it is created): it runs at anchor + N, + 2N, … minutes (at the anchor itself first, if that is still ahead).

**A busy thread waits its turn.** A schedule never gets in the user's way: a fire whose thread is busy (a turn of its own running, or a Jarvis thread waiting on its child) starts nothing. What happens instead is the schedule's `overlap`, `"queue"` (the default) or `"skip"`:

- `queue`: the fire waits as the schedule's `pending: { dueAt }`, saved in `schedules.json`, and starts as soon as the thread's turn ends: after every turn-end listener and the UI broadcast, and after any child report queued on the same Jarvis thread (reports go first; `src/deferred-turns.ts`). One turn per turn end: that turn's own end starts the next thing waiting. Its `started` entry has `delayedMs`, how long it waited. A schedule holds one pending fire at most: a newer fire (its next occurrence, or a run now) replaces it, and the replaced one is recorded `skipped-busy` with its `dueAt`. A 1-minute schedule on a slow thread therefore runs back to back, never piling up. A pending fire is claimed when it starts: `runCount`, `lastRunAt` and the chip's "run N" are taken then. Its time still passes as usual, so `nextRunAt` moves on (or the schedule ends) when it comes due, and the pending fire holds its run meanwhile: a schedule whose pending fire is its last (a `once`, or the last of `maxRuns`) shows `enabled: false`, `nextRunAt: null` and still runs it. The user's own message always goes first: one sent while a fire waits runs at once, and the fire follows that turn. Deleting the schedule drops its pending fire. A pending fire is not held by the rate cap (it counts toward it). If gitbot stops while a fire is pending, the next start records it `missed` (at its `dueAt`, `missedCount: 1`) and clears it: never fired late.
- `skip`: the fire is recorded `skipped-busy`, and nothing waits.

A scheduled run is never a Jarvis child: it never locks a Jarvis composer, never reports, and a schedule on a thread whose Jarvis is waiting on another child runs as normal.

A cron or interval can end: `maxRuns` (a whole number, 1 to 100000) ends it once that many runs are used up, and `endsAt` (an ISO time after its first run) ends it before its first run at or after that time. An ended schedule has `enabled: false` and `nextRunAt: null`, and keeps its history. A once takes neither (`400`).

Only `target.kind: "thread"` is supported so far; other kinds are refused with `400` "not supported yet". `400` too for: `at`, `anchor` or `endsAt` not an ISO time with a zone, or not a real date and time (`2026-02-30T10:00Z` is refused); `at` not in the future; `everyMinutes` under 1 (the shortest gap between runs is 1 minute) or not whole; a cron that isn't 5 fields (6 or 7 would mean seconds or years, which are not supported; a 5-field pattern's runs can't be under a minute apart, so there is no separate gap check), one croner can't parse, or one that never comes due (`0 0 31 2 *`); a `tz` that isn't a known region name or `UTC`; an unknown thread or a setup thread; a `name` that is empty, over 60 characters, or contains `"`, `'`, `<` or `>`; a `prompt` that is empty or over 4000 characters; `attachments`; an `overlap` other than `queue` or `skip`; more than 20 *active* schedules on one thread (ones that can still fire: a fired or missed `once` is kept for its history but does not count), or 100 stored in all (every schedule counts). Every write is logged as `[schedules] <verb> <id> from <remote address>`, and a created schedule records it as `createdBy: { kind: "user", remote }`. The address is the connection's peer: behind a proxy, that is the proxy (the log adds any `X-Forwarded-For`, which is never trusted or stored). There is no access guard yet.

**Scheduled turns always auto-approve.** Nobody is there to answer an approval when a schedule fires, so every scheduled turn runs with `permissionMode: "yolo"` (tools run without asking) and never in plan-only mode, whatever the bot's default and whatever permission mode the user picked for the thread in the composer. That pick is a browser setting and is left untouched: the user's own next message runs in it as before, and the chat never adopts a scheduled turn's mode as the thread's. `GET /sessions/:id/config` returns `scheduled` for a session whose current (or last) turn a schedule started. Jarvis threads run auto-approve anyway. A scheduled turn's model and effort are the thread's own, as for any turn.

A schedule this build does not run (a `new-thread` target written by a later build, or a `when` it can't work out, like a bad pattern written by hand) is left exactly as it is: it never fires here and is logged once.

**Missed runs are skipped, never fired late.** When gitbot starts, a schedule whose `nextRunAt` has passed gets one `missed` entry, with `missedCount` the number of runs that came due while it was down (at most what `maxRuns` and `endsAt` allowed); it then moves to its next run after now, or ends. The same rule holds while gitbot runs. A due fire found more than 70 s late (the timer wakes at least once a minute, so the process was suspended or stalled, or the clock jumped forward), and not held by the rate cap, is recorded as `missed` like a run that came due while gitbot was down, together with any runs after it that have also passed. A fire held by the rate cap runs however late it gets, and the runs that passed while it waited are recorded as one `missed` entry after its `started` entry. Missed runs count toward `maxRuns`. An interval's count is always exact. A cron's is exact for up to 20 runs; beyond that it is counted on the zone's wall clock and, past 500, estimated from the average gap, so it can be off by up to an hour's runs per DST change inside the gap, or a little more for a very long gap (the log says "about"). When the gap ends within 3 hours of a DST change, those last 3 hours are counted exactly. If the missed record can't be saved (a full disk at startup), the schedule never fires until it is: it is retried every 10 s (and logged again once a minute while it keeps failing), and then runs on from its next run.

**At most 5 scheduled turns start in any rolling minute**, across gitbot. A fire over the cap is not claimed: its `runCount` and `nextRunAt` stay as they were, and it is tried again when the minute has room (at most 10 s later), earliest-due first. Its `started` entry then has `delayedMs`, how late it started. Only turns that start count: a fire that was skipped or queued (busy) or failed to start uses no slot. If gitbot stops while a fire is waiting, it is recorded as missed at the next start. The window survives a restart: scheduled starts in the minute before it, read from the history, still count. The log shows `[scheduler] rate cap: …` when a fire waits.

**A schedule that keeps failing pauses itself.** A run fails when its turn starts and ends `failed` (status `error`, or a result that reports an error: out of turns, budget, an API error), or when it is `failed-to-start`. Each adds one to `consecutiveFailures`; a `done` turn sets it back to 0. A turn the user stops (`stopped`), a busy fire (`skipped-busy`, or a fire waiting as `pending`), a missed run and a turn gitbot's own shutdown killed change nothing. The count is taken from the turn as it ended, so it holds even when its `started` entry would have aged out of the 20 kept (the newest `started` entry still waiting for its outcome is never trimmed). After 3 failures in a row the schedule pauses: `enabled: false`, `nextRunAt: null`, `pausedReason: "paused after 3 failed runs: <the last error line>"`, and any `pending` fire is dropped. One push of kind `failed` says so: titled with the schedule's name, body `⏰ <name> paused after 3 failed runs`, opening the thread. It has the thread's tag (`thread-<id>`) and stands in for that turn's own "failed" push, so the third failure makes one notification, not two; it is sent at once, without the presence hold (the thread itself does not show the pause). A start that can never work pauses it at once, with its own reason and push (`⏰ <name> paused: <reason>`): its thread is gone (`"its thread was deleted"`) or the thread's bot is (`"its thread's bot was deleted"`). A schedule that is already paused or has ended keeps counting but does not pause again. A paused schedule can still be run now (`POST /schedules/:id/run`).

**Pausing, resuming and editing (`PATCH /schedules/:id`).** `{ enabled: false }` pauses it: `nextRunAt: null`, `pausedReason: "paused by the user"` (a reason already there is kept), and its `pending` fire is dropped (it never started, so it is not counted). `{ enabled: true }` resumes a paused schedule: `pausedReason` is cleared, `consecutiveFailures` reset to 0 and `nextRunAt` set to its next run after now. Runs that came due while it was paused never fire and are not recorded. A schedule that has ended can't be resumed (`400` "this schedule has ended"): a `once` whose time has passed (so one that has fired or been missed; earlier runs, from a run now or an earlier `when`, don't count), one whose `maxRuns` is used up (raise it in the same `PATCH` to resume), or one with no run left before `endsAt`. `{ enabled: true }` on a schedule that is running already changes nothing. A new `when` drops a `pending` fire of the old times, but keeps a run now the user queued (`pending.manual: true`), which still runs when the thread is free; on an enabled schedule it also moves `nextRunAt` to its first run after now (a `once` keeps `at` as sent). A `once` takes no `maxRuns` or `endsAt`, and switching to one drops them. `endsAt` must be after the next run, and `maxRuns` more than the runs already used (`400` otherwise). `target`, `notify` and the rest can't be changed. A paused schedule shows as `enabled: false` with a `pausedReason`; an ended one has none. Pausing an ended schedule that still holds a fire (a `once`, or its last run, waiting on a busy thread) drops the fire and leaves it ended, with no `pausedReason`, unless dropping it freed a `maxRuns` run, in which case it is paused and can be resumed. Logged as `[schedules] pause|resume|update <id> from <remote address>`.

A `schedules.json` that does not parse is read as no schedules (gitbot still starts), and is moved aside to `schedules.json.bad-<time>` before the next write, so nothing overwrites it.

A schedule has `id`, `name`, `prompt`, `when`, `target`, `createdBy`, `enabled`, `overlap` (`queue` or `skip`), `notify` (`always`), `maxRuns?`, `endsAt?`, `runCount` (runs used up: every fire, however it turned out, every pending fire given up, and every missed run; a pending fire counts once it starts), `consecutiveFailures` (failed runs in a row, see below), `pausedReason?` (why it is paused), `nextRunAt` (null once it will not fire again, or while it is paused), `lastRunAt`, `pending?` (`{ dueAt, manual? }`: a fire waiting for its busy thread; `manual` when it is a run now), `history` (the last 20 runs; the newest `started` one still waiting for its outcome is kept in place of the oldest) and `createdAt` / `updatedAt`. A run is `{ at, outcome, threadId?, turnOutcome?, error?, missedCount?, delayedMs?, dueAt? }`, where `outcome` is:

- `started`: its turn began; `turnOutcome` (`done`, `failed` or `stopped`) is added when it ends. `delayedMs` when it started late: held by the rate cap, or pending behind a busy thread
- `skipped-busy`: the thread had a turn running (or is a Jarvis thread waiting on a child), so nothing started: with `overlap: "skip"`, or a pending fire a newer one replaced (`dueAt`: when that one came due)
- `failed-to-start`: the turn was refused (the thread is gone, its agent is not installed, its bot still needs to set up this machine, …); `error` says why
- `missed`: `missedCount` runs, the first at `at`, came due and never fired (gitbot was not running, or a fire waited past them, or a pending fire was still waiting when gitbot stopped). They are never fired late

A fire is claimed before its turn starts (a pending fire, once the drain starts it): `runCount`, `lastRunAt` and the next `nextRunAt` are saved first (a `once`, or a schedule whose run was its last, is ended), so a crash in between never fires it twice. The chip's "run N" is `runCount` at the claim, so after missed runs it skips ahead. A scheduled turn never reports to Jarvis, never changes who owns the thread, and does not take a Jarvis thread's pending note (that waits for the user's next message).

**What the agent sees.** The agent's prompt starts with `<gitbot-schedule id="…" name="…" run="N"/>` on its own line. When history is read back, only a tag at the very start of a user message counts (never one quoted later in a message, or in a compaction summary). Nowhere else carries it: the thread's title and preview, the `user_prompt` event and `GET /threads/:id/messages` all have the prompt as written. Instead, `user_prompt` and the user message in history carry `scheduled: { id, name, run }`, and the chat draws "⏰ Scheduled · name · run N" on the bubble from that. A scheduled run that fails before its agent starts (its folder is gone, the agent won't launch) never reaches the transcript, so gitbot keeps it on the thread (`failedRuns`, the last 20: `{ at, endedAt, prompt, scheduled, error }`, not writable through `PATCH /threads/:id`) and `GET /threads/:id/messages` merges each one in by time: its prompt as a scheduled user message, then `{ role: "assistant", content: [the error as text], error }`, which the chat draws as an error line. One the transcript turns out to have is not shown twice. "Before its agent started" means the agent never got the prompt (each runner marks the turn once it hands the prompt over), so a provider error after that (a rate limit on an OpenCode resume) is an ordinary failed turn, in the transcript. A thread with no session yet shows its failed runs too. Codex and OpenCode transcripts carry no times, so there a failed run is only shown last, and the next turn that reaches the agent drops the ones before it. Jarvis's thread tools label a failed run's error as such and never report it as what the thread last said. The transcript side is Claude Code's only, for now: on Codex and OpenCode threads a schedule's turn runs untagged, so its message loses `scheduled` (and the chip) once it is read back from the agent's own transcript.

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
