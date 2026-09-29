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
| `allow-all-edits` | `workspace-write` | `untrusted` | `user` | auto-accept a **non-destructive** `fileChange` when `grantRoot == null`; surface deletions, unreadable changes and all `commandExecution` |
| `yolo` | `danger-full-access` | `never` | — | n/a — nothing is ever raised |
| `plan` | `read-only` | `untrusted` | `user` | auto-decline `fileChange`; surface `commandExecution` |

### `allow-all-edits` does **not** cover deletions — deliberate

The client-side auto-answer is `shouldAutoApprove()`, which under
`allow-all-edits` means "the card's `toolName` is in `EDIT_TOOLS`"
(`server-common.ts:181` — `Edit`, `Write`, `NotebookEdit`). CDX-4 gives a
file-change card one of four names, and two of them are deliberately outside
that set:

| the item's changes | card name | in `EDIT_TOOLS`? | `allow-all-edits` |
| --- | --- | --- | --- |
| all `add` | `Write` | yes | auto-accepted |
| no `delete` | `Edit` | yes | auto-accepted |
| all `delete` | `Delete` | **no** | **asks** |
| some `delete`, some not | `Edit and delete` | **no** | **asks** |
| any unrecognised `kind`, or no changes at all | `a file change GitBot cannot show you` | **no** | **never auto-accepted, in any mode** |

`codex` spells a deletion as an ordinary `fileChange` — measured payload
`{"path":"…/doomed.txt","kind":{"type":"delete"},"diff":"doomed\n"}` — so before
this split, `allow-all-edits` (which `botPermissionToSession` hands **every**
codex bot) deleted workspace files with no card at all, and the card it would
have shown read `{old_string:"doomed\n", new_string:""}` under the headline
"Allow Edit?", which looks like blanking a file, not removing it.

`Edit and delete` is a separate name for the same reason: one `apply_patch` is
one item with N changes, and a rename is a delete plus an add. Folding mixed
items into `Edit` would put every deletion that travels with an edit straight
back on the silent path.

This is the safer option throughout, and it is the intended behaviour, not an
oversight: buying out of per-edit prompts is not buying out of being told a file
is about to be destroyed. Under `yolo` nothing is raised at all, so deletions
are not prompted there either — that mode's contract is unchanged.
`destructiveChangeTool()` in `src/codex-app-server.ts` throws at import if one
of these names is ever added to `EDIT_TOOLS`.

### A malformed approval response fails closed — measured, do not re-derive

Answering an approval with something app-server cannot deserialize does **not**
hang the turn. Measured on 0.155.1: the server logs
`failed to deserialize …: unknown variant`, the item goes to `status:"declined"`
and `turn/completed` still arrives.

This matters for the v1 `ReviewDecision` denial, whose spelling changed between
the two binaries on this machine (`codex app-server generate-ts`):

```
0.135.0   … | "denied"                            | "timed_out" | "abort"
0.155.1   … | { "denied": { rejection: string } } | "timed_out" | "abort"
```

Neither spelling is right for both, so `CodexAppServerClient` now keeps
`InitializeResponse.userAgent` (`"gitbot/0.155.1 (Mac OS …)"`) and picks from
the server's own version. The cutover version inside the unmeasured 0.136–0.154
band is a guess — and it is a cheap one precisely because a wrong spelling on a
*denial* still produces a denial and still lets the turn finish.

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

### Why `yolo` is `never` — decided, do not "fix" this

`never` also **hard-blocks destructive commands**, and that is the reason it was
chosen. Under it, dangerous commands become `Decision::Forbidden` with no
approval path at all (`exec_policy.rs:797-803`). Live,
`danger-full-access` + `never`:

```
exec_command failed: Rejected("`rm -rf junk` rejected: rm -f style commands are
not permitted. Use a safer approach")   -- 0 server requests, junk/ survived
```

The identical command under `on-request` + `danger-full-access` prompts, is
accepted and succeeds.

So the choice was: `on-request` + blanket auto-accept, which genuinely runs
everything including `rm -rf`; or `never`, which refuses a small set of
destructive commands outright. **`never` was chosen deliberately.** Two reasons:

- It is the only mode where GitBot raises no approval request at all, so "yolo"
  means what it says — nothing was asked, nothing was auto-answered on the
  user's behalf. The audit trail is honest.
- A yolo session is the one place with no human in the loop. Keeping codex's own
  guardrail against `rm -rf` is worth losing the ability to run it.

Consequence to surface, not to paper over: yolo is **not** strictly more
permissive than `allow-all-edits`. A destructive command that `allow-all-edits`
would let the user approve is refused outright in yolo. That is surprising
enough that the UI copy must say it — `chat.tsx`'s "Every tool runs without
asking" is not the whole truth. Something closer to: *"Nothing is asked. Codex
still refuses a few commands it considers destructive."*

Do not silently switch this to `on-request` + auto-accept to make `rm -rf` work.
If it ever needs revisiting, it is a product decision, not a bug.

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
3. `yolo` asks nothing — **zero** approval requests reach GitBot, not "requests
   we auto-answer" — and can write outside the workspace. A destructive command
   (`rm -rf` on a scratch dir) is refused by codex itself, and the UI copy says
   so rather than promising that everything runs.
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
