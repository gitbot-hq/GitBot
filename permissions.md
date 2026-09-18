# Claude Agent SDK v2 — Permission System

## Overview

The SDK fully supports custom permission flows, allowing you to forward permission requests to a frontend (e.g., browser via WebSocket) and await user decisions before Claude proceeds.

## Permission Modes (`PermissionMode`)

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'delegate' | 'dontAsk';
```

| Mode | Behavior |
|---|---|
| `default` | Standard; prompts for dangerous operations |
| `acceptEdits` | Auto-accepts file edits; Bash still requires approval |
| `bypassPermissions` | Bypasses all checks (requires `allowDangerouslySkipPermissions: true`) |
| `plan` | Planning mode; no tool execution |
| `delegate` | Restricts to `Teammate` and `Task` tools only |
| `dontAsk` | Denies anything not pre-approved via `allowedTools`; never prompts |

### v2 Sessions vs Query API

**Important:** `SDKSessionOptions` (v2 `unstable_v2_createSession`) does **not** have `allowDangerouslySkipPermissions`. The v2 session comments only list `default`, `acceptEdits`, `plan`, `dontAsk` as valid modes. `bypassPermissions` and `delegate` may only be fully supported via the `Options`/`query()` API.

**Current `start.ts` uses `bypassPermissions`.** For frontend permission flow, switch to `default` + `canUseTool`.

## Tool Filtering Options

Three options control which tools Claude has access to:

| Option | Effect | Available on |
|---|---|---|
| `tools` | Sets the base tool set. Can be a specific array, empty array (disables all built-ins), or `{ type: 'preset', preset: 'claude_code' }` | `Options` only |
| `allowedTools` | Auto-approves listed tools **without calling `canUseTool`**. In `dontAsk` mode, only these tools are available. | Both `Options` and `SDKSessionOptions` |
| `disallowedTools` | Removes tools entirely from Claude's context (Claude doesn't even know they exist). Different from denying via `canUseTool`. | `Options` only |

The `SDKSystemMessage` (init message) includes a `tools: string[]` array showing exactly which tools Claude has access to after all filtering — useful for verifying your config.

### Subagent Tool Restrictions

`AgentDefinition` has its own tool controls independent of the main session:

```typescript
type AgentDefinition = {
  tools?: string[];           // allowed tools for this agent
  disallowedTools?: string[]; // tools explicitly blocked for this agent
  // ...
};
```

When `canUseTool` fires for a subagent action, `agentID` will be set.

## `canUseTool` Callback — The Core Mechanism

Available on both `Options` (query API) and `SDKSessionOptions` (v2 session API).

### Signature

```typescript
canUseTool: async (
  toolName: string,                    // e.g. "Write", "Bash", "Edit"
  input: Record<string, unknown>,      // tool's input (file path, command, etc.)
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];  // pre-built "always allow" rules
    blockedPath?: string;              // path that triggered the check
    decisionReason?: string;           // why this permission was triggered
    toolUseID: string;                 // unique ID for this tool call
    agentID?: string;                  // sub-agent context
  }
) => Promise<PermissionResult>
```

**Note:** If a tool is listed in `allowedTools`, `canUseTool` is **not called** for it — it's auto-approved.

### Return Type

```typescript
type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;   // optionally rewrite tool input
      updatedPermissions?: PermissionUpdate[];   // persist "always allow" rules
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;       // reason shown to the agent (required)
      interrupt?: boolean;   // true = stop the whole session
      toolUseID?: string;
    };
```

### Wire Protocol (`SDKControlPermissionRequest`)

Under the hood, the SDK sends this control message (which `canUseTool` wraps):

```typescript
type SDKControlPermissionRequest = {
  subtype: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  tool_use_id: string;
  agent_id?: string;
  description?: string;   // extra field not exposed in canUseTool callback
};
```

The `description` field exists on the wire protocol but is not currently surfaced in the `canUseTool` callback options.

## Implementation Pattern (WebSocket Forwarding)

```typescript
const pendingPermissions = new Map<string, (result: PermissionResult) => void>();

// In session/query options:
canUseTool: async (toolName, input, { toolUseID, decisionReason, suggestions, blockedPath, signal }) => {
  // Forward to browser
  ws.send(JSON.stringify({
    type: "permission_request",
    toolUseID, toolName, input, decisionReason, blockedPath, suggestions,
  }));

  // Wait for browser response
  return new Promise((resolve, reject) => {
    pendingPermissions.set(toolUseID, resolve);
    signal.addEventListener('abort', () => {
      pendingPermissions.delete(toolUseID);
      reject(new Error('Aborted'));
    });
  });
}

