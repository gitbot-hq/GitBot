# Codex permissions — parity with Claude Code

Local issue tracker for bringing real permissions to the Codex agent.
Benchmark is the claude-code harness (`src/start-claude-code.ts`).

## The problem

Codex is the only agent of the three that cannot ask the user for anything. A
permission mode picks a sandbox and nothing else:

| mode | claude-code / opencode | codex today |
| --- | --- | --- |
| `ask-permissions` | prompts per tool | `read-only` sandbox, never prompts |
| `allow-all-edits` | prompts for non-edit tools | `workspace-write`, never prompts |
| `yolo` | runs everything | `danger-full-access` |

Consequences, all live on `main`:

- `botPermissionToSession()` (`src/server-common.ts:201`) rewrites codex's
  `ask-permissions` to `allow-all-edits`, because asking is impossible.
- `PATCH /sessions/:id` cannot resolve pending codex permissions
  (`src/server.ts:420`) — there are never any.
- Bot `allowedTools` / `disallowedTools` are silently unenforced; the adapter
  emits a warning admitting it (`src/start-codex.ts:132`).
- The UI carries a separate `codexPermissionCopy` table renaming the modes to
  sandbox names (`ui/app/components/chat.tsx:259`) so the menu stops promising
  a prompt that never arrives.

## Why it is the way it is

`@openai/codex-sdk` **cannot** do approvals. Three independent blockers, all
verified against the installed 0.155.1:

1. **No transport.** The SDK spawns `codex exec --experimental-json` and calls
   `child.stdin.write(input); child.stdin.end()`
   (`node_modules/@openai/codex-sdk/dist/index.js:273-274`) — stdin is EOF'd
   before the first event is read, and never written to again.
2. **No message type.** `ThreadEvent` is a closed 8-member union
   (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
   `item.started`, `item.updated`, `item.completed`, `error`). No approval
   variant exists, so there is nothing to receive.
3. **No policy.** Upstream `codex-rs/exec/src/lib.rs` hard-forces
   `approval_policy: Some(AskForApproval::Never)` and answers every approval
   request with JSON-RPC error `-32000`
   (`"command execution approval is not supported in exec mode"`).

So `approvalPolicy` in `ThreadOptions` is not merely inert — passing it can
convert a would-be prompt into a hard failure. Confirmed empirically: every
`-c approval_policy=…` value still prints `approval: never`, and `untrusted` is
rejected outright by 0.155.1.

`codex mcp-server` is also ruled out: deleted upstream in
[PR #42993](https://github.com/openai/codex/pull/42993) and already absent from
the bundled 0.155.1.

## The decision

**Replace the SDK call path with a thin JSON-RPC client over `codex app-server`.**

This is the transport OpenAI's own IDE extension and desktop app use, and it is
what the *Python* Codex SDK is built on (`sdk/python/src/openai_codex/client.py`
exposes an `ApprovalHandler` — the capability gap between the two official SDKs
is purely the transport).

Verified live against the bundled 0.155.1 binary — a real captured
server→client request:

```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{
  "threadId":"01a0e7ba-bd32-75c3-8a12-6ec85ef5c28e",
  "turnId":"01a0e7ba-bd79-74c3-9b38-6323a85383a6",
  "itemId":"call_4eW7vif74GAMQTWA2BQemeyP",
  "command":"/bin/zsh -lc 'echo hello'","cwd":"/tmp/codexscratch",
  "availableDecisions":["accept",
    {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo","hello"]}},
    "cancel"]}}
```

Answering `{"decision":"accept"}` runs the command; `{"decision":"decline"}`
yields `status:"declined"` and the agent reports the rejection. Every capability
the current adapter depends on was re-verified on this transport: `thread/resume`
by id, streamed items, `localImage` input, `cwd`, `developerInstructions`,
`turn/interrupt`.

Three decisive details:

- Set **`approvalsReviewer: "user"`**. The default routes approvals to an LLM
  subagent (`auto_review`), not to a human.
- Use **`approvalPolicy: "untrusted"`**, and only ever as a *param* on
  `thread/start` / `thread/resume` / `turn/start` / `thread/settings/update`.
  `on-request` is not a per-tool gate — under it, whether the user is asked at
  all is the model's discretion (`echo hello` runs unprompted; only a
  model-initiated escalation asks). `untrusted` is the harness deciding: always
  ask, for every command and every file edit, independent of sandbox.
  **The landmine:** the same value passed via `config.toml` or `-c` makes the
  server refuse to start — it never answers `initialize`. Only the config path
  was retired upstream, not the policy. Full evidence and the mode table are in
  [CDX-5](CDX-5-permission-modes.md).
- The server supplies **`availableDecisions`** per request. Render buttons from
  it — but **suppress `acceptWithExecpolicyAmendment`**: accepting it appends a
  permanent `allow` rule to the user's `~/.codex/rules/default.rules`, silencing
  that command prefix globally, including in their own terminal outside GitBot.

