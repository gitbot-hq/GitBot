# Research Report: Model / Context / Effort in the Claude Agent SDK → GitBot picker

**Date:** 2026-10-06 (originally written against v0.2.42; **revised after the 0.3.291 upgrade**)
**Scope:** Research + a dependency version bump. No GitBot source code was changed.
**Goal:** Determine exactly how model selection, context window selection (200k vs 1M), and
reasoning/thinking effort are configured in the Claude Code Agent SDK, so a model + effort picker
can later be built in the GitBot UI for Claude Code threads.

**Installed:** `@anthropic-ai/claude-agent-sdk@0.3.291` at `node_modules/@anthropic-ai/claude-agent-sdk/`
(upgraded from `0.2.42`; `package.json:52`).

> **Read this first.** This document was rewritten after upgrading 0.2.42 → 0.3.291. Several
> conclusions in the original version are now **wrong**, and the original's own "could not be
> confirmed / false" warnings have in several cases flipped to true. Every claim below is verified
> against the installed 0.3.291 files or observed live on this machine's account
> (**Claude Max, OAuth, `apiProvider: firstParty`**) unless explicitly marked unverified.
> A short "what 0.2.42 did differently" note follows each changed finding.

---

## 0. What the upgrade changed structurally

| | 0.2.42 | 0.3.291 |
|---|---|---|
| `sdk.d.ts` | 1,943 lines | **9,951 lines** |
| CLI delivery | bundled `cli.js` (7,560 lines, minified JS) | **platform-native ELF binary**, ~250 MB, Bun-compiled |
| CLI location | inside the main package | `@anthropic-ai/claude-agent-sdk-{linux-x64,darwin-arm64,…}` as `optionalDependencies` |
| Dependencies | none | **`peerDependencies`**: `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0` |
| Entry points | `.` | `.`, `./core`, `./extract`, `./browser`, `./bridge`, `./sdk-tools` |

**⚠️ The original doc's research technique no longer works.** It said *"the bundled `cli.js` is the
real authority on accepted values, so the relevant parts were decompiled."* There is no `cli.js` in
0.3.291. The authority is now a stripped-of-JS native executable at
`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`. To inspect it:

```sh
strings -n 6 node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude > /tmp/s.txt
```

Minified JS source still appears in those strings (Bun embeds it), so symbol-level spelunking is
still possible — but the old `aR1`/`lg`/`Mzz` identifiers from 0.2.42 are gone or renamed, and
**empirical probing against a live session is now the cheaper and more reliable method.**

**Removed from the public surface** (the *only* removals): `SDKSession`, `SDKSessionOptions`,
`unstable_v2_createSession`, `unstable_v2_prompt`, `unstable_v2_resumeSession`. GitBot used none of
them. ~160 type/function names were **added**.

**Peer-dependency note.** GitBot does not declare `@anthropic-ai/sdk` or
`@modelcontextprotocol/sdk`. npm 7+ auto-installs peers, which is what happened here (101 packages
added on upgrade), so installs work — but these are now undeclared floating deps in a published
package. Worth a deliberate decision; deliberately left unchanged by the upgrade pass.

---

## (a) SDK option surface — exact names, types, file:line

All on the `Options` object (`sdk.d.ts:1521`) passed to `query({ prompt, options })`.

