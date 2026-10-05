# Jarvis

Design for Jarvis, gitbot's built-in manager bot. Status: agreed design, not yet built. For how gitbot works today, see [ARCHITECTURE.md](ARCHITECTURE.md).

## The idea

Today you drive every bot yourself: pick a bot, pick a folder, sit in the thread. Jarvis is one bot you talk to instead. You tell it what you want done; it works out where the work happens and what should do it, starts that work in a thread of its own, and reports back when it is done.

Jarvis's job is delegation. It handles cheap things itself — git, `gh`, read-only checks — and hands changes to a project's code to a child thread.

## Concepts

- **Projects are where.** A project is a folder Jarvis can run work in: a git repo's root, or any folder a gitbot thread has run in. A folder holding several repos is not itself a project; each repo inside it is. A project carries no behaviour and names no default bot.
- **Bots are abilities.** Jarvis may use a bot when one fits the task, or not. The choice is left to Jarvis.
- **Plain agents are the fallback.** Each installed agent gets a built-in bot with no instructions — **Claude Code**, **Codex**, **OpenCode**. "Plain Claude Code in Trophy" is a thread of the Claude Code bot in Trophy's folder. Every thread is therefore a bot thread, and `Thread.botId` stays required.
- **Jarvis threads.** Jarvis is itself a built-in bot, and each conversation with it is an ordinary thread. The intended use is a new Jarvis thread per task; a follow-up on the same work stays in the same thread for its context.

## Jarvis itself

- Runs on **Claude Code** in v1, on gitbot's default model. Choosing its agent at onboarding, and model switching, come later.
- Always works in `~/.gitbot/jarvis/` (under `GITBOT_DATA_DIR`), never in a project folder. This is enforced: the folder is not a choice the thread offers.
- Runs in **auto-approve**.
- **Not editable.** Its prompt and tools are fixed. It does not appear in the bot editor and cannot be shared or published.
- **Its tools are not blocked.** Jarvis may edit files when a task calls for it. That changes to project code go to a child thread is an instruction in its prompt, not a restriction.

### Tools

Jarvis's tools are defined with the Agent SDK's `tool()` and `createSdkMcpServer()`. That server runs inside the gitbot process — no separate process or port. It is created per Jarvis session and passed through `query()`'s `mcpServers` option only for Jarvis threads, so no other bot can see these tools: not through the user's Claude settings, and not on Codex or OpenCode. Being per-session, each tool knows which Jarvis thread is calling it.

Lists return names only, to keep tokens down; details are a second call, for as many items as Jarvis asks for at once.

| Tool | Returns / does |
|---|---|
| `list_projects()` | Project ids and names |
| `get_projects([ids])` | Folder, git remote, current branch, and the project's memory (path and contents) |
| `add_project(path)` | Adds a folder it found to the index |
| `list_bots()` | Bot ids and names, plus a marker on bots whose setup is pending or failed |
| `get_bots([ids], includeInstructions?)` | Description, agent, default folder, setup status. Instructions only with the flag, which Jarvis uses only when the user asks |
| `list_threads(project?, bot?)` | gitbot threads, to find one to continue |
| `start_thread({ bot } \| { agent }, project, message, permissionMode?)` | Starts a child thread with its first message |
| `send_to_thread(threadId, message)` | Continues an existing gitbot thread |
| `thread_status(threadId)` | Running, waiting on approval, done, failed or stopped, with the last message |
| `read_thread_tail(threadId, n)` | Earlier messages, when the last one is not enough |

No `clone_repo`: Jarvis has the `gh` CLI and git through its shell.

### Prompt rules

- **Choosing what does the work** is Jarvis's call: a bot it thinks fits, otherwise a plain agent thread with the first message filled in.
- **Choosing the folder**, in order:
  1. a project the user names — earlier in the same Jarvis thread counts;
  2. the default folder of a bot the user names, whether or not they say "bot";
  3. otherwise ask.
- **A bot that is not set up** on this machine: say so; do not start its setup run.
- **Delegate project code changes** to a child thread. Use the shell for git, `gh` and read-only checks.
- **Project memory** — see below.

## Child threads

### Ownership

A thread reports to the Jarvis thread that last sent it a message, recorded on the thread as `reportTo: <jarvisThreadId>`. Starting a thread or continuing one with `send_to_thread` sets it. When the user types in that thread themselves, ownership passes to them and reports stop. Threads the user starts never report to Jarvis. Jarvis threads never see each other's children.