Both existing web UIs over this protocol get this wrong, which is worth knowing:
`cattails-lgao/codex-mobile` labels `on-request` + read-only as "editing files or
running commands requires approval" (it does not — harmless reads run silently),
and `friuns2/codexui` defaults to `danger-full-access` + `never` with no approval
UI at all, and offers `untrusted` through `-c`, the one path that kills the
server. Neither is a model to follow.

### What does not change

`listSessions`, `loadTranscript`, `readSessionMetaAndPreview` and the whole
attachment/manifest layer read `~/.codex/sessions/**/rollout-*.jsonl` directly.
app-server writes identical rollouts, so they carry over untouched.

### Binary sourcing

Keep `@openai/codex-sdk` in `package.json` purely to pin and ship the matching
binary, but stop calling its API. Re-implement its private `findCodexPath()`
resolution, including prepending the bundled `rg` to `PATH`. Fall back to the
`codex` on `PATH` when the optional dep is missing, as `createCodex()`
(`src/start-codex.ts:73`) already does today.

### Risk

`app-server` is labelled `[experimental]`. Mitigations: pin the CLI version via
the dep, generate types with `codex app-server generate-ts --experimental`
rather than hand-writing them, and probe capabilities at init so an unexpected
binary degrades to today's sandbox-only behaviour instead of hanging (CDX-2).

## Issues

| # | Issue | Status |
| --- | --- | --- |
| [CDX-1](CDX-1-app-server-tracer-bullet.md) | app-server client + command approval, behind a flag | **done** |
| [CDX-4](CDX-4-file-change-and-remaining-approvals.md) | File-change approvals + remaining ServerRequest kinds | **done** |
| [CDX-3](CDX-3-event-mapping-parity.md) | Full event/item mapping parity, plus image input | **done** |
| [CDX-5](CDX-5-permission-modes.md) | Permission modes → policy/sandbox | **done**, trimmed |
| [CDX-2](CDX-2-binary-resolution-and-probe.md) | Binary resolution, capability probe | descoped |
| [CDX-6](CDX-6-tool-fencing.md) | Enforce bot allowedTools / disallowedTools | descoped |
| [CDX-7](CDX-7-cutover.md) | Delete the SDK path, drop the flag | descoped |
| [CDX-8](CDX-8-approval-card-ui.md) | Approval card: expiry, legibility, honest verdicts | descoped |

## Where this stopped, and why

The goal was cut to "permissions work, nothing more". What shipped is the four
issues above, behind `GITBOT_CODEX_APP_SERVER=1`: codex asks before every command
and every file change, a bot set to `ask-permissions` actually gets asked, and
the mode copy describes what the code does.

CDX-5 landed trimmed — the sandbox/policy mapping and the honest copy, but not
`thread/settings/update` mid-turn switching or `TOOL_BLACKLIST["codex"]`.
Switching mode mid-turn already resolves pending cards via `PATCH /sessions/:id`
(CDX-1) and the auto-approve check re-runs per request, so the missing piece
would only change the policy codex is *started* with, which is next-turn anyway.

The four descoped issues are real, but none of them is permissions:

- **CDX-2** — the bundled 0.155.1 works and CDX-1 already falls back to the
  `codex` on `PATH`. Worth doing if that fallback is ever exercised in anger:
  measured, **0.135.0 + `untrusted` does not gate commands** — it gated file
  changes but ran `echo` unprompted. A user driven onto an old binary would
  silently get weaker approvals than the UI promises. That is the argument for
  the capability probe.
- **CDX-6** — tool fencing is a separate feature; the "not enforced on Codex"
  warning stays accurate.
- **CDX-7** — the flag can stay off by default. Nothing requires deleting the SDK
  path in order to use the new one.
- **CDX-8** — its defects are in the **shared** card component, so claude-code and
  opencode have them too; codex only made them visible by raising far more
  approvals than anything did before. The sharpest two: aborting leaves a dead
  card with live-looking buttons that silently do nothing, and a long command is
  clipped mid-string so the part that matters scrolls off screen.

Known gaps in what did ship, each recorded in its issue file: `acceptForSession`
is deliberately unwired (measured inert on 0.155.1 — it asks again on the next
edit, the next turn and the next thread); `item/fileChange/patchUpdated` is
handled but was never provoked from real codex; and
`item/permissions/requestApproval`'s response shape is verified against the
generated types and a stub, never a live server.

## Ground rules for every issue

- Work on a branch. Do not merge or push to a shared branch.
- Every issue gets an **adversarial code review** by a separate agent before it
  is considered done.
- Every issue gets **physically tested** — a real codex turn through the running
  hub, not just a type-check. `npm run build:cli` passing is necessary, not
  sufficient.
- Never let a turn hang: every `ServerRequest` the server sends **must** be
  answered, including ones we do not understand. An unanswered request blocks
  the turn forever.
