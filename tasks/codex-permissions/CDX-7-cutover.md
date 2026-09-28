# CDX-7 — Cut over: delete the SDK path, drop the flag, fix the copy

**Depends on:** all. **Status:** not started.

The app-server path is proven. Make it the only path and remove every
workaround that existed because codex could not ask.

## Build

- Remove the `GITBOT_CODEX_APP_SERVER` flag; app-server becomes the path.
- Delete the SDK call path from `src/start-codex.ts` — `loadCodexSdk`,
  `createCodex`, `permissionToCodex`'s sandbox-only form, `handleEvent`,
  `handleItem`, and the `ThreadOptions` / `ThreadEvent` imports. Keep
  `@openai/codex-sdk` as a dependency **only** to pin and ship the binary; say
  so in a comment or it will look like a stray dep and get removed.
- Keep `codexOnPath()` and the CDX-2 fallback.
- Retain `listSessions`, `loadTranscript`, `readSessionMetaAndPreview`,
  `stripEnvelopes` and the attachment/manifest code unchanged — they read
  rollout files, which app-server writes identically.
- Delete dead code completely. No `_unused` renames, no re-exports, no
  `// removed` comments.

UI:

- `codexPermissionCopy` (`ui/app/components/chat.tsx:259`) exists solely to stop
  the menu promising a prompt that never arrives. Codex now prompts, so the
  codex-specific copy should collapse into the shared `permissionOptions` —
  except where a genuine difference remains (the sandbox is still a real,
  additional boundary, and is worth naming).
- The comment above it (`chat.tsx:252-254`) is now false and must go.
- If CDX-4 plumbed `availableDecisions`, render buttons from it instead of the
  hardcoded Allow/Deny at `chat.tsx:1519`.
- If CDX-2's probe reports approvals unavailable for the user's binary, the UI
  must say so rather than offering a mode that cannot work.

Docs:

- `docs/ARCHITECTURE.md:81` describes the codex adapter — rewrite.
- `docs/API.md` — update anything asserting codex has no approval channel.
- `README.md` — check the agent comparison for the same claim.
- Grep the repo for "no approval channel", "not enforced", "sandbox and only a
  sandbox" and similar. Several comments assert an architecture that no longer
  holds; a stale comment that confidently states the opposite of the truth is
  worse than none.

## Acceptance criteria

1. `npm run build:cli` and `npm run build:ui` both pass.
2. `grep -rn "GITBOT_CODEX_APP_SERVER" src ui` returns nothing.
3. Full manual pass on codex with no flag set: ask-permissions prompts,
   allow-all-edits, yolo, plan, abort, resume, images, tool fencing.
4. claude-code and opencode are untouched — regression-test one turn each.
5. No stale comment or doc line still claims codex cannot ask for permission.
6. A fresh `npm install` + `gitbot start` works end to end, including the
   postinstall path.
7. The three agents' permission menus are consistent, and any codex difference
   shown is a real one.

## Review focus (adversarial)

- Dead code that was left behind or defanged rather than deleted.
- `@openai/codex-sdk` still resolving at runtime for the binary — confirm on a
  clean install, not just this working tree.
- Did removing the flag change default behaviour for someone mid-session, or for
  a persisted bot in `bots.json`?
- Every user-facing string about codex permissions: is it now true?
- Anything in `dist/` or the built UI still carrying the old assumption.
