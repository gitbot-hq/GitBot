# CDX-4 — File-change approvals + remaining ServerRequest kinds

**Depends on:** CDX-1. **Status:** not started.

CDX-1 handles command execution and blanket-declines everything else. This turns
the rest into real prompts.

## Build

`item/fileChange/requestApproval` → params
`{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}`.

Map to the shape the UI already renders for edits. Note what opencode does
(`src/start-opencode.ts:451-508`): it splits a diff into `old_string` /
`new_string` so the card shows a diff rather than a path. Match that where the
data allows; if app-server does not carry the diff on the approval request,
correlate with the `fileChange` item and say so explicitly rather than showing
an empty card.

Decisions: `"accept" | "acceptForSession" | "decline" | "cancel"`.

Then the remaining kinds, each currently auto-declined:

- `item/permissions/requestApproval` — params carry
  `{cwd, reason, permissions: RequestPermissionProfile}`; response is
  `{permissions, scope, strictAutoReview?}`, **not** `{decision}`. Different
  shape; do not assume.
- `item/tool/requestUserInput` — `{questions[], isBlocking}`. This is a question,
  not an approval. Either render it properly or decline it deliberately with a
  message the user can see — a silent decline looks like the agent stalling.
- `mcpServer/elicitation/request` — modes `form` / `url` / user-verification.
  Deliberate decline is acceptable for now; record the choice.
- Legacy v1 `execCommandApproval` / `applyPatchApproval` — keep as a fallback
  for older binaries. **Different enum**: `"approved" | "approved_for_session" |
  {denied:{rejection}} | "abort"`, not `accept`/`decline`. Mixing the two enums
  is the most likely bug in this issue.

## `availableDecisions`

The server tells us which buttons are legal per request, e.g.
`["accept", {"acceptWithExecpolicyAmendment":{…}}, "cancel"]`. Note that
`decline` is **not** always offered.

Plumb it through `permission_request` so the UI can render from it. If the UI
work is deferred, the server must still never send a decision the server did not
offer — clamp to something in the list. Today `chat.tsx:1519` hardcodes
Allow/Deny; at minimum map Deny to whichever of `decline`/`cancel` is available.

`acceptForSession` is the natural backing for the existing "Allow all" button
and is worth wiring — it is the one thing Claude Code cannot do.

## Acceptance criteria

1. A prompt that edits a file produces an approval card showing the file and,
   where available, the diff.
2. Allow → edit lands on disk. Deny → file unchanged, agent reports rejection.
3. `acceptForSession` (if wired) stops further prompts for that category within
   the thread, and only that thread.
4. A request offering no `decline` still gets a valid answer — no protocol error
   in the log.
5. A v1-style approval from an older binary is answered with the v1 enum and
   works. Test against the 0.135.0 on PATH.
6. Every remaining kind is answered, never dropped. Force one and watch the turn
   complete rather than hang.
7. Two approvals outstanding at once resolve independently and to the right
   requests.

## Review focus (adversarial)

- **Enum mixing.** v1 `approved` vs v2 `accept` sent on the wrong method.
- Response shape for `item/permissions/requestApproval` — it is not `{decision}`.
- Sending a decision absent from `availableDecisions`.
- Is `acceptForSession` scoped to the session, or does it leak across threads or
  outlive the process?
- Concurrent approvals keyed correctly; answering one must not resolve another.
- An approval arriving after abort, or after the child died.