// In WebSocket message handler:
if (parsed.type === "permission_response") {
  const resolver = pendingPermissions.get(parsed.toolUseID);
  if (resolver) {
    pendingPermissions.delete(parsed.toolUseID);
    resolver(parsed.approved
      ? { behavior: 'allow', updatedPermissions: parsed.alwaysAllow ? parsed.suggestions : undefined }
      : { behavior: 'deny', message: parsed.message ?? 'User denied' }
    );
  }
}
```

### Abort / Cancel Behavior

The `signal` in `canUseTool` is fired when:
- `Options.abortController` is aborted (cancels the entire query)
- `Query.interrupt()` is called (stops the current turn cleanly)
- `Query.close()` is called (forcefully terminates the process)

When the signal fires, your pending promise **must reject** (not resolve). The implementation pattern above handles this correctly.

```typescript
// These are the relevant Query methods:
query.interrupt()           // stops current turn cleanly
query.close()               // forcefully terminates the process
query.stopTask(taskId)      // stops a specific background task
// Plus: Options.abortController for external abort control
```

## `PermissionUpdate` — Persisting Decisions

When allowing a tool, you can return `updatedPermissions` so the user isn't asked again:

```typescript
type PermissionUpdate =
  | { type: 'addRules';       rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules';   rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules';    rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'setMode';        mode: PermissionMode;         destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[];        destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[];     destination: PermissionUpdateDestination };

type PermissionBehavior = 'allow' | 'deny' | 'ask';
type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
```

The `suggestions` passed into `canUseTool` are pre-built `PermissionUpdate[]` values — forward them back if user clicks "always allow."

The `settingSources` option on `Options` controls whether project/user/local permission settings files are loaded at all.

## Hook-Based Alternative

### Registering Hooks

```typescript
hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

interface HookCallbackMatcher {
  matcher?: string;       // pattern to match tool names
  hooks: HookCallback[];
  timeout?: number;       // per-matcher timeout in seconds
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### Hook Return Value (`SyncHookJSONOutput`)

All hooks return this shape:

```typescript
type SyncHookJSONOutput = {
  continue?: boolean;          // false = stop the session
  suppressOutput?: boolean;    // hide hook output
  stopReason?: string;
  decision?: 'approve' | 'block';  // general approve/block gate
  systemMessage?: string;      // inject a system-level message
  reason?: string;             // reason for the decision
  hookSpecificOutput?: PreToolUseHookSpecificOutput | PermissionRequestHookSpecificOutput | ...;
};
```

### `PermissionRequest` Hook

Input:
```typescript
type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];
};
```

Output:
```typescript
type PermissionRequestHookSpecificOutput = {
  hookEventName: 'PermissionRequest';
  decision: {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: PermissionUpdate[];
  } | {
    behavior: 'deny';
    message?: string;       // NOTE: optional here (required in canUseTool's PermissionResult)
    interrupt?: boolean;
  };
};
```

### `PreToolUse` Hook

Can also gate tool execution. Full output type:

```typescript
type PreToolUseHookSpecificOutput = {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;        // reason for the decision
  updatedInput?: Record<string, unknown>;   // hooks can rewrite tool input
  additionalContext?: string;               // inject context into Claude's response
};
```

### `PostToolUse` Hook

Can modify MCP tool output before Claude sees it:

```typescript
type PostToolUseHookSpecificOutput = {
  hookEventName: 'PostToolUse';
  additionalContext?: string;
  updatedMCPToolOutput?: unknown;   // rewrite MCP tool output
};
```

### `PostToolUseFailure` Hook

The `is_interrupt` field signals the failure was caused by a permission deny with `interrupt: true`:

```typescript
type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
  is_interrupt?: boolean;   // true = failed due to permission interrupt
};
```

### All Hook Events

```typescript
const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification",
  "UserPromptSubmit", "SessionStart", "SessionEnd", "Stop",
  "SubagentStart", "SubagentStop", "PreCompact", "PermissionRequest",
  "Setup", "TeammateIdle", "TaskCompleted"
];
```

Permission-relevant beyond `PermissionRequest` and `PreToolUse`:
- **`Stop`** — `StopHookInput` has `stop_hook_active: boolean`. Setting `continue: false` can cancel forced shutdowns.
- **`SessionEnd`** — carries `reason: ExitReason` which includes `'bypass_permissions_disabled'`.
- **`SubagentStop`** — has `agent_transcript_path`, useful for auditing subagent actions.

## Other Useful APIs

- **`permissionPromptToolName`** — routes permission requests through a named MCP tool instead of default handler (on `Options` only)
- **`setPermissionMode(mode)`** — change permission mode mid-session dynamically (on `Query`)
- **`SDKStatusMessage`** — streaming output includes current `permissionMode`
- **`SDKSystemMessage` (init)** — includes `tools: string[]` showing all active tools after filtering, plus `permissionMode`
- **`SDKPermissionDenial`** — result messages include a list of all denied operations:
  ```typescript
  type SDKPermissionDenial = {
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  };
  // present on SDKResultSuccess and SDKResultError:
  permission_denials: SDKPermissionDenial[];
  ```
- **`SDKResultError` subtypes** — includes `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`. The `errors: string[]` field may contain permission-related messages.
- **`ExitReason`** — includes `'bypass_permissions_disabled'` as a session exit reason:
  ```typescript
  type ExitReason = 'clear' | 'logout' | 'prompt_input_exit' | 'other' | 'bypass_permissions_disabled';
  ```
- **`ControlErrorResponse.pending_permission_requests`** — when a control request fails, the SDK can return pending permission requests that were blocked:
  ```typescript
  type ControlErrorResponse = {
    subtype: 'error';
    request_id: string;
    error: string;
    pending_permission_requests?: SDKControlRequest[];
  };
  ```

## Source

All types from: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
