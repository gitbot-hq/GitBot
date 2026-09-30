# Codex permissions

Why the Codex adapter talks JSON-RPC to `codex app-server` instead of using the
official SDK, and why its permission modes map the way they do.

Everything here was measured against **codex-cli 0.155.1** — the binary bundled
with the pinned `@openai/codex-sdk` — in September 2026. `app-server` is labelled
`[experimental]`, so re-measure before trusting any of it on a newer binary.

## Why not `@openai/codex-sdk`

The SDK cannot ask the user anything, and it is not a missing feature — three
independent blockers:

1. **No transport.** It spawns `codex exec --experimental-json` and calls
   `child.stdin.write(input); child.stdin.end()`, closing the only back-channel
   before the first event is read.
2. **No message type.** `ThreadEvent` is a closed eight-member union with no
   approval variant.
3. **No policy.** Upstream `codex-rs/exec/src/lib.rs` forces
   `approval_policy: Some(AskForApproval::Never)` and answers every approval
   request with JSON-RPC error `-32000`
   (`"command execution approval is not supported in exec mode"`).

So `approvalPolicy` in `ThreadOptions` is worse than inert: passing it can turn a
would-be prompt into a hard failure.

`codex mcp-server` is also ruled out — deleted upstream in
[PR #42993](https://github.com/openai/codex/pull/42993), already absent from
0.155.1, and it never advertised elicitation anyway.

`codex app-server` is the transport OpenAI's own IDE extension uses, and the one
the *Python* Codex SDK is built on (`sdk/python/src/openai_codex/client.py`
exposes an `ApprovalHandler`). The capability gap between the two official SDKs
is purely the transport.

`@openai/codex-sdk` stays in `package.json` to pin and ship the matching binary.
Its API is no longer called.

### What carries over untouched

`listSessions`, `loadTranscript` and the attachment/manifest layer read
`~/.codex/sessions/**/rollout-*.jsonl` directly. app-server writes identical
rollouts.

## Mode mapping

| mode | `sandbox` | `approvalPolicy` | client auto-answer |
| --- | --- | --- | --- |
| `ask-permissions` | `read-only` | `untrusted` | none — surface everything |
| `allow-all-edits` | `workspace-write` | `untrusted` | non-destructive `fileChange` with `grantRoot == null` |
| `yolo` | `danger-full-access` | `never` | n/a — nothing is ever raised |
| `plan` | `read-only` | `untrusted` | auto-decline `fileChange` |

`sandboxFor()` is the single source of truth: `approvalPolicyFor()` and
`codexAutoApprove()` both derive from it rather than reading `permissionMode`.
That is deliberate — `botPermissionToSession("plan")` hands plan mode
`permissionMode: "yolo"`, so the mode alone is not the truth about what a session
may do, and under `untrusted` an approval request is exactly where codex asks to
*leave* its sandbox.

### `untrusted`, not `on-request`

`on-request` is not a per-tool gate. Under it the **model** decides whether to
ask at all: it prompts only when it elects to escalate, passing
`sandbox_permissions: "require_escalated"` and a `justification` (that string is
what surfaces as the request's `reason`). Measured, `read-only` + `on-request`:
`echo hello` ran with **zero** approval requests; only `echo hello > out.txt`
raised one.

`untrusted` is the harness deciding. Upstream `core/src/exec_policy.rs:770-855`
returns `Decision::Prompt` for every command not allowed by an exec policy rule,
and `safety.rs:79-86` returns `SafetyCheck::AskUser` for every patch,
unconditionally. Measured: prompts for `echo`, `ls` and `cat`, prompts again on a
repeat (accept is not sticky), and prompts even under `danger-full-access`.

Both existing web UIs over this protocol get this wrong.
`cattails-lgao/codex-mobile` labels `on-request` + read-only as "editing files or
running commands requires approval", which is false. `friuns2/codexui` defaults
to `danger-full-access` + `never` with no approval UI at all.

### The landmine: params only, never config

`untrusted` is rejected when it arrives as configuration, and the server then
never answers `initialize` — the turn hangs on the handshake:

```
$ codex app-server -c approval_policy="untrusted"
Error: approval_policy = "untrusted" is no longer supported; remove this setting
```

Only `cfg.approval_policy` is checked (`config/mod.rs:3718`).
`approval_policy_override`, where `thread/start` / `thread/resume` /
`turn/start` / `thread/settings/update` params land, is not. That distinction is
the whole of the "retired" warning in the upstream docs.

Risk of depending on it is low: it is not `#[experimental]`, it remains the
internal default for untrusted projects (`config/mod.rs:3730`), and it has a
maintained model-facing prompt template. If a future binary rejects it at
`thread/start`, degrade to `on-request` + `read-only` and stop advertising
per-tool approval.

### `yolo` is `never`, and that makes it less permissive

`never` raises no approval request at all, so the mode means what it says:
nothing was asked and nothing was auto-answered on the user's behalf.

The cost is deliberate. `never` also makes dangerous commands
`Decision::Forbidden` with **no approval path** (`exec_policy.rs:797-803`).
Measured, `danger-full-access` + `never`:

```
Rejected("`rm -rf junk` rejected: rm -f style commands are not permitted.
Use a safer approach")      -- 0 server requests, junk/ survived
```

The same command under `on-request` + `danger-full-access` prompts, is accepted,
and succeeds. So yolo is **not** strictly more permissive than
`allow-all-edits` — a destructive command the user could approve in
`allow-all-edits` is refused outright in yolo. Surprising enough that the mode's
copy says so.

Do not switch this to `on-request` + blanket auto-accept to make `rm -rf` work.
Keeping codex's own guardrail is the point: yolo is the one mode with no human in
the loop. If it needs revisiting it is a product decision, not a bug.

### `allow-all-edits` does not cover deletions

codex spells a deletion as an ordinary `fileChange` — measured payload
`{"path":"…/doomed.txt","kind":{"type":"delete"},"diff":"doomed\n"}`. A two-name
`Write`/`Edit` split therefore rendered `rm` as
`{old_string:"doomed\n", new_string:""}` under the headline "Allow Edit?", which
reads as blanking a file, and because `"Edit"` is in `EDIT_TOOLS` the default bot
mode deleted workspace files with no card at all.

Four names now, two outside `EDIT_TOOLS`:

| the item's changes | card name | auto-approved by `allow-all-edits`? |
| --- | --- | --- |
| all `add` | `Write` | yes |
| no `delete` | `Edit` | yes |
| all `delete` | `Delete` | **no** |
| some `delete` | `Edit and delete` | **no** |
| unrecognised `kind`, or no changes | `a file change GitBot cannot show you` | **never, in any mode** |

`Edit and delete` is separate because one `apply_patch` is one item with N
changes and a rename is a delete plus an add — folding mixed items into `Edit`
puts every deletion travelling with an edit back on the silent path.
`destructiveChangeTool()` throws at import if one of these names ever enters
`EDIT_TOOLS`.

## Rejected alternatives

Dead ends, so nobody re-derives them:

- **`granular`** is a suppressor, not an amplifier. Per
  `protocol.rs:998-1026`, `true` lets a category through and `false`
  auto-rejects it *without showing the user*; `granular{all:true}` ≈
  `on-request`. No combination prompts more than `on-request`. It is also
  `#[experimental]` and capability-gated
  (`-32600 askForApproval.granular requires experimentalApi`).
- **execpolicy `prompt` rules** do force prompts under `on-request`, but rules
  are keyed on the command's first token with no wildcard and no catch-all
  (`execpolicy/src/rule.rs:36-38`), so deny-by-default is not expressible.
  Project rules are disabled until the project is trusted in the user's global
  config, and user-layer rules would mean hijacking `CODEX_HOME`, moving the
  rollout files out from under `listSessions`/`loadTranscript`.
- **`on-failure`** is gone from the v2 enum and silently aliased to
  `on-request` (`#[serde(alias = "on-failure")]`).
- **`acceptForSession`** is inert on 0.155.1. Measured: it asks again on the next
  edit in the same turn, on the next turn, and on the next thread. It backs the
  UI's "Allow all" button on paper; wiring it would promise "don't ask again" and
  deliver nothing. "Allow all" works by changing mode instead.

## Traps in the protocol

- **`acceptWithExecpolicyAmendment` must never be a button.** Accepting it
  appends `prefix_rule(pattern=…, decision="allow")` to the user's
  `~/.codex/rules/default.rules`, permanently silencing that command prefix in
  every future Codex session — including their own terminal, outside GitBot.
  Filtered out of `availableDecisions` by an allow-list, not a deny-list.
- **`decline`, not `cancel`, is the denial.** `cancel` is an interrupt: the turn
  ends `interrupted` with no closing message. `decline` ends it `completed` with
  the agent explaining it was rejected. `decline` is accepted even when
  `availableDecisions` omits it — that field is a button hint, not a whitelist.
- **Every `ServerRequest` must be answered**, including unknown methods,
  malformed params, and ones arriving after abort. An unanswered request blocks
  the turn forever.
- **A malformed approval response fails closed.** Measured: the server logs
  `failed to deserialize …: unknown variant`, the item goes `status:"declined"`,
  and `turn/completed` still arrives. Wrong shapes are noisy, not fatal.
- **v1 `ReviewDecision` changed spelling** between binaries —
  0.135.0 has bare `"denied"`, 0.155.1 has `{denied:{rejection}}`. The client
  keeps `InitializeResponse.userAgent` and picks from the server's own version.
- **Shapes differ from the SDK's.** A patch kind is a tagged object
  (`{"type":"add"}`) where the SDK used a bare string; `configWarning` and
  `deprecationNotice` are `{summary, details}` where the obvious read is
  `{message}`. Reading the SDK's shape silently drops data.
- **`grantRoot` on a file-change approval is not an edit** — it asks for write
  access under a root for the rest of the session. Never auto-approved.
  Upstream marks it `[UNSTABLE]`, "unclear if this is honored today".
- **`approvalsReviewer` must be `"user"`** on every `thread/start` and
  `thread/resume`. The default routes approvals to an LLM subagent.
- **Three things do not exist in v2**, and assuming they do is a silent bug:
  there is no `item/updated` notification, no `error` *item* (only the
  notification), and `plan` is a markdown document rather than a todo list — the
  todo analogue is the separate `turn/plan/updated` notification.

## Generating the types

`src/codex-app-server-protocol.ts` is generated, not hand-written:

```
node_modules/@openai/codex-darwin-arm64/vendor/<triple>/bin/codex \
  app-server generate-ts --out <dir> --experimental
```

Only the transitive closure of what we reference is checked in — the generator
emits ~700 files of app, plugin and realtime surface GitBot never speaks. The
file header records the exact command and CLI version, so a dependency bump is a
visible diff rather than a silent shape change.

`generate-json-schema` sometimes carries richer descriptions.

## Known gaps

Tracked as issues on the repo:

- Codex approvals are weaker on the PATH-fallback binary — measured, **0.135.0 +
  `untrusted` does not gate commands** (it gated file changes but ran `echo`
  unprompted), so a user driven off the bundled binary silently gets less than
  the UI promises.
- Bot `allowedTools` / `disallowedTools` are still unenforced on Codex.
- The app-server path is the default; `GITBOT_CODEX_APP_SERVER=0` opts back
  into the SDK path, on which `ask-permissions` is a read-only sandbox that
  never prompts.
- Approval-card defects in the **shared** component, so claude-code and opencode
  are affected too: an aborted turn leaves a dead card with working-looking
  buttons, and a long command is clipped so the part that matters scrolls off.

Unverified in what shipped: `item/fileChange/patchUpdated` is handled but was
never provoked from real codex, and `item/permissions/requestApproval`'s response
shape is checked against the generated types and a stub, never a live server.
