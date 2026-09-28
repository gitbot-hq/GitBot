# CDX-1 — app-server client + command approval, end to end

**Depends on:** nothing. **Status:** not started.

The tracer bullet. One thin vertical slice that proves a human can approve a
Codex command from the browser. Breadth comes later; this issue is about the
transport being real.

## Slice

A codex thread, started with `GITBOT_CODEX_APP_SERVER=1`, asked to run a shell
command, shows an **Allow / Deny** card in the browser. Allow runs it and the
output appears. Deny reports the rejection to the agent. No other behaviour is
required to work yet.

## Build

New file `src/codex-app-server.ts` — the JSON-RPC client, deliberately separate
from `src/start-codex.ts` so the SDK path stays intact and shippable.

- Spawn `codex app-server` with stdio pipes. Newline-delimited JSON-RPC 2.0
  both directions. For now resolve the binary the same way `createCodex()` does
  (`src/start-codex.ts:73`); proper resolution is CDX-2.
- Line-framed reader. Classify each inbound message:
  - `method` **and** `id` → **ServerRequest**, must be answered.
  - `method`, no `id` → notification.
  - `id`, no `method` → response to one of our requests; settle from an
    id→promise map.
  - Note: responses from this server **omit the `jsonrpc` field**. Do not
    validate on it.
- Handshake: `initialize` with
  `{clientInfo:{name,title,version}, capabilities:{experimentalApi:true, requestAttestation:false}}`,
  then the `initialized` notification.
- `thread/start` with `{cwd, sandbox, approvalPolicy:"on-request", approvalsReviewer:"user"}`.
  `approvalsReviewer` is not optional — the default sends approvals to an LLM
  subagent instead of to us.
- `turn/start` with `{threadId, input:[{type:"text", text}]}`. It returns
  immediately with `status:"inProgress"`; completion arrives as a notification.
- Wire `src/start-codex.ts` `runAgent()` to use this client when
  `process.env.GITBOT_CODEX_APP_SERVER === "1"`, otherwise the existing SDK
  path, unchanged.

Approval handling — map onto the existing contract, which already fits:

- On `item/commandExecution/requestApproval`: build
  `{toolName:"Bash", input:{command: params.command, cwd: params.cwd}}`, store in
  `store.pendingPermissions` keyed by the **JSON-RPC `id`** (not `itemId` — one
  `itemId` can raise several approvals), call `notifyPermissionsChanged()`, and
  `emitEvent(store, "permission_request", {toolUseID, toolName, input})`.
- The `resolve` stored in `PendingPermission` writes the JSON-RPC response
  instead of returning a behavior object:
  `{id, result:{decision: approved ? "accept" : "decline"}}`.
- Honour `shouldAutoApprove(store.agent, toolName, store.permissionMode)` before
  prompting, exactly as `canUseTool` does (`src/start-claude-code.ts:102`).
- `POST /sessions/:id/permission` (`src/server.ts:196`) currently branches on
  `claude-code` / `opencode` only. Add the codex branch.

**Safety net — do this or turns will hang.** Any `ServerRequest` we do not
handle must still be answered. Add a default responder that declines or cancels
unknown methods and logs the method name. Covers `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`,
`mcpServer/elicitation/request`, `item/tool/call`, and the legacy v1
`execCommandApproval` / `applyPatchApproval`. Proper handling is CDX-4.

Minimal notification mapping for this slice only — `thread/started` (bind
`sdkSessionId`, `bindSession()`), `item/started` + `item/completed` for
`commandExecution`, `item/completed` for `agentMessage`, `turn/completed`,
`turn/failed`, `error`. Everything else may be ignored with a debug log; CDX-3
finishes it.

## Acceptance criteria

Physically tested against a running hub, not just compiled.

1. `npm run build:cli` passes.
2. With the flag **off**, codex behaves exactly as it does on `main` — no
   regression. Verify by running a turn.
3. With the flag **on**, in `ask-permissions` mode, a prompt that needs a shell
   command produces an Allow/Deny card in the browser.
4. Allow → command executes, output renders, turn completes.
5. Deny → item reports `declined`, the agent says it was rejected, turn still
   completes cleanly (no hang).
6. `GET /sessions/:id/permissions` lists the pending approval while it is
   waiting, and stops listing it once answered.
7. A second turn on the same thread resumes it (`thread/resume`) rather than
   starting a new conversation — check the thread id is stable.
8. Killing the browser mid-approval does not wedge the server; the child is
   reaped on session cleanup.

## Review focus (adversarial)

- **Hangs.** Is there *any* inbound `ServerRequest` path that can go
  unanswered? Malformed params, unknown method, exception thrown inside the
  handler, request arriving after the turn was aborted.
- **Blocking the reader.** Approvals must not be answered synchronously inside
  the read loop — streamed deltas would stall while the user thinks. Confirm
  the loop keeps draining.
- **Framing.** Partial lines across chunk boundaries, very large payloads (the
  protocol has 200KB+ messages), non-UTF8 bytes, a line that is not JSON.
- **Correlation.** Key on JSON-RPC `id`. Check nothing keys on `itemId`.
- **Leaks.** Child process on abort, error, and normal completion. Pending
  promises on child exit — do they reject, or hang forever?
- **Flag discipline.** Is the SDK path genuinely untouched when the flag is off?