| Option | Type | `sdk.d.ts` | 0.2.42 line |
|---|---|---|---|
| `model` | `string` | **1962** | 683 |
| `fallbackModel` | `string` | **1684** | 564 |
| `effort` | `EffortLevel` | **1913** | 644 |
| `thinking` | `ThinkingConfig` | **1906** | 625–632 |
| `maxThinkingTokens` | `number` *(deprecated)* | **1922** | 653 |
| `betas` | `SdkBeta[]` | **1716** | 585 |
| `settings` | `string \| Settings` | **2212** | — *(new-ish: full settings overlay)* |
| `settingSources` | `SettingSource[]` | **2252** | 660 |
| `resume` | `string` | **2087** | — |
| `tools` | `string[] \| {…}` | **1640** | — |
| `disallowedTools` | `string[]` | **1604** | — |
| `canUseTool` | `CanUseTool` | **1589** | — |
| `stderr` | `(data: string) => void` | **2293** | — |
| `extraArgs` | `Record<string, string\|null>` | **1677** | 560 |
| `EffortLevel` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` | **691** | 644 (4 values) |
| `SdkBeta` | `'context-1m-2025-08-07'` (still the only member) | **3726** | 1214 |
| `SettingSource` | `'user'\|'project'\|'local'` | **9323** | — |
| `ThinkingConfig` | `ThinkingAdaptive\|ThinkingEnabled\|ThinkingDisabled` | **9710** | — |

**Mid-session changes** (`Query`, streaming-input mode only):

| Method | `sdk.d.ts` |
|---|---|
| `setModel(model?)` | **2896** |
| `setPermissionMode(mode)` | **2867** |
| `setMaxThinkingTokens(n, display?)` *(deprecated)* | **2923** |
| `applyFlagSettings(settings)` | **2951** ← **this is the new effort path** |
| `updateSettings(source, settings)` | **2966** |
| `initializationResult()` | **2975** |
| `supportedModels()` | **3013** |
| `getContextUsage(opts?)` | **3036** |

**Sub-agents** are still more restricted but gained effort: `AgentDefinition.tools?: string[]` (`:46`),
`.model?: string` (`:58`), `.effort?: ('low'|'medium'|'high'|'xhigh'|'max') | number` (`:91`) — note
the typed SDK surface now *does* carry sub-agent effort, and accepts a raw integer too. (0.2.42 had
`AgentDefinition.model?: 'sonnet'|'opus'|'haiku'|'inherit'` at `:53` and no typed effort.)

---

## (b) Mechanism: context window, and effort

### Context window — **`[1m]` is now a no-op for current models**

**This is the single biggest correction to the original document.** Opus / Sonnet / Fable 5.x are
**natively 1M**; the suffix adds nothing. Measured with `getContextUsage({detail:'summary'})` on a
live session, no turn needed:

```
haiku                 maxTokens=200000    rawMaxTokens=200000    autocompactSource=auto
sonnet                maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
sonnet[1m]            maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
opus                  maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
claude-opus-5[1m]     maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
claude-opus-5-5       maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
claude-fable-5-1      maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
claude-fable-5-1[1m]  maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
default               maxTokens=1000000   rawMaxTokens=1000000   autocompactSource=model-default
```

Note `claude-fable-5-1[1m]` reports its model back as plain `claude-fable-5-1` — the suffix is
stripped as redundant. **Only Haiku 4.5 is 200k.**

> **0.2.42 behaved differently.** There, `[1m]` was *the entire mechanism*: `xG(A,q)` returned 1e6
> only if the model string contained `[1m]` (or the beta was passed and `hBq()` judged the model
> 1M-capable: Sonnet 4/4.5 and Opus 4.6 only). A bare model name always meant 200k. The original
> doc's open question #2 — *"unverified web sources claim the beta was retired and Opus/Sonnet have
> native 1M at standard pricing"* — is now **confirmed true** for the window; pricing unverified.

The `context-1m-2025-08-07` beta constant still exists in both `SdkBeta` (`:3726`) and the binary,
so the suffix/beta path is presumably still honoured for older models — but it is no longer how you
get a long window on anything current.

### Context window — the authoritative runtime sources

`ModelInfo` has **no `contextWindow` field** (see (d)). Three real sources, in order of usefulness:

1. **`Query.getContextUsage({detail})`** (`:3036`) — best. Works on a live session **before any turn
   completes**, resolves aliases, and reports the window the session will actually be measured
   against. ⚠️ **The runtime keys are camelCase and do not match the documented `SDKContextUsage`
   type**, which specifies snake_case (`raw_max_tokens`, `total_tokens`). Observed runtime shape:
   `{ totalTokens, maxTokens, rawMaxTokens, autocompactSource, percentage, gridRows[] }`. Treat the
   type as unreliable here and read the camelCase keys.
2. **`ModelUsage.contextWindow`** (`:1443`) — only on a `result` message, i.e. *after* a turn.
   Keyed in `result.modelUsage` by the **model string as configured** (`"claude-opus-5[1m]"`), not
   the canonical id — which is why GitBot's existing lookup still works. Entries also carry
   `canonicalModel`, `provider`, `costBasis`, `maxOutputTokens`, `thinkingTokens`.
3. `autocompactSource` distinguishes `model-default` from a compaction-policy override, and
   `maxTokens` vs `rawMaxTokens` lets you tell an autocompact window from the model's hard limit.

### Effort

**Five values now, not four:** `EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
(`sdk.d.ts:691`). The binary's help text agrees: `low, medium, high, xhigh, max`.

