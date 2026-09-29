# CDX-3 — Full event/item mapping parity

**Depends on:** CDX-1. **Status:** not started.

CDX-1 maps only what the tracer bullet needs. This brings the app-server path up
to — and past — what `handleEvent()` / `handleItem()`
(`src/start-codex.ts:286-406`) render today.

## Why it is a rewrite, not a rename

app-server uses camelCase and different item names:

| SDK (`exec --experimental-json`) | app-server |
| --- | --- |
| `agent_message` | `agentMessage` |
| `command_execution` | `commandExecution` |
| `file_change` | `fileChange` |
| `mcp_tool_call` | `mcpToolCall` |
| `web_search` | `webSearch` |
| `todo_list` | `plan` |

Upside: app-server carries strictly more — `aggregatedOutput` deltas, `exitCode`,
`durationMs`, `commandActions`, and a `declined` status the SDK never surfaces.

## Build

Do not hand-write the types. Generate them, pinned to the shipped CLI version:

```
codex app-server generate-ts --out <dir> --experimental
```

Check in the generated output (or a trimmed subset) and note the version it came
from, so an upgrade is a visible diff rather than a silent shape change.

Map, with the existing emitted event names preserved so the UI needs no change:

- `thread/started` → bind `sdkSessionId` + `bindSession()`, emit
  `system{subtype:"init"}`.
- `turn/started`, `turn/completed` → `result{subtype:"success", usage}`.
- `turn/failed` → `error`. Keep the existing "stop reading so the SDK kills the
  child" precaution (`src/start-codex.ts:212-218`) if it still applies here;
  verify whether app-server has the same retry-after-failure behaviour.
- `item/started` / `item/updated` / `item/completed` for `commandExecution`,
  `fileChange`, `agentMessage`, `reasoning`, `webSearch`, `plan`, `mcpToolCall`,
  `error` — preserving the current `tool_use` / `tool_result` shapes.
- `error` notification → `agent_error`, **non-fatal**. The existing comment at
  `src/start-codex.ts:305-312` explains why: codex reports retries and transport
  fallbacks here and then carries on. Do not regress this into a turn-killer.
- `serverRequest/resolved` → another client answered an approval; drop our
  pending entry and `notifyPermissionsChanged()` so the card disappears.
- Streaming deltas (`item/agentMessage/delta`,
  `item/commandExecution/outputDelta`, `item/reasoning/summaryTextDelta`) — wire
  at least a `status` event so the UI shows activity; full token streaming is
  optional here but note what was left out.
- `turn/interrupt` for abort, replacing the current `AbortController` path.

`fileChange` was already ported in CDX-1 (`Write` for `kind === "add"`, else
`Edit`) because auto-approving edits while rendering nothing was indefensible.
Note the trap it hit: v2 spells the kind as a tagged object
(`{"type":"add"}`), where the SDK used a bare string — a literal port labels
every new file `Edit`.

## Turn input — no other issue owns this

Image attachments are currently **dropped** on the app-server path, with an
`agent_error` saying so (`src/codex-app-server.ts`). The SDK path downloads them
and sends `local_image`. app-server takes `{type:"localImage", path}` in
`turn/start.input` — verified — so this is a small port of the existing
download/manifest code, which stays as-is. Do it here; CDX-4 is approvals and
CDX-5 is modes, so neither would pick it up.

## Acceptance criteria

Physically compare app-server rendering against the SDK path for the same
prompts. Both must look the same to the user.

1. Shell command: `tool_use` then `tool_result` with output and exit code.
2. File edit: renders as `Edit`; new file as `Write`.
3. Web search renders.
4. Todo/plan list renders.
5. Reasoning shows a thinking status.
6. An MCP tool call renders as `mcp__server__tool`.
7. A retryable transport error surfaces as `agent_error` and the turn still
   completes — it must not end the turn.
8. Abort mid-turn stops the agent, emits `aborted`, leaves no orphan child.
9. Thread resume across turns still works after all the above.

## Review focus (adversarial)

- Missing/optional fields: every generated type has nullable fields. Which ones
  are dereferenced without a guard?
- `item.updated` arriving after `item.completed`; duplicate `item.completed`.
- Does `error` still fail to kill the turn? That regression is easy to
  reintroduce and hard to notice.
- Abort: `turn/interrupt` racing with `turn/completed`.
- Are the emitted event shapes byte-compatible with what `chat.tsx` expects, or
  was a field quietly renamed?
