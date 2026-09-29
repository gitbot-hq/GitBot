# CDX-5 — Permission modes → policy/sandbox/reviewer, and mid-turn switching

**Depends on:** CDX-1, CDX-4. **Status:** not started.

Approvals now work. This makes the three modes mean the same thing on codex as
they do on claude-code, and makes changing mode mid-turn actually do something.

## Build

Replace `permissionToCodex()` (`src/start-codex.ts:97`), which returns a sandbox
and nothing else, with a mapping to the full triple **plus client-side
auto-answering**, exactly as the claude-code harness pairs `canUseTool` with
`shouldAutoApprove()`.

| session mode | `sandbox` | `approvalPolicy` | `approvalsReviewer` | client auto-answer |
| --- | --- | --- | --- | --- |
| `ask-permissions` | `read-only` | `untrusted` | `user` | none — surface everything |
| `allow-all-edits` | `workspace-write` | `untrusted` | `user` | auto-accept `fileChange` when `grantRoot == null`; surface all `commandExecution` |
| `yolo` | `danger-full-access` | `on-request` | `user` | auto-accept everything |
| `plan` | `read-only` | `untrusted` | `user` | auto-decline `fileChange`; surface `commandExecution` |

### Why not `on-request` — this was measured, do not revert it

`on-request` is **not** a per-tool gate. Under it, whether the user is asked at
all is the *model's* discretion: it prompts only when the model itself elects to
escalate, passing `sandbox_permissions: "require_escalated"` and a `justification`
(that string is what shows up as the request's `reason`). Live on 0.155.1,
`read-only` + `on-request`: `echo hello` ran with **zero** approval requests;
only `echo hello > out.txt` raised one.

`untrusted` is the harness deciding rather than the model. Upstream
`codex-rs/core/src/exec_policy.rs:770-855`:

> `AskForApproval::UnlessTrusted` => // Projects marked untrusted require approval
> for every command that is not explicitly allowed by an exec policy rule.
> `Decision::Prompt`

and `safety.rs:79-86` returns `SafetyCheck::AskUser` for every patch,
unconditionally. Verified: `read-only` + `untrusted` prompts for `echo`, `ls`
and `cat`; repeats prompt every time (accept is not sticky); and it is
sandbox-independent — it still prompts under `danger-full-access`.

### The landmine

`untrusted` is rejected when it arrives via **config** — `config.toml` or a `-c`
flag — and the app-server then never even answers `initialize`:

```
$ codex app-server -c approval_policy="untrusted"
Error: approval_policy = "untrusted" is no longer supported; remove this setting
(server never responds to initialize)
```

It is accepted and fully supported as a **`thread/start` / `thread/resume` /
`turn/start` / `thread/settings/update` param**. Only `cfg.approval_policy` is
checked (`config/mod.rs:3718`); `approval_policy_override`, which is where the
params land, is not. This is the whole of the "retired" warning in the upstream
docs. Keep it in params, never in config, and leave a comment saying why.

Risk of depending on it: low. It is not `#[experimental]` (unlike `granular`),
it is the live internal default for untrusted projects (`config/mod.rs:3730`),
and it has a maintained model-facing prompt template
(`prompts/templates/permissions/approval_policy/unless_trusted.md`). If a future
binary rejects it at `thread/start`, degrade to `on-request` + `read-only` and
stop advertising per-tool approval — detect this in CDX-2's probe.

### Why `yolo` is `on-request` + auto-accept, not `never`

`never` is **strictly less capable**. Dangerous commands become
`Decision::Forbidden` with no approval path (`exec_policy.rs:797-803`). Live,
`danger-full-access` + `never`:

```
exec_command failed: Rejected("`rm -rf junk` rejected: rm -f style commands are
not permitted. Use a safer approach")   -- 0 server requests, junk/ survived
```

The identical command under `on-request` + `danger-full-access` prompts, accepts
and succeeds. So a "yolo" session on `never` would refuse destructive work that
`allow-all-edits` performs happily.

**Trade-off to state explicitly in review:** this means yolo *does* raise
approval requests which we auto-resolve, rather than never raising any. The
audit trail differs. If an untampered "nothing was ever requested" record
matters more than being able to `rm -rf`, use `never` and document the
destructive-command block instead.

### Rejected alternatives

- **`granular`** is a *suppressor*, not an amplifier. Per
  `protocol.rs:998-1026`, `true` lets a category through and `false`
  auto-rejects it without showing the user; `granular{all:true}` ≈ `on-request`.
  No combination prompts more than `on-request`. It is also `#[experimental]`
  and capability-gated (`-32600 askForApproval.granular requires experimentalApi`).
  Nothing to gain.
- **execpolicy `prompt` rules** do force prompts under `on-request`, but rules
  are keyed on the command's first token with no wildcard and no catch-all
  (`execpolicy/src/rule.rs:36-38`), so deny-by-default is not expressible.
  Project rules are also disabled until the project is trusted in the user's
  global config, and user-layer rules would mean hijacking `CODEX_HOME` — which
  would move the rollout files out from under `listSessions`/`loadTranscript`.
- **`on-failure`** is gone from the v2 enum and silently aliased to `on-request`
  (`#[serde(alias = "on-failure")]`). Reject it at the GitBot config boundary so
  a stale `bots.json` value cannot quietly become something else.

### `acceptWithExecpolicyAmendment` — do not make this a button

`execpolicy/src/amend.rs:65-81` appends
`prefix_rule(pattern=…, decision="allow")` to `~/.codex/rules/default.rules`.
Clicking it permanently and globally silences that command prefix for every
future Codex session — including the user's own terminal, outside GitBot.
Suppress it in `ask-permissions`, or gate it behind explicit "remember forever,
system-wide" copy.

Consequential cleanups:

- Delete the codex special-case in `botPermissionToSession()`
  (`src/server-common.ts:201`) that rewrites `ask-permissions` to
  `allow-all-edits`. Codex can ask now.
- Mid-turn switching is **next-turn only**. `thread/settings/update` and a
  per-turn `turn/start.approvalPolicy` both work and the server echoes
  `thread/settings/updated` with the full effective settings — that echo is what
  `getSessionConfig` should report (AC 6). Verified across three turns on one
  thread: `on-request` → 0 approvals, switch to `untrusted` → 1, then
  `turn/start{approvalPolicy:"never"}` → 0. There is **no** mechanism to change
  policy for a turn already in flight, and upstream logs
  `"thread/resume overrides ignored for loaded thread"`. Say that plainly rather
  than implying it works.
- Populate `TOOL_BLACKLIST["codex"]` (`src/server-common.ts:183`) if any codex
  tool deserves the same always-prompt treatment as `ExitPlanMode` /
  `AskUserQuestion`. Justify either way.

Mid-turn switching — `PATCH /sessions/:id` (`src/server.ts:420`) has claude-code
and opencode branches; add codex:

- Auto-resolve pending approvals the new mode covers, via
  `shouldAutoApprove()`, exactly as the other two branches do.
- `turn/start` accepts `approvalPolicy` per turn, and `thread/start` /
  `thread/resume` accept it too — so a mode change can apply to the **next turn**
  without restarting the thread. Confirm whether it can also be changed for the
  turn already in flight; if not, say so plainly rather than implying it works.
- The UI note at `chat.tsx:1710` ("Switch mode, then approving automatically
  resolves matching requests") must become true for codex, or the codex copy
  must differ.

## Acceptance criteria

1. `ask-permissions` on codex now prompts per command, in a read-only sandbox —
   it no longer silently becomes `allow-all-edits`. This is the headline fix.
2. `allow-all-edits` runs edits without asking; a shell command still asks.
3. `yolo` asks nothing and can write outside the workspace.
4. Plan mode stays read-only and cannot edit.
5. Switching `ask-permissions` → `yolo` with a card on screen resolves that
   pending card immediately, same as claude-code.
6. The mode a turn is running under is reported correctly by
   `getSessionConfig`, so a rejoining browser tab shows the truth
   (`chat.tsx:728-746`).
7. A bot configured `ask-permissions` gets real prompts on codex.

## Review focus (adversarial)

- Is `untrusted` or `on-failure` reachable by any path, including bot config or
  a stale persisted value?
- `yolo` + `danger-full-access`: confirm it genuinely never prompts, rather than
  prompting and auto-accepting — those differ in the audit trail.
- Mode change racing with an in-flight approval: can a card be resolved twice,
  or resolved with a decision from the old mode?
- Does deleting the `botPermissionToSession` special-case break bots already
  stored in `bots.json` with codex + `ask-permissions`? They will change
  behaviour — is that the intended fix, and is it safe?
- Plan mode must not be escapable by switching mode mid-turn.