> **0.2.42 behaved differently.** Its parser enum was `nK6 = ["low","medium","high","max"]` and the
> original doc explicitly listed `"xhigh"` among claims that were *"false for v0.2.42."* That was
> correct then. **`xhigh` is real in 0.3.291.**

Four ways to set it:

1. **SDK option** `effort` (`:1913`), session-start only.
2. **`Query.applyFlagSettings({ effortLevel })`** (`:2951`) — **mid-session, new in 0.3.x.**
3. **Env var** `CLAUDE_CODE_EFFORT_LEVEL`.
4. **settings.json** `effortLevel`. ⚠️ GitBot passes `settingSources: ["user","project","local"]`
   (`src/start-claude-code.ts:89`), so a user's `effortLevel` is *already* in effect today,
   invisibly. (Unchanged from 0.2.42.)

**Asymmetry worth knowing:** `Settings.effortLevel` (the persisted key, `:8959`) is only
`'low'|'medium'|'high'|'xhigh'` — **no `max`**. `max` is session-only and never written to a
settings file; per `applyFlagSettings`' own docs it "runs as `'high'` on a model without `'max'`
support, and runs no higher than the organization's effort limit for the model."

**New org clamps** a picker must expect: `Settings.maxEffortLevel` (`:8963`) and
`modelSettings.<model>.maxEffortLevel` (`:8976`). Anything above the cap — an `/effort` pick,
`--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, or a model default — is **silently clamped**. Across
settings files the lowest value wins. So the effort a picker requests is not necessarily the effort
that runs, and there is no error to catch.

**Effort × model compatibility — measured.** The original doc listed this as open question #4. It is
now answerable two ways:

- **Declaratively:** `ModelInfo.supportsEffort` / `supportedEffortLevels` (see (d)). Haiku's entry
  omits both; Opus / Sonnet / Fable all report all five levels.
- **Empirically: passing `effort` to a model that does not support it is silently ignored, not an
  error.** Live turns with `model:"haiku"` and `effort` of `max`, `xhigh` and `low` each returned
  `subtype: "success"` with no error and no warning. `model:"sonnet", effort:"xhigh"` likewise
  succeeded. **The CLI boundary accepts all five values for any model**, so a picker cannot rely on
  validation feedback and should gate on `supportedEffortLevels` itself.

**Default effort** is not stated in the type docs. 0.2.42's bundled CLI defaulted to `"high"`
(`c71()`); not re-verified for 0.3.291 — **unverified**.

**Thinking** is separate. `thinking?: ThinkingConfig` (`:1906`); `{type:'adaptive'}` is documented as
**the default for models that support it** (Opus 4.6+), with `maxThinkingTokens` deprecated in its
favour (`:1922`, "on Opus 4.6 this is treated as on/off"). Adaptive thinking is now broadly
available: `supportsAdaptiveThinking: true` on Opus, Sonnet **and** Fable (0.2.42 gated it to
`opus-4-6` alone via `g76()`).

**Fast mode is now SDK-addressable.** The original doc concluded *"Fast mode is not SDK-addressable —
zero `fast_mode`/`fastMode` hits in `sdk.d.ts`"*, and listed `fast_mode_state` among claims *"false
for v0.2.42."* Both have flipped:

- `initializationResult()` returns `fast_mode_state` and `fast_mode_disabled_reason`. Observed on
  this account: `"off"` / `"sdk_opt_in_required"` — i.e. it is opt-in-able from the SDK.
- `Settings.fastMode` (`:8999`), `Settings.fastModePerSessionOptIn` (`:9003`).
- `ModelInfo.supportsFastMode`.
- `Settings.ultracode` (`:8987`) is adjacent: session-scoped standing dynamic-workflow
  orchestration, typically set via `--settings` or `applyFlagSettings`.

### Env-var inventory

Unchanged from 0.2.42 plus one addition — **`CLAUDE_CODE_DISABLE_1M_CONTEXT`** (new kill switch):

`ANTHROPIC_MODEL` · `ANTHROPIC_DEFAULT_OPUS_MODEL` · `ANTHROPIC_DEFAULT_SONNET_MODEL` ·
`ANTHROPIC_DEFAULT_HAIKU_MODEL` · `ANTHROPIC_SMALL_FAST_MODEL` · `CLAUDE_CODE_SUBAGENT_MODEL` ·
`CLAUDE_CODE_EFFORT_LEVEL` · `MAX_THINKING_TOKENS` · `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` ·
`CLAUDE_CODE_DISABLE_THINKING` · `DISABLE_INTERLEAVED_THINKING` · `ANTHROPIC_BETAS` ·
`CLAUDE_CODE_DISABLE_FAST_MODE` · `CLAUDE_CODE_MAX_OUTPUT_TOKENS` ·
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` · **`CLAUDE_CODE_DISABLE_1M_CONTEXT`** ·
`CLAUDE_CODE_EXTRA_BODY` (noted as an un-clamped effort bypass)

