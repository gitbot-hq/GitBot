# CDX-5 — Permission modes → policy/sandbox/reviewer, and mid-turn switching

**Depends on:** CDX-1, CDX-4. **Status:** not started.

Approvals now work. This makes the three modes mean the same thing on codex as
they do on claude-code, and makes changing mode mid-turn actually do something.

## Build

Replace `permissionToCodex()` (`src/start-codex.ts:97`), which returns a sandbox
and nothing else, with a mapping to the full triple:

| session mode | `sandbox` | `approvalPolicy` | `approvalsReviewer` |
| --- | --- | --- | --- |
| `ask-permissions` | `read-only` | `on-request` | `user` |
| `allow-all-edits` | `workspace-write` | `on-request` | `user` |
| `yolo` | `danger-full-access` | `never` | — |

`plan` mode stays `read-only`.

The `read-only` + `on-request` pairing is what upstream recommends for
interactive use: the sandbox is the hard boundary, and `approval_policy` governs
what happens when the agent wants to escape it.

Do **not** use `approval_policy = "untrusted"`. It is retired upstream and can
prevent clients from starting; 0.155.1's `exec` already rejects it outright
while its app-server still accepts it. `on-failure` is likewise gone from the v2
enum. Only `never`, `on-request` and the new `granular` variant are safe.

Consequential cleanups:

- Delete the codex special-case in `botPermissionToSession()`
  (`src/server-common.ts:201`) that rewrites `ask-permissions` to
  `allow-all-edits`. Codex can ask now.
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
