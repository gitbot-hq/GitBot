# CDX-2 — Binary resolution, capability probe, graceful degradation

**Depends on:** CDX-1. **Status:** not started.

CDX-1 borrows whatever binary is convenient. This issue makes binary selection
deliberate and makes an unexpected binary degrade instead of hang.

## Why

The SDK runs the codex it bundles, never the one on `PATH` — and on this
machine those differ (bundled 0.155.1, PATH 0.135.0). `app-server` is labelled
`[experimental]`; its shape was stable across 0.135→0.159 in testing, but
`untrusted` is already accepted by app-server while `exec` rejects it outright,
so the front-ends do drift.

## Build

Re-implement the SDK's private `findCodexPath()` (it is not exported). Mirror
`node_modules/@openai/codex-sdk/dist/index.js:393-503`:

1. `require.resolve("@openai/codex/package.json")`, then the platform package
   (`@openai/codex-darwin-arm64` and siblings) → `vendor/<triple>/bin/codex`.
2. **Prepend `vendor/<triple>/codex-path` to `PATH`** for the child. That is
   where the bundled `rg` lives; omitting it silently degrades the agent's
   search. This is easy to miss and has no obvious symptom.
3. Fall back to `codexOnPath()` (`src/start-codex.ts:57`) when the optional dep
   is absent, keeping the existing version-mismatch warning.

Capability probe at init:

- Run the `initialize` handshake once and record what comes back
  (`userAgent`, `codexHome`, …). Cache per binary path.
- If `app-server` is missing, errors, or refuses `experimentalApi`, log a clear
  warning and fall back to the SDK sandbox-only path rather than failing the
  agent. `initAgent()` (`src/start-codex.ts:41`) is the place to decide.
- Surface the outcome so `permissionToCodex` and the UI can tell the truth about
  whether approvals are available. A boolean on the agent capability record is
  enough; CDX-7 uses it for UI copy.

## Acceptance criteria

1. Resolution prefers the bundled binary; `codex --version` of the chosen path
   is logged at startup and reads `0.155.1` on this machine.
2. Child `PATH` contains the bundled `codex-path` directory — assert it, do not
   eyeball it.
3. Simulate a missing optional dep (e.g. temporarily point resolution at a bad
   path) → falls back to PATH codex with the existing warning, still runs a turn.
4. Simulate an app-server that fails the handshake → agent still loads, codex
   still works via the SDK path, warning logged, no hang and no crash.
5. Probe result is cached — starting several sessions does not spawn a probe
   child each time.

## Review focus (adversarial)

- Non-darwin-arm64 triples: is the platform package name derived, or hardcoded
  to this machine?
- `PATH` manipulation: separator on win32, empty/undefined `PATH`, duplicate
  entries on repeat spawns.
- Probe child cleanup — a probe that times out must not leave an orphan.
- Does a failed probe get retried forever, or cached as failed?
- Is the fallback genuinely reachable, or does an exception escape first?