---

## (c) The real runtime model list

Captured from `Query.supportedModels()` on a throwaway streaming-input session that never yields a
user message (so no tokens are consumed). Byte-identical to `initializationResult().models`.

**Account context:** `subscriptionType: "Claude Max"`, `apiProvider: "firstParty"`,
`capabilities: ["ui_surface_v1"]`. The list is plan-filtered, so it reflects this entitlement.

```json
[
  { "value": "default", "resolvedModel": "claude-opus-5-5",
    "displayName": "Default (recommended)",
    "description": "Opus 5.5 · Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsFastMode": true, "supportsAutoMode": true },

  { "value": "opus", "resolvedModel": "claude-opus-5-5",
    "displayName": "Opus",
    "description": "Opus 5.5 · Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsFastMode": true, "supportsAutoMode": true },

  { "value": "claude-fable-5-1[1m]", "resolvedModel": "claude-fable-5-1",
    "displayName": "Fable",
    "description": "Fable 5.1 · Most capable for your hardest and longest-running tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "sonnet", "resolvedModel": "claude-sonnet-5-5",
    "displayName": "Sonnet",
    "description": "Sonnet 5.5 · Efficient for routine tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "haiku", "resolvedModel": "claude-haiku-4-5-20251001",
    "displayName": "Haiku",
    "description": "Haiku 4.5 · Fastest for quick answers" }
]
```

Observations:

- **Only 5 rows, and only `claude-fable-5-1[1m]` carries a `[1m]` suffix** — because Fable's
  offered default *is* the long window. There are no separate `opus[1m]` / `sonnet[1m]` rows; they
  are unnecessary now that those models are natively 1M.
- **Haiku's row omits every capability flag** — no `supportsEffort`, no `supportedEffortLevels`, no
  `supportsAdaptiveThinking`, no `supportsFastMode`, no `supportsAutoMode`.
- `supportsFastMode` appears on **Opus/default only** — not Sonnet, not Fable.
- **"Fable" is real.** The original doc listed models named *"Fable"/"Mythos"* among claims *"false
  for v0.2.42"* — correct then, but Fable 5.1 now ships. **"Mythos" is not usable**: the string
  `claude-fable-5-mythos-5` exists in the binary, but `setModel("claude-fable-5-mythos-5")` is
  rejected with `Model 'claude-fable-5-mythos-5' not found`.
- `resolvedModel` is new and explicitly intended, per its doc comment, to let a host match a
  persisted explicit id back to the alias row that covers it.

### 1M entitlement gating — rewritten

**The 0.2.42 auth-method gate is gone.** Its error string — *"Opus 4.6 with extended context (1M) is
not available on your current plan."* — does not exist in the 0.3.291 binary. The guard was
`M_1() = { hasAccess: !O7() }` where `O7()` meant OAuth/subscription auth, so **`[1m]` required
API-key billing**. That is no longer true.

0.3.291 checks a **per-account entitlement**, separately per family:

```
"Opus with 1M context is not available for your account.   Learn more: …#extended-context-with-1m"
"Sonnet with 1M context is not available for your account. Learn more: …#extended-context-with-1m"
```

plus a disabled path keyed to `CLAUDE_CODE_DISABLE_1M_CONTEXT`. Both failures report through a
`model_switch` telemetry event with codes `opus_1m_unavailable` / `sonnet_1m_unavailable`.

**This OAuth / Claude Max account is entitled.** Verified two ways:

- A zero-token `setModel()` probe accepted **every** candidate: `opus`, `opus[1m]`, `sonnet`,
  `sonnet[1m]`, `haiku`, `claude-opus-5[1m]`, `claude-opus-5-5[1m]`, `claude-sonnet-5-5[1m]`,
  `claude-fable-5-1`, `claude-fable-5-1[1m]`, `default`.
