# Build Notes: `gitbot start` — WebSocket + Claude Agent SDK

## What was built

A `gitbot start` command that launches a WebSocket server bridging clients to a Claude agent via the Claude Agent SDK v2 preview.

## Architecture

```
Client (WS) <---> gitbot start (WS Server :3000) <---> Claude Agent SDK (session)
```

- One Claude session per WS connection (multi-turn, persistent)
- Streaming responses forwarded as JSON messages
- Graceful shutdown on SIGINT/SIGTERM

## Files changed

- **`src/start.ts`** (new) — WS server + SDK session management
- **`src/index.ts`** (modified) — registered `gitbot start` command with commander

## Dependencies added

- `ws` / `@types/ws` — WebSocket server
- `@anthropic-ai/claude-agent-sdk` — Claude Agent SDK (v0.2.42, ESM package, works with CommonJS require)

## Claude Agent SDK v2 API (key details)

The SDK exports three top-level functions with `unstable_v2_` prefix:

- `unstable_v2_createSession(options)` — creates a persistent session (sync, returns `SDKSession`)
- `unstable_v2_resumeSession(sessionId, options)` — resumes by session ID
- `unstable_v2_prompt(message, options)` — one-shot convenience (returns `Promise<SDKResultMessage>`)

### SDKSession interface

```typescript
interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
```

Usage pattern: `await session.send(msg)` then `for await (const msg of session.stream()) { ... }`

### SDKSessionOptions (subset of relevant fields)

```typescript
{
  model: string;                    // required — e.g. "claude-sonnet-4-5-20250929"
  permissionMode?: PermissionMode;  // 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;          // custom permission handler
  env?: Record<string, string | undefined>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}
```

Note: `cwd` is NOT in v2 options (it's a v1-only field). The session uses the cwd of the process.

### SDKMessage types

- `system` (subtype: `init`, `compact_boundary`, `status`, `task_notification`, `files_persisted`)
- `assistant` — completed assistant turn, text in `msg.message.content` (array of content blocks)
- `stream_event` — partial streaming chunks
- `result` (subtype: `success` | `error_*`) — final result with cost, duration, num_turns
- `user` — user messages
- `tool_progress`, `tool_use_summary`, `auth_status`, hook lifecycle messages

## WS Protocol

**Client -> Server:**
```json
{ "type": "message", "content": "your prompt here" }
```

**Server -> Client (streamed):**
```json
{ "type": "system", "subtype": "init", "data": { ... } }
{ "type": "assistant", "content": "response text" }
{ "type": "result", "subtype": "success", "result": "...", "cost": 0.01, "duration_ms": 1234, "num_turns": 1 }
```

## Project structure

```
cli/
  src/
    index.ts    — CLI entrypoint (commander: start)
    start.ts    — WS server + Claude Agent SDK
  dist/         — compiled output (commonjs)
  package.json  — type: "commonjs", bin: gitbot -> dist/index.js
  tsconfig.json — target ES2020, module commonjs, strict
```
