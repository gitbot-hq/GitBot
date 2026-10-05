# 02 · Spike: server-started turns and SDK tools on resume

Type: HITL

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

Throwaway code to answer two questions the design depends on, before anything is built on them. The output is a short written finding appended to this issue, plus a go / adjust decision.

1. **Server-started turn.** Today every turn starts from a message the browser sends. Jarvis needs gitbot to start a turn itself (a child's report). Can the server start a turn on an existing thread, and does a browser that already has the thread open pick it up through the existing reconnect / status / SSE path, including replay?
2. **In-process SDK tools across resume.** Define one tool with the Agent SDK's `tool()` + `createSdkMcpServer()`, pass it via `mcpServers` to `query()`. Does the tool work on the first turn, and still work on a resumed session? Does a per-session instance close over per-thread context correctly? Confirm the tool is absent from a session that does not receive the server.

## Acceptance criteria

- [ ] Finding for (1): works as-is, or what has to change in the session / UI path
- [ ] Finding for (2): works on first turn and on resume, tool naming as the model sees it, any gotchas
- [ ] Decision recorded: design holds, or `docs/JARVIS.md` updated
- [ ] Spike code deleted or clearly isolated; nothing merged into the product

## Blocked by

None - can start immediately

## Findings (2026-10-03)

Decision: **design holds.** Spike code lives on branch `worktree-agent-a9ed940e427b24518` only; not merged.

1. **Server-started turn:** works on the server as-is — same session path, `/events` replay, `409` to a concurrent send (once the store is found). The UI does not notice it in an already-open tab; see the notes in [07](07-child-wakes-jarvis.md). Two problems were parked in [../future/](../future/README.md).
2. **SDK tools across resume:** work on the first turn, on resume (fresh server instance per turn), and with per-session closures; absent from sessions not given the server. The model sees `mcp__<server>__<tool>`. Name the server `gitbot` (user MCP servers also load via `settingSources`). `canUseTool` fires for these tools, so Jarvis's options must allow them (Jarvis runs auto-approve). Add `zod` as a direct dependency.