- A real turn on `claude-opus-5[1m]` returned `modelUsage["claude-opus-5[1m]"].contextWindow =
  1000000`.

⇒ The original doc's open question #3 (*"does the `opus[1m]` auth gate fire in headless/SDK mode? a
`[1m]` default could be failing or silently degrading"*) resolves to **no — it works**, and open
question #1's worry about `claude-opus-5` being unknown to the CLI is also resolved: it is a
recognised canonical model in 0.3.291.

---

## (d) Picker-relevant: what `ModelInfo` gained, and what it still lacks

`ModelInfo` (`sdk.d.ts:1391`) — 0.2.42 had exactly three fields (`value`, `displayName`,
`description`):

| Field | New? | Notes |
|---|---|---|
| `value` | | id to pass as `model` |
| `resolvedModel?` | ✅ | canonical wire id the row resolves to |
| `displayName` | | |
| `description` | | |
| `supportsEffort?` | ✅ | |
| `supportedEffortLevels?` | ✅ | `('low'\|'medium'\|'high'\|'xhigh'\|'max')[]` |
| `supportsAdaptiveThinking?` | ✅ | |
| `supportsFastMode?` | ✅ | |
| `supportsAutoMode?` | ✅ | |
| ~~`contextWindow`~~ | ❌ | **still absent** — in the type *and* in the runtime JSON |

**So the effort compatibility matrix now comes free from the SDK and must not be hardcoded** — which
was the original doc's recommendation and is now actually possible. **The context window still does
not**, and must come from `getContextUsage()` or a `result` message's `ModelUsage.contextWindow`.

**There is still no `setEffort()`.** All 75 control-request subtypes were enumerated: `set_model`
and `set_max_thinking_tokens` exist; **no `set_effort`**. But the original doc's conclusion —
*"Effort is fixed at session start. This is the main UI constraint: changing effort mid-thread
requires starting a new turn/session"* — **no longer holds**, because `applyFlagSettings` covers it:

```ts
applyFlagSettings({ effortLevel: 'xhigh' })   // sdk.d.ts:2951 — session-scoped, accepts 'max'
updateSettings('userSettings', { effortLevel }) // :2966 — persists, per current model, like /effort
```

Gotcha from its doc comment: an `effortLevel` change sent **without** an `ultracode` key also turns
ultracode off; send both keys to change level and keep it on. `updateSettings` is allowlisted per
file (`localSettings`: `outputStyle` only; `userSettings`: `effortLevel` only) and refuses sessions
whose `--setting-sources` exclude the target.

Other additions a picker may care about:

- **`getContextUsage()`** — live per-category breakdown (system prompt, system tools, skills, MCP
  tools, memory files, agents) plus `gridRows` pre-shaped for a meter UI.
- **`prewarm()` / `ClaimOptions` / `WarmQuery`** — a pre-warmed spare could make the throwaway
  session that populates the picker nearly free. `ClaimOptions` also carries a flag-tier settings
  overlay (`{ fastMode: true, effortLevel: 'high' }`) applied at claim time.
- **Naming hazard:** the SDK now also exports a type called **`SessionStore`**
  (`Options.sessionStore`), unrelated to GitBot's `SessionStore` in `src/server-common.ts`. No
  current conflict — `start-claude-code.ts` imports GitBot's from `./server-common` and only
  `Options`/`SDKMessage`/`PreToolUseHookInput` from the SDK — but worth knowing before adding SDK
  imports there.
- `supportsAutoMode` (on every model except Haiku) and `supportsFastMode` (Opus only) are
  capability flags whose corresponding knobs live in `Settings`, not `Options` — reachable via
  `Options.settings` (`:2212`) at start or `applyFlagSettings` mid-session.

---

## (e) GitBot: what the upgrade did and did not require

### The upgrade itself: zero source changes

`package.json:52` (`^0.2.42` → `^0.3.291`) and a regenerated `package-lock.json`. Nothing else.

- `npx tsc --noEmit` — clean
- `npm run build` (tsc + Next UI) — clean
- `npm test` — **237 tests, 235 pass / 0 fail / 2 skipped**, identical to the pre-upgrade baseline
- Live turn through GitBot's own `runAgent()`: `init` → `sdkSessionId` bound → `context` event →
  assistant text → `result success` → `status: done`