`send_to_thread` refuses a thread that is mid-turn. A continued bot thread keeps its bot and its agent.

### Lock and wake

Jarvis does not wait inside a tool call. `start_thread` returns at once and Jarvis's turn ends. The Jarvis thread then shows as **waiting on child**: its composer is locked and reads, for example, "PR Validator is working on Trophy · open thread". There is at most one running child per Jarvis thread, and the user cannot type into a locked thread, so neither user messages nor reports ever need a queue.

When the child's turn ends — done, error, or aborted — gitbot takes the child's last top-level assistant message (the same extraction `recordSetupOutcomeFromEvents` does for setup runs), caps it at about 4,000 characters, and starts a Jarvis turn with it:

```
[PR Validator · Trophy · thread <id> · done]
<last message>
```

A child asking a question is just a turn that ended with a question; there is no separate "needs input" state. Jarvis either answers the user — which unlocks the thread — or starts the next child, which keeps it locked. This is how sequences run: one child at a time, each step started by the previous one's report. The children never know Jarvis exists; nothing reports through a tool the child has to call.

### While locked

- **Open thread** — jump to the child and work with it directly.
- **Stop** — sits where the send button is. Aborts the child through the existing abort path and unlocks the Jarvis thread. Jarvis is not woken; `[you stopped PR Validator on Trophy]` is prepended to the user's next message. Because each step of a sequence is started by a report, stopping the child stops the sequence.
- **Awaiting permission** — when the child is waiting on an approval, gitbot shows it in the Jarvis thread without waking Jarvis: the server already tracks pending approvals, so the UI renders the notice itself. Jarvis does not approve on the user's behalf. The notice appears in two places:
  - **a row in the conversation**, styled like Jarvis's own messages but placed by gitbot, naming the bot and what it wants to do:

    > ⏸ **PR Validator** needs permission to run `npm test` · **Review**

    **Review** switches the hub to the child thread with its approval card in view. The row stays in the thread's history and updates in place once answered — "Approved: `npm test`" or "Denied: `npm test`". Several approvals in a row stack as rows, so the thread shows what was asked and what was answered.
  - **the locked composer**, whose status line changes from "working" to "PR Validator is waiting on your approval · Review", so the state is visible even when the row has scrolled away.

  Waking Jarvis for an approval would cost a turn and tokens, arrive later than the UI can, and give Jarvis a turn while its child is still alive with nothing it is allowed to do. Once Jarvis can approve through conversation, waking it becomes worth it.

### Restarts

Sessions live in memory, so restarting gitbot kills a running child. On start, gitbot unlocks any Jarvis thread whose child was running, and the next message to it is prepended with `[PR Validator on Trophy was interrupted by a restart]`.

## Permissions

| Thread | Mode |
|---|---|
| Jarvis | auto-approve |
| Plain agent child | auto-approve, unless the user asks Jarvis for another mode (`permissionMode`) |
| Bot child | the bot's own mode, unless the user asks Jarvis to override it |

Auto-approve maps to `yolo` on Claude Code and OpenCode, and to `danger-full-access` on Codex — no sandbox at all.

## Project index

Not built at server start. Built the first time a Jarvis thread calls `list_projects`, stored in `~/.gitbot/projects.json`.

Sources:

1. **Workspace scan** — `.git` directories under the folder gitbot was started in, to a depth of about 4, skipping `node_modules`, `.next`, `dist` and the like, and not descending into a repo once found. The scan does not report nested repos or submodules; one becomes a project of its own when a thread runs in it or Jarvis adds it.
2. **gitbot threads** — every folder a gitbot thread has run in; a thread starting in a new folder adds it.
3. **`add_project`** — Jarvis adds a folder it found with the shell when the user names a project the index lacks.

Agents' own session histories (`~/.claude/projects`, `~/.codex/sessions`) are deliberately not a source: each agent stores them differently and gitbot does not own those formats.

Refresh: the workspace is rescanned when the index is over about a day old. Entries whose folder no longer exists are dropped when listed. A project's name is its folder's name; when two collide, the parent is added (`work/api`, `personal/api`).

## Project memory