- Second turn through `continueAgent()` (the `resume` path): same `sdkSessionId`, context carried

Every option GitBot passes still exists with a compatible type, and all four `SDKMessage` subtypes
its `formatMessage` switches on (`stream_event`, `tool_progress`, `tool_use_summary`, `result`)
survive. New message types fall through `formatMessage`'s `default: return null` and are ignored.

### Already wired (model) — unchanged

| Location | What |
|---|---|
| `src/start-claude-code.ts:82` | `model: store.model` → passed to `query()` |
| `src/start-claude-code.ts:77` | `store.model = store.model ?? DEFAULT_CLAUDE_MODEL` |
| `src/start-claude-code.ts:164` | reads `result.modelUsage[store.model].contextWindow` |
| `src/context-window.ts:31` | `DEFAULT_CLAUDE_MODEL = "claude-opus-5[1m]"` |
| `src/context-window.ts:34-36` | `contextWindowFor()` mirrors the `[1m]` rule |
| `src/bot-routes.ts:318` | `model: body.model ?? bot.model` ← per-turn override already supported |
| `src/server.ts:405-407` | `POST /chat` already destructures `model` |
| `src/turns.ts:32, 148` | `TurnRequest.model`, `if (model) store.model = model` |
| `src/bot-store.ts:51, 325` | `Bot.model?: string` persisted to `~/.gitbot/bots.json` |
| `src/server.ts:146` | `GET /sessions/:id/config` returns `model` |
| `ui/app/components/bot-form.tsx:106, 201, 467` | free-text model input on the bot form |

### ⚠️ Three model-correctness issues the upgrade exposed (not regressions — do not fix blind)

These are **behavioural drift**, not breakage; the build and tests pass and turns succeed. They
belong to the picker thread, not the version bump.

1. **`contextWindowFor()` is now wrong for bare 1M models.** `src/context-window.ts:34-36` returns
   1M only when the model string contains `[1m]`, else 200k. But `sonnet`, `claude-opus-5-5` and
   `claude-fable-5-1` are **natively 1M** with no suffix. A thread pinned to any of those would
   show a 200k meter against a real 1M window until the turn's `result` message corrects it (the
   `window` passed to `contextUsage()` at `start-claude-code.ts:164-165` overrides the heuristic, so
   the error is transient — but `loadTranscriptContext()` (`:531-533`) has only the heuristic plus
   an "overflowed 200k ⇒ must have been 1M" inference, so a *reopened* thread can read wrong.)
2. **`DEFAULT_CLAUDE_MODEL`'s `[1m]` suffix is now a no-op**, and it pins `claude-opus-5` while
   `default`/`opus` resolve to `claude-opus-5-5` — so GitBot's default is a half-generation behind
   what the account is offered. It does work and does get a 1M window.
3. **`modelLabel()`** (`src/context-window.ts:53-61`) derives `"Opus 5 (1M context)"` from the
   string. With `[1m]` no longer meaningful, the "(1M context)" tail becomes arbitrary — present
   for `claude-opus-5[1m]`, absent for an equally-1M `claude-opus-5-5`.

Also pre-existing and unrelated to the upgrade: `initAgent()` (`src/start-claude-code.ts:24`) gates
claude-code availability on the **system** `claude --version`, which has nothing to do with the
native binary the SDK actually spawns.

### The gap — what a per-thread picker still needs

1. `ui/app/lib/api.ts:93-103` — `postChat()` builds the body with
   `threadId/prompt/permissionMode/mode` and **never sends `model`**. Add `model` (+ `effort`); the
   server already accepts `model`.
2. `src/server.ts:405-407` — destructure `effort` alongside `model`.
3. `src/turns.ts:32` (`TurnRequest`) and `:148` — add `effort`, mirror the `if (model)` assignment.
4. `src/server-common.ts:230-262` (`SessionStore`) — add `effort?`, next to the existing `model?`.
5. `src/bot-routes.ts:253, 269, 318` — add `effort` to the body type and the
   `body.effort ?? bot.effort` resolution.
6. `src/bot-store.ts:51` — add `Bot.effort?` for the per-bot default.
7. `src/start-claude-code.ts:81-138` — add `...(store.effort ? { effort: store.effort } : {})`.

**Three facts about GitBot's own code that constrain the design:**

- **`SessionStore` is purely in-memory.** `export const sessions = new Map<string, SessionStore>()`
  (`src/server-common.ts:286`), populated by `createSession()` (`:416-446`), never serialized — it
  holds an `EventEmitter`, an `AbortController` and a `Map` of pending permission resolvers.
  `scheduleCleanup()` (`:448-455`) is **entirely commented out** ("sessions are kept in memory
  indefinitely"), so entries are never even evicted; they vanish only on process restart. Durable
  state lives in `bots.json` / `threads.json` via `bot-store.ts`. ⇒ **a per-thread effort stored only
  on `SessionStore` dies on restart**; to persist it needs a home in `threads.json`/`bots.json`.
- **`src/context-window.ts` maps model → window by string test only**, no table:
  `contextWindowFor()` returns 1M iff the model includes `[1m]`, else `DEFAULT_WINDOW = 200_000`;
  `contextUsage(used, model, window)` (`:63`) prefers an explicitly-passed `window`, which is how the
  SDK's real number wins. `DEFAULT_CLAUDE_MODEL` (`:31`) has exactly **two** consumers:
  `start-claude-code.ts:77` and the tests.
- **Live context/token usage is already in the UI, but not in a composer footer.** There is no
  composer footer *component* — no composer file exists at all; the composer is inline JSX in
  `ui/app/components/chat.tsx` (`.composer` at `:2090`, `:2109`, `:2135`, `:2171`). The data is
  already in that same component: `contextInfo` state (`:586`), seeded on open from `getMessages()`
  (`:836`) and updated live by the SSE `context` listener (`:1389-1397`). It currently renders in
  the **chat toolbar** — `chat-ctx` inside `toolbar` (`:1756-1766`), mounted at `:1811` and `:1884`.
  ⇒ a composer-footer readout needs **no new plumbing**: `ctx`, `ctxPct`, `ctxFull`, `ctxLit`,
  `ctxLabel`, `ctxModelDisplay` are all already in scope at `:1740-1754`.

⚠️ Note the `context` event is **GitBot's own SSE event**, not an SDK message. It first fires on the
first assistant message of a turn — *before* the turn completes — but at that moment its `window`
comes from GitBot's `[1m]` heuristic, not from the SDK. Only the `result` message carries the
authoritative `ModelUsage.contextWindow`. For a pre-turn authoritative number, `getContextUsage()`
is the only source.

### Other agents — unchanged

`src/turns.ts:49-53` dispatches to `runClaudeCode` / `runCodex` / `runOpencode`. Codex parses
`store.model` as `providerID/modelID` (`src/start-codex.ts:175-180`), so a shared picker needs
per-agent option lists. `src/server.ts:363` separately hardcodes `model: "claude-haiku-4-5"` for an
internal utility call. **Jarvis override:** `src/turns.ts:151` does
`if (botPreset?.jarvis) { store.model = undefined; store.mode = undefined; }` — Jarvis is pinned to
the default model and would need the same treatment for effort.

### Where the setting should live

Three layers already exist for `model` and should be mirrored for `effort`: per-bot default
(`Bot.model` in `~/.gitbot/bots.json`), per-turn override (`POST /chat` body → `SessionStore`), and
the Claude Code `settings.json` `effortLevel` key GitBot already inherits via `settingSources`. The
third layer means **an effort picker that sends nothing silently defers to the user's local settings
file**, not to a GitBot default — and on top of that, `maxEffortLevel` can clamp the result with no
error.

---

## Remaining open questions

1. **Default effort level in 0.3.291** — 0.2.42 defaulted to `"high"`; not re-verified. **Unverified.**
2. **1M pricing.** The window is confirmed native and free of the beta; whether it is at standard
   pricing is **unverified**. 0.2.42's CLI labelled `[1m]` variants "Uses rate limits faster" and
   surfaced a 5× premium multiplier. A picker should probably still carry a rate-limit warning.
3. **`getContextUsage()` response typing is wrong** (snake_case type vs camelCase runtime). Worth
   re-checking on a later release before depending on either spelling.
4. **Is `[1m]` harmful on a natively-1M model?** It is accepted and stripped, so apparently inert —
   but whether it still attaches the `context-1m-2025-08-07` beta header unnecessarily was not
   checked.
5. **`supportsAutoMode` / "auto mode"** is undocumented in `sdk.d.ts` beyond the flag itself. What it
   does, and which knob enables it, is **unverified**.