One file per project, `~/.gitbot/projects/<id>/memory.md`, outside the repo. Shared by every Jarvis thread; read by Jarvis only, through `get_projects`. Jarvis passes on what matters to a child in its first message. Giving children the memory directly can come later.

Jarvis edits it with its ordinary tools. Kept lean by its prompt:

- write only when the user states a preference or corrects Jarvis, or a fact changes how work happens in the project — not observations;
- one short bullet per entry; rewrite or remove rather than append;
- a soft limit of about 20 bullets.

It is plain markdown; the user can edit it too.

## UI

- Jarvis is pinned at the top of the bot list, set apart from other bots.
- gitbot opens on a new Jarvis thread. Onboarding no longer means an empty hub: Jarvis always exists, and creating bots is optional.
- The plain agent bots get a section of their own rather than mixing with the user's bots.
- Child threads stay listed under their own bots. A Jarvis thread shows a panel of the threads it started.
- Report turns show in the Jarvis thread as a compact row, not as a user message.
- The locked composer: status line, **Open thread**, **Stop**, and **Review** when an approval is waiting.
- Approval rows in the Jarvis thread, rendered by gitbot (see [While locked](#while-locked)).
- Attention signals when you are elsewhere — see below.

### Attention signals

With several Jarvis threads, the one that needs you must be findable from anywhere in the app. Two states:

- **Needs you** — one of the thread's children is waiting on an approval.
- **Has news** — a Jarvis turn ended (usually after a report) since you last viewed the thread.

Shown at three levels:

1. **Thread row** — an amber marker for "needs you", a dot for "has news"; the preview shows the latest line ("PR Validator needs permission to run `npm test`"). Threads that need you sort to the top.
2. **Jarvis in the Bots panel** — a count across all its threads ("2 need you"), visible while another bot is selected.
3. **Browser tab title** — "(2) gitbot" while anything needs you.

#### What it takes

Most of this exists. `GET /permissions/events` is already one global stream that sends a full snapshot — every pending approval and every session's status — whenever either changes, and every agent adapter already fires it at turn end and on approval changes. The additions:

- **`threadId` on each session in that snapshot.** `SessionStore` already holds it; the snapshot does not include it. With it, the UI maps "session awaiting permissions" to "child thread X", and through the child's `reportTo` to its Jarvis thread.
- **`Thread.lastActivityAt`**, set when a turn ends. `updatedAt` is not used for this because renames and other edits bump it too.
- **`Thread.lastSeenAt`**, plus `POST /threads/:id/seen`, called when a thread is opened or receives events while open. "Has news" is `lastActivityAt > lastSeenAt`. Stored on the server, so reading on one device clears it on another.
- **UI:** the markers, the sort, the Jarvis count and the tab title — all derived from the stream and the thread list, no state of their own.

No new stream, no new event types, no notification permissions. Each piece can be tested alone: the snapshot field by reading the stream, the unread rule against the two timestamps, the UI from a fixed snapshot.
- Bot creation and the bot-author prompt nudge towards names that say what a bot does, since a name is often all Jarvis sees.

## Data model changes

- `Bot`: a `builtin` marker — `"jarvis"`, or the agent for a plain agent bot. Built-in bots are not stored in `bots.json`, not editable, not shareable.
- `Thread`: `reportTo?: string` — the owning Jarvis thread; `lastActivityAt` and `lastSeenAt` — for attention signals.
- `GET /permissions/events` snapshot: `threadId` on each session.
- New `projects.json` and `projects/<id>/memory.md` under the data dir.
- Jarvis thread state ("waiting on child", and which child) is derived from its children's `reportTo` and their session status rather than stored separately.

## Before it ships

gitbot has no authentication and can be reached from the network. With Jarvis holding `gh`, starting children in auto-approve, the open port is the whole machine and the user's GitHub account. Jarvis needs at least an access token, or to be limited to localhost until there is one.

## Later

- Approving a child's tool calls by talking to Jarvis.
- Choosing Jarvis's agent at onboarding (Codex needs a real MCP server; OpenCode its plugin or tool files) and its model.
- Children reading project memory directly.
- Handling two Jarvis threads running children in the same folder — for now allowed, and the user's to avoid.
- Stopping or redirecting a child by message instead of the button.
- OS notifications. They need the browser's notification permission and a secure origin — `localhost` qualifies, but plain HTTP on a network address does not, which is how phones connect today.
