# Research Report: Model / Context / Effort in the Claude Agent SDK → GitBot picker

**Date:** 2026-10-07 (first written against v0.2.42; revised after the 0.3.291 upgrade; **revised
again after building the picker**, which measured several things the earlier revisions guessed at)
**Goal:** Determine exactly how model selection, context window selection (200k vs 1M), and
reasoning/thinking effort are configured in the Claude Code Agent SDK, for the model + effort picker
in the GitBot UI for Claude Code threads.

**Installed:** `@anthropic-ai/claude-agent-sdk@0.3.291` at `node_modules/@anthropic-ai/claude-agent-sdk/`
(upgraded from `0.2.42`; `package.json:52`).

> **Read this first.** Every claim below states what is true **now**, verified against the installed
> 0.3.291 files or observed live on this machine's account
> (**Claude Max, OAuth, `apiProvider: firstParty`**) unless explicitly marked unverified. Where an
> earlier revision of this document or an earlier SDK concluded otherwise, a short parenthetical
> says so; the surrounding text is the current truth and can be read on its own.
>
> Two sections are **history, not current state**, and are labelled as such: §(e) describes GitBot
> before the picker was built, and the final **Known gaps** section is the live record of what the
> built picker still owes.

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
| `EffortLevel` | **five values:** `'low'\|'medium'\|'high'\|'xhigh'\|'max'` | **691** | 644 (0.2.42 had four: no `xhigh`) |
| `SdkBeta` | `'context-1m-2025-08-07'` (still the only member) | **3726** | 1214 |
| `SettingSource` | `'user'\|'project'\|'local'` | **9323** | — |
| `ThinkingConfig` | `ThinkingAdaptive\|ThinkingEnabled\|ThinkingDisabled` | **9710** | — |

**`Query` methods.** Only the *mutating* ones require streaming input; the read-only ones work on
any query, including the plain string-prompt form GitBot uses for an ordinary turn — verified for
`supportedModels()`, which is how the picker gets its list without a session of its own:

| Method | `sdk.d.ts` | Streaming input required? |
|---|---|---|
| `setModel(model?)` | **2896** | **yes** (documented) |
| `setPermissionMode(mode)` | **2867** | **yes** |
| `setMaxThinkingTokens(n, display?)` *(deprecated)* | **2923** | **yes** |
| `applyFlagSettings(settings)` | **2951** ← **the mid-session effort path** | **yes** (documented) |
| `updateSettings(source, settings)` | **2966** | **yes** |
| `initializationResult()` | **2975** | no |
| `supportedModels()` | **3013** | **no — verified on a string-prompt query** |
| `getContextUsage(opts?)` | **3036** | no |

**Sub-agents** are still more restricted but gained effort: `AgentDefinition.tools?: string[]` (`:46`),
`.model?: string` (`:58`), `.effort?: ('low'|'medium'|'high'|'xhigh'|'max') | number` (`:91`) — note
the typed SDK surface now *does* carry sub-agent effort, and accepts a raw integer too. (0.2.42 had
`AgentDefinition.model?: 'sonnet'|'opus'|'haiku'|'inherit'` at `:53` and no typed effort.)

---

## (b) Mechanism: context window, and effort

### Context window — measured per model

**Two rules, not one.** Most models on offer are natively 1M and need no suffix; three are 200k; and
on one of those three the `[1m]` suffix still buys the long window. There is **no rule derivable
from the model name** — in particular **no "4.x is short" rule**: Opus 4.6 is 200k while Opus 4.7
and 4.8 are 1M.

**Every row of `supportedModels()` measured on 2026-10-07** with
`Query.getContextUsage({ detail: 'summary' })` against a live session — it works before any turn
completes and reports the window the session is actually held to, so **re-measure rather than guess
when a new model lands**:

```
default               maxTokens=1000000   rawMaxTokens=1000000
opus                  maxTokens=1000000   rawMaxTokens=1000000
fable                 maxTokens=1000000   rawMaxTokens=1000000
sonnet                maxTokens=1000000   rawMaxTokens=1000000
haiku                 maxTokens=200000    rawMaxTokens=200000     ← short
claude-sonnet-5       maxTokens=1000000   rawMaxTokens=1000000
claude-opus-5         maxTokens=1000000   rawMaxTokens=1000000
claude-fable-5        maxTokens=1000000   rawMaxTokens=1000000
claude-opus-4-8       maxTokens=1000000   rawMaxTokens=1000000
claude-opus-4-7       maxTokens=1000000   rawMaxTokens=1000000
claude-opus-4-6       maxTokens=200000    rawMaxTokens=200000     ← short
claude-sonnet-4-6     maxTokens=200000    rawMaxTokens=200000     ← short
```

**The three short-window families** are therefore `haiku` (and its canonical ids
`claude-haiku-4-5`, `claude-haiku-4-5-20251001`), `claude-opus-4-6`, and `claude-sonnet-4-6`.
Everything else is 1M. (An earlier revision of this document said *"only Haiku 4.5 is 200k"* — that
was measured on a five-row list that did not yet include the 4.6 pair.)

### Context window — what `[1m]` still means

**The suffix is inert on a natively-1M model and load-bearing on Opus 4.6.** Measured the same way:

```
claude-opus-4-6[1m]    maxTokens=1000000        ← the suffix is what makes this 1M
claude-fable-5-1[1m]   maxTokens=1000000        ← already 1M without it
claude-opus-5[1m]      maxTokens=1000000        ← already 1M without it
sonnet[1m]             maxTokens=1000000        ← already 1M without it
haiku[1m]              rejected: "Haiku 4.5 doesn't have a 1M context window, so 'haiku[1m]'
                                  isn't available."
claude-sonnet-4-6[1m]  rejected: "Sonnet with 1M context is not available for your account."
claude-haiku-4-5[1m]   rejected: API 400, "The long context beta is not yet available for this
                                  subscription"
```

So the suffix **fails loudly where it cannot be granted** rather than degrading silently — which
means a run that got as far as reporting usage with a `[1m]` string really does have the long
window, and `[1m]` can safely be treated as "1M" without a per-model table. Note also that
`claude-fable-5-1[1m]` reports its model back as plain `claude-fable-5-1`: the suffix is stripped
where it is redundant.

The `context-1m-2025-08-07` beta constant still exists in both `SdkBeta` (`:3726`) and the binary,
and the Opus 4.6 result above is that path still working — it is simply no longer how a long window
is obtained on anything current.

> **0.2.42 behaved differently.** There, `[1m]` was *the entire mechanism*: `xG(A,q)` returned 1e6
> only if the model string contained `[1m]` (or the beta was passed and `hBq()` judged the model
> 1M-capable: Sonnet 4/4.5 and Opus 4.6 only). A bare model name always meant 200k. The original
> doc's open question #2 — *"unverified web sources claim the beta was retired and Opus/Sonnet have
> native 1M at standard pricing"* — is **true for the window**; pricing remains unverified.

### Context window — the authoritative runtime sources

`ModelInfo` has **no `contextWindow` field** (see (d)). Three real sources, in order of usefulness:

1. **`Query.getContextUsage({detail})`** (`:3036`) — best. Works on a live session **before any turn
   completes**, resolves aliases, and reports the window the session will actually be measured
   against. ⚠️ **The runtime keys are camelCase and do not match the documented `SDKContextUsage`
   type**, which specifies snake_case (`raw_max_tokens`, `total_tokens`). Observed runtime shape:
   `{ totalTokens, maxTokens, rawMaxTokens, autocompactSource, percentage, gridRows[] }`. Treat the
   type as unreliable here and read the camelCase keys.
2. **`ModelUsage.contextWindow`** (`:1443`) — only on a `result` message, i.e. *after* a turn.
   **Keyed by the configured string only when that string is a literal model id; an alias is
   replaced by the id the run resolved to.** Measured 2026-10-07:

   ```
   configured "default"           → keys ["claude-haiku-4-5-20251001", "claude-opus-5-5"]
   configured "opus"              → keys ["claude-haiku-4-5-20251001", "claude-opus-5-5"]
   configured "haiku"             → keys ["claude-haiku-4-5-20251001"]
   configured "claude-opus-5[1m]" → keys ["claude-haiku-4-5-20251001", "claude-opus-5[1m]"]
   ```

   (An earlier revision said "keyed by the model string as configured, not the canonical id". That
   was inferred from `claude-opus-5[1m]` alone — a literal id, which does not distinguish the two.)
   Two consequences for a host: look up the configured string *and* the canonical id the main
   thread's assistant messages report (`claude-opus-5[1m]` resolves to `claude-opus-5`, so neither
   subsumes the other), and expect **a Haiku entry on almost every turn** from Claude Code's own
   small-model helper work — so neither "the only entry" nor "the largest window" identifies the
   main model. Entries also carry `canonicalModel`, `provider`, `costBasis`, `maxOutputTokens`,
   `thinkingTokens`.
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

**Effort × model compatibility — measured.** Answerable two ways, and the two disagree:

- **Declaratively:** `ModelInfo.supportsEffort` / `supportedEffortLevels` (see (d)). Haiku's row
  omits both. The 5.x models and Opus 4.7/4.8 report all five levels. **Opus 4.6 and Sonnet 4.6
  report only four — `["low","medium","high","max"]`, no `xhigh`.** (An earlier revision said
  "Opus / Sonnet / Fable all report all five levels"; that was read off a list with no 4.6 rows.)
- **Empirically: the CLI validates nothing and ignores what it cannot use.** Live turns with
  `model:"haiku"` and `effort` of `max`, `xhigh` and `low` each returned `subtype: "success"` with
  no error and no warning. Stronger: **`--effort bogus` — not an `EffortLevel` at all — starts the
  session normally and never complains** (probed 2026-10-06 by watching the spawned CLI's argv).

⇒ **There is no validation feedback to rely on, in either direction.** A host that wants a bad value
rejected must check it itself, and a host that offers a level a model does not declare gets silence
rather than an error. GitBot's picker deliberately offers all five levels for every model and
validates only the enum at its own HTTP boundary; the cost is that `xhigh` on Haiku or on the 4.6
pair shows a setting that does nothing. (An earlier revision recommended gating on
`supportedEffortLevels` — that was considered and rejected, see **Known gaps**.)

**Confirmed the SDK does forward it:** the spawned CLI's argv carries `--effort <level>` alongside
`--model`, so `Options.effort` is not dropped on the floor even though nothing echoes it back.
Neither `initializationResult()` nor the transcript records the effort a session ran at.

**Default effort** is not stated in the type docs. 0.2.42's bundled CLI defaulted to `"high"`
(`c71()`); not re-verified for 0.3.291 — **unverified**, and moot for GitBot, which now always sends
an explicit level.

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

Captured **2026-10-07** from `Query.supportedModels()` on a throwaway streaming-input session that
never yields a user message (so no tokens are consumed). Re-verified the same day to be byte-identical
to `initializationResult().models`.

**Account context:** `subscriptionType: "Claude Max"`, `apiProvider: "firstParty"`. The list is
plan-filtered, so it reflects this entitlement and another account may be offered fewer rows.

**This list changes without an SDK upgrade.** An earlier capture in this document (2026-10-06, same
account, same SDK build) had only **five** rows, named Fable `claude-fable-5-1[1m]`, and used
shorter display names ("Opus", "Sonnet"). Treat any transcription — including this one — as a
snapshot, and read the live call for anything that must be correct.

```json
[
  { "value": "default", "resolvedModel": "claude-opus-5-5",
    "displayName": "Default (recommended)",
    "description": "Opus 5.5 · Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsFastMode": true, "supportsAutoMode": true },

  { "value": "opus", "resolvedModel": "claude-opus-5-5",
    "displayName": "Opus 5.5",
    "description": "For complex work and everyday tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsFastMode": true, "supportsAutoMode": true },

  { "value": "fable", "resolvedModel": "claude-fable-5-1",
    "displayName": "Fable 5.1",
    "description": "For your toughest challenges",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "sonnet", "resolvedModel": "claude-sonnet-5-5",
    "displayName": "Sonnet 5.5",
    "description": "Most efficient for simpler tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "haiku", "resolvedModel": "claude-haiku-4-5-20251001",
    "displayName": "Haiku 4.5",
    "description": "Fastest for quick answers" },

  { "value": "claude-sonnet-5", "resolvedModel": "claude-sonnet-5",
    "displayName": "Sonnet 5",
    "description": "Efficient for routine tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "claude-opus-5", "resolvedModel": "claude-opus-5",
    "displayName": "Opus 5",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsFastMode": true, "supportsAutoMode": true },

  { "value": "claude-fable-5", "resolvedModel": "claude-fable-5",
    "displayName": "Fable 5",
    "description": "Most capable for your hardest and longest-running tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "claude-opus-4-8", "resolvedModel": "claude-opus-4-8",
    "displayName": "Opus 4.8",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsFastMode": true, "supportsAutoMode": true },

  { "value": "claude-opus-4-7", "resolvedModel": "claude-opus-4-7",
    "displayName": "Opus 4.7",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","xhigh","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "claude-opus-4-6", "resolvedModel": "claude-opus-4-6",
    "displayName": "Opus 4.6",
    "description": "Best for everyday, complex tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true },

  { "value": "claude-sonnet-4-6", "resolvedModel": "claude-sonnet-4-6",
    "displayName": "Sonnet 4.6",
    "description": "Efficient for routine tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low","medium","high","max"],
    "supportsAdaptiveThinking": true, "supportsAutoMode": true }
]
```

Observations:

- **12 rows: four aliases, one `default`, and seven pinned canonical ids.** No row carries a `[1m]`
  suffix — not even Fable, which is now offered as plain `fable`. The suffix is still *accepted* as
  input where the model supports it (see (b)); it is simply not offered.
- **Haiku's row omits every capability flag** — no `supportsEffort`, no `supportedEffortLevels`, no
  `supportsAdaptiveThinking`, no `supportsFastMode`, no `supportsAutoMode`. It is the only such row.
- **`supportedEffortLevels` is not uniform:** the 4.6 pair lists four levels, omitting `xhigh`.
  Everything else that supports effort lists all five.
- **`supportsFastMode` is on the Opus family only** — `default`, `opus`, `claude-opus-5`,
  `claude-opus-4-8`. Not Sonnet, not Fable, not Opus 4.7, not Haiku. (An earlier revision said
  "Opus/default only", before the pinned rows existed.)
- **`supportsAutoMode` is on every row except Haiku.**
- **"Fable" is real.** The original doc listed models named *"Fable"/"Mythos"* among claims *"false
  for v0.2.42"* — correct then, but Fable 5.1 now ships. **"Mythos" is not usable**: the string
  `claude-fable-5-mythos-5` exists in the binary, but `setModel("claude-fable-5-mythos-5")` is
  rejected with `Model 'claude-fable-5-mythos-5' not found`.
- `resolvedModel` is explicitly intended, per its doc comment, to let a host match a persisted
  explicit id back to the alias row that covers it. Note the pinned rows resolve to themselves.
- **No row carries a context window** — see (b) for the measured numbers and (d) for why.

### 1M entitlement gating

**1M does not require API-key billing.** This OAuth / Claude Max subscription account gets the long
window, on both natively-1M models and `claude-opus-4-6[1m]`. (0.2.42 did gate it on auth method:
`M_1() = { hasAccess: !O7() }`, where `O7()` meant OAuth/subscription auth, so `[1m]` then required
API-key billing. Its error string — *"Opus 4.6 with extended context (1M) is not available on your
current plan."* — does not exist in the 0.3.291 binary.)

0.3.291 checks a **per-account entitlement**, separately per family:

```
"Opus with 1M context is not available for your account.   Learn more: …#extended-context-with-1m"
"Sonnet with 1M context is not available for your account. Learn more: …#extended-context-with-1m"
```

plus a disabled path keyed to `CLAUDE_CODE_DISABLE_1M_CONTEXT`. Both failures report through a
`model_switch` telemetry event with codes `opus_1m_unavailable` / `sonnet_1m_unavailable`.

**This account is entitled for Opus, but not for Sonnet.** Verified three ways:

- A zero-token `setModel()` probe accepted **every** candidate tried: `opus`, `opus[1m]`, `sonnet`,
  `sonnet[1m]`, `haiku`, `claude-opus-5[1m]`, `claude-opus-5-5[1m]`, `claude-sonnet-5-5[1m]`,
  `claude-fable-5-1`, `claude-fable-5-1[1m]`, `default`.
- A real turn on `claude-opus-5[1m]` returned `modelUsage["claude-opus-5[1m]"].contextWindow =
  1000000`.
- `claude-opus-4-6[1m]` measures 1M, while **`claude-sonnet-4-6[1m]` is refused** with the
  per-family message above — so the Sonnet entitlement genuinely is absent here, and the two
  families really are gated separately. (Bare `sonnet` / `claude-sonnet-5-5` are unaffected: they
  are natively 1M and need no entitlement.)

⇒ The original doc's open question #3 (*"does the `opus[1m]` auth gate fire in headless/SDK mode? a
`[1m]` default could be failing or silently degrading"*) resolves to **no — it works, and it fails
loudly rather than degrading when it cannot**. Open question #1's worry about `claude-opus-5` being
unknown to the CLI is also resolved: it is a recognised canonical model, and now an offered row.

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

**The effort compatibility matrix comes free from the SDK** and need not be hardcoded — though note
it is per-model and not uniform (the 4.6 pair omits `xhigh`), and that nothing enforces it: a level
a model does not list is ignored rather than refused, so the matrix is advisory. **The context
window still does not come from `ModelInfo`**, and must be measured with `getContextUsage()` or read
from a `result` message's `ModelUsage.contextWindow`.

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
- `supportsAutoMode` (every row except Haiku) and `supportsFastMode` (the Opus family only — see
  (c) for exactly which rows) are capability flags whose corresponding knobs live in `Settings`, not
  `Options` — reachable via `Options.settings` (`:2212`) at start or `applyFlagSettings` mid-session.

---

## (e) GitBot: what the upgrade did and did not require

> ⚠️ **This section is a snapshot of GitBot *before* the picker was built, kept because it records
> why the picker was designed the way it was.** Every `file:line` below is pre-picker and most have
> moved. The three correctness issues it lists are now two-fixed / one-open, and the seven-item
> "gap" list is implemented — each is annotated inline. For current state read the code, or the
> **Known gaps** section at the end of this document.

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

### ⚠️ Three model-correctness issues the upgrade exposed

Behavioural drift rather than breakage. **Issues 1 and 2 were fixed by the picker work; issue 3 is
still open** (Known gaps #6).

1. ~~**`contextWindowFor()` is now wrong for bare 1M models.**~~ **Fixed.** `src/context-window.ts:34-36` returned
   1M only when the model string contains `[1m]`, else 200k. But `sonnet`, `claude-opus-5-5` and
   `claude-fable-5-1` are **natively 1M** with no suffix. A thread pinned to any of those would
   show a 200k meter against a real 1M window until the turn's `result` message corrects it (the
   `window` passed to `contextUsage()` at `start-claude-code.ts:164-165` overrides the heuristic, so
   the error is transient — but `loadTranscriptContext()` (`:531-533`) has only the heuristic plus
   an "overflowed 200k ⇒ must have been 1M" inference, so a *reopened* thread can read wrong.)
2. ~~**`DEFAULT_CLAUDE_MODEL`'s `[1m]` suffix is a no-op**, and it pins `claude-opus-5` while
   `default`/`opus` resolve to `claude-opus-5-5`.~~ **Fixed:** the default is now the SDK's own
   `"default"` alias, which tracks whatever the account is offered.
3. **`modelLabel()`** (then `src/context-window.ts:53-61`) derives `"Opus 5 (1M context)"` from the
   string. The "(1M context)" tail is arbitrary now that most models are 1M without a suffix.
   **Still open** — and since the default is now `"default"`, the meter's chip reads "Default".
   See Known gaps #6.

Also pre-existing and unrelated to the upgrade: `initAgent()` (`src/start-claude-code.ts:24`) gates
claude-code availability on the **system** `claude --version`, which has nothing to do with the
native binary the SDK actually spawns.

### The gap — what a per-thread picker needed

**All seven are now done, except 5 and 6, which were deliberately dropped: effort is per *thread*,
not per bot, so there is no `Bot.effort` and no `body.effort ?? bot.effort`.** A `Thread.model` /
`Thread.effort` pair in `threads.json` took their place, since that is the only store that survives
a restart.

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
- **`src/context-window.ts` mapped model → window by string test only**, no table:
  `contextWindowFor()` returned 1M iff the model included `[1m]`, else 200k. *(Now a static
  short-window set plus a `[1m]` short-circuit, per the measurements in (b).)*
  `contextUsage(used, model, window)` prefers an explicitly-passed `window`, which is how the SDK's
  real number wins — unchanged.
- **Live context/token usage is already in the UI.** There is no composer *component* — the
  composer is inline JSX in `ui/app/components/chat.tsx`. The data is `contextInfo` state in that
  same component, seeded on open from `getMessages()` and updated live by the SSE `context`
  listener. It renders in the **chat toolbar**, top right — which is still where it is; the picker
  added a footer under the composer for the two dropdowns only, and reads the same `contextInfo`
  from there to grey out models the conversation has outgrown.

⚠️ Note the `context` event is **GitBot's own SSE event**, not an SDK message. It first fires on the
first assistant message of a turn — *before* the turn completes — but at that moment its `window`
comes from GitBot's own table, not from the SDK. Only the `result` message carries the authoritative
`ModelUsage.contextWindow`. For a pre-turn authoritative number, `getContextUsage()` is the only
source — GitBot does not call it, so its meter is only as right as that table.

### Other agents — unchanged

`src/turns.ts:49-53` dispatches to `runClaudeCode` / `runCodex` / `runOpencode`. Codex parses
`store.model` as `providerID/modelID` (`src/start-codex.ts:175-180`), so a shared picker needs
per-agent option lists. `src/server.ts:363` separately hardcodes `model: "claude-haiku-4-5"` for an
internal utility call. **Jarvis override:** `src/turns.ts` clears `store.model` and `store.mode` for
a Jarvis preset — Jarvis is pinned to the default model. *(It now clears `store.effort` too, and the
UI hides the picker on Jarvis threads.)*

### Where the setting lives

Two layers, plus one that no longer applies: per-thread pick (`Thread.model` / `Thread.effort` in
`~/.gitbot/threads.json`) and per-turn override (`POST /chat` body → `SessionStore`), resolved
`body ?? thread ?? bot ?? default`. `Bot.model` survives beneath the thread's pick; there is no
`Bot.effort`.

**The `settings.json` `effortLevel` layer is now closed off.** GitBot passes
`settingSources: ["user","project","local"]`, so a user's `effortLevel` *was* silently in effect —
but the picker sends an explicit `effort` on every turn, which outranks it, so neither that key nor
`CLAUDE_CODE_EFFORT_LEVEL` reaches a gitbot thread any more. That is deliberate: the UI is the single
source of truth. An org `maxEffortLevel` can still clamp the result with no error.

---

## Remaining open questions

1. **Default effort level in 0.3.291** — 0.2.42 defaulted to `"high"`; not re-verified.
   **Unverified**, and no longer load-bearing: GitBot always sends an explicit level.
2. **1M pricing.** The window is native and free of the beta on current models; whether it is at
   standard pricing is **unverified**. 0.2.42's CLI labelled `[1m]` variants "Uses rate limits
   faster" and surfaced a 5× premium multiplier. The picker carries no rate-limit warning — worth
   revisiting if that multiplier still applies to `claude-opus-4-6[1m]`.
3. **`getContextUsage()` response typing is wrong** (snake_case type vs camelCase runtime). Still
   true as of 2026-10-07 — the probes in (b) had to read `maxTokens`, not `max_tokens`. Worth
   re-checking on a later release before depending on either spelling.
4. **Is `[1m]` harmful on a natively-1M model?** Partly answered: it is accepted, stripped from the
   reported model name, and measures the same 1M, so it is **inert on those models** — but whether
   it still attaches the `context-1m-2025-08-07` beta header (and any pricing that rides on it) was
   not checked. On Opus 4.6 it is not inert at all: it is what grants the window.
5. **`supportsAutoMode` / "auto mode"** is undocumented in `sdk.d.ts` beyond the flag itself. What it
   does, and which knob enables it, is **unverified**.
6. **Why the offered list changed within one SDK build** — five rows on 2026-10-06, twelve on
   2026-10-07, same binary and account. Server-side, presumably, but it means the list is not a
   function of the installed version and cannot be cached across sessions on that assumption.

---

## Known gaps in the picker implementation

Carried over from the picker build (uncommitted on `jarvis`). Struck-through items are fixed; the
rest stand. Items 1, 2 and 4 were fixed on 2026-10-07; items 8–13 came out of a second review the
same day (8–12 fixed, 13 deferred); items 14–18 from a third (all fixed, with one accepted
limitation recorded under 14).

1. ~~**The five-entry list in (c) is stale.**~~ **Fixed,** in both places. The fallback in
   `ui/app/lib/claude-models.ts` is now a transcription of the live 12-row answer (Fable is plain
   `fable`, names are `Opus 5.5`/`Sonnet 5.5`/`Haiku 4.5`, pinned `claude-*` rows included), and
   `modelDisplayName()` derives a readable name ("Opus 6.1") for any value no list accounts for
   instead of showing the raw id. The live list still replaces it verbatim on arrival. §(c) above
   now records the same 12-row capture — but see open question 6: that list moves on its own.
2. ~~**`contextWindowFor()`'s "everything but haiku = 1M" is wrong.**~~ **Fixed.** Measured every
   live row with `getContextUsage({detail:'summary'})`: short-window models are `haiku`,
   `claude-opus-4-6` and `claude-sonnet-4-6` only — **4.7 and 4.8 are 1M**, so it is not a "4.x is
   short" rule. `claude-opus-4-6[1m]` *is* 1M, so an explicit `[1m]` now short-circuits to the long
   window; the CLI refuses the suffix where it cannot be granted (`haiku[1m]`, and
   `claude-sonnet-4-6[1m]` on this account).
3. **Resolution keeps `bot.model` in the chain** (`body ?? thread ?? bot ?? default`) rather than the
   `thread ?? default` the picker spec describes — dropping it would silently break the existing
   per-bot model field.
4. ~~**The context meter moved** into the composer footer.~~ **Reverted.** The meter is back in the
   chat toolbar, top right; only the two dropdowns live in the footer. The greying of short-window
   models reads the same `contextInfo` state from where it is.
5. **Effort gets no validation feedback from anywhere.** `--effort bogus` starts the CLI normally and
   never complains (probed), so GitBot validates at its own HTTP boundary; an org `maxEffortLevel`
   can still clamp silently (see (b)).
6. **`modelLabel()` renders the meter's chip as "Default"** now that `DEFAULT_CLAUDE_MODEL` is
   `"default"`, and still appends an arbitrary "(1M context)" for a `[1m]` string — cosmetic, and
   the picker names the model properly alongside it. (This is §(e)'s correctness issue 3.)
7. **The picker offers `xhigh` on models that do not declare it.** `claude-opus-4-6` and
   `claude-sonnet-4-6` report `supportedEffortLevels` of four levels, without `xhigh`; Haiku
   declares no effort support at all. The picker shows all five for every model by design — the CLI
   ignores a level it cannot use rather than refusing it, and gating would make the control change
   shape as the model changes. The cost is a setting that silently does nothing on three of the
   twelve rows. Revisit if that becomes confusing; `supportedEffortLevels` is right there in the
   row if it should ever be honoured.
8. ~~**`loadTranscriptContext` promoted any over-window thread to 1M.**~~ **Fixed.** The rule made
   sense when the window was 200k for everything without `[1m]`; now the table is per model and the
   model is the *next* turn's, so an overrun is a real reading — the thread does not fit what it is
   about to run — and is the same condition the picker greys a short-window model on. The promotion
   also disagreed with the live meter, which never promoted. A test had been written around it and
   now asserts the opposite.
9. ~~**`result.modelUsage` was read with the configured string, which misses for an alias.**~~
   **Fixed.** Measured 2026-10-07: `modelUsage` keys a literal id as given (`claude-opus-5[1m]`) but
   replaces an alias with the id the run resolved to — `model:"default"` yields keys
   `["claude-haiku-4-5-20251001","claude-opus-5-5"]`, with no `default` entry, so the previous
   lookup missed on **every** thread in the default state. The research doc's "keyed by the model
   string as configured" was only ever tested with a literal id; §(b) source 2 is corrected.
   The lookup now tries the configured string, then the canonical id the main thread's assistant
   messages report, then `canonicalModel` — and **logs on a miss**, because the fallback is exactly
   the number the static table would have produced, so a miss and a correct table were previously
   indistinguishable. Note a Haiku entry is almost always present from Claude Code's own helper
   calls, so "the only entry" and "the largest window" are both wrong ways to pick.
   **Follow-up from the second review round, fixed:** the first cut tested only the miss branch —
   the stub sent `modelUsage: {}`, so every one of those tests quietly logged the warning and the
   probe's real keys survived only in a comment. All three lookup steps now have tests built from
   the probe's actual payloads, each asserting a window the static table could not have produced
   (so a hit is distinguishable from the fallback) and asserting that **nothing warned** — a
   warning on a hit path being precisely what hid the gap. Each step was mutation-checked to
   confirm it is pinned on its own rather than covered by a later step.
10. ~~**The short-window table missed dated builds of the 4.6 pair.**~~ **Fixed** with token-exact
    prefix matching on the short families. The escape hatch previously covered Haiku only while its
    comment claimed to generalise, so `claude-opus-4-6-20260101` sized as 1M and was not greyed.
    Matching is boundary-aware: `claude-opus-4-6` must not claim a future `claude-opus-4-61`, which
    a first cut did — caught by its own test.
    **Two follow-ups from the second review round, both fixed.** (a) The first fix narrowed Haiku
    from a `includes("haiku")` catch-all to the prefix `claude-haiku-4-5`, which made a future
    `claude-haiku-5` read as 1M — inverting the "never guess long" rule for the tier most likely to
    stay short. The prefix list is now `["haiku", "claude-haiku", "claude-opus-4-6",
    "claude-sonnet-4-6"]`: Haiku is matched as a whole family (which subsumes the dated 4.5 entry),
    while the 4.6 pair stays version-pinned because Opus 4.7 and 4.8 are 1M. (b) `isShortWindow`
    is exported and returned true for `claude-opus-4-6[1m]`, saved only by `contextWindowFor`'s
    earlier suffix check; the `[1m]` test now lives inside `isShortWindow`, matching the UI twin,
    so the next caller cannot be caught out.
11. ~~**`POST /chat` validated `effort` but not `model`.**~~ **Fixed.** `{"model":{"a":1}}` used to
    throw `model.includes is not a function` from inside the running turn, and `{"model":["x"]}`
    passed the window table and reached the SDK. Both write paths now share `isModelValue`,
    including a length cap.
12. ~~**Stored values were never re-checked on read.**~~ **Fixed.** `threads.json` is a plain file;
    an effort outside the enum used to reach `query({effort})`, where the CLI ignores it silently
    while the UI still showed Medium. Malformed stored values are now dropped on read (with a log)
    and degrade to the default, exactly as absent ones already did.
13. **No readback of the effort that actually ran — deferred.** `Settings.maxEffortLevel` and
    `modelSettings.<model>.maxEffortLevel` (`sdk.d.ts:8961, 8974`) clamp silently, lowest-wins
    across settings files, and gitbot loads `settingSources: ["user","project","local"]` — so a
    user's own `maxEffortLevel: "medium"` already clamps. With no transcript record and nothing
    reading the applied level back, a user can pick **Max**, see **Max** forever, and have every
    turn run at medium. The comment at `start-claude-code.ts` claiming the picker is "the only
    source" is true of `effortLevel` and `CLAUDE_CODE_EFFORT_LEVEL` but **not of the caps**.
    `SDKControlInitializeResponse.effort` (`sdk.d.ts:5975`) is the available readback — it reports
    "the effort level the session will send on its next request — after env overrides, session
    state, org caps and model-support downgrades", which is exactly what the footer claims.
    Deliberately not wired up yet.

### Decision-level findings not yet acted on

Not defects — consequences of settled decisions that the decisions may not have anticipated.

- **The meter re-sizes mid-turn for a window the running turn is not held to.** `threadContext`
  sizes from `thread.model`, so changing the model while a turn runs immediately re-sizes the meter,
  while the footer says "Applies from the next message in this conversation". The reading is right
  about the *next* turn and wrong about the one on screen. Same mechanism as items 8 and 14.
- ~~**Static-map staleness under-reports fullness, silently and in the harmful direction.**~~
  **Addressed by item 17:** the default is now 200k, so staleness over-reports (visible, reportable)
  rather than under-reports (silent). Item 9's logging remains the runtime correction when a turn
  runs. Still open as a cheap extra: `GET /claude-models` holds the live row list, so the server
  could log once for any row the table does not account for.
- **The process-wide `supportedModels()` cache assumes an account-level answer; the SDK says
  otherwise.** `sdk.d.ts:9391` says the list is narrowed by the folder's `availableModels`, and
  `modelPicker` (`:6861`) curates rows from managed, `--settings`/SDK **and user** settings. With
  `settingSources: ["user","project","local"]` the list is in principle per-folder, so the first
  turn's repo decides what every other thread's picker offers for the life of the process. Only
  bites with managed or curated settings, but the comment in `src/claude-models.ts` saying the list
  is "the account's rather than the session's" is not what the SDK documents.

14. ~~**The composer never consulted `bot.model`.**~~ **Fixed.** The server resolves a turn as
    `body ?? thread ?? bot ?? default`; the UI resolved `pick ?? thread ?? default`, so on a
    bot-pinned thread that had never been picked the trigger read "Default (recommended)" while the
    turn ran the bot's model and the meter sized from it — composer, meter and run all disagreeing,
    with greying computed against the wrong model. `botModel` is now threaded from the bot already
    in scope in `app-shell`, and the UI resolves the same four-step chain.
    **Accepted limitation, decided not overlooked:** there is no "inherit from the bot" row and
    `PATCH {model: null}` is still a 400, so the *first* pick on a bot-pinned thread writes
    `thread.model` permanently and the pin cannot be restored from the UI — only by editing the
    thread record. This was weighed against adding an inherit row and rejected; the composer now
    names the right model, which was the actual defect.
15. ~~**A malformed stored model made the thread unopenable.**~~ **Fixed.** `resolveThreadTurn`
    re-validated `thread.model` on the turn path, but `threadContext` passed it raw to the context
    helpers, so `GET /threads/:id/messages` returned 500 and the thread would not open at all.
    Hardened in three places, each of which a mutation test pins on its own:
    - `threadContext` validates `thread.model` and `bot.model` before using either;
    - `modelLabel` and `contextUsage` guard a non-string, not just a falsy one. The first attempt
      put the guard in `contextWindowFor` — the *sibling* of the function that actually throws —
      which left `contextUsage`, the one the meter calls, still loaded. `contextUsage` normalizes
      once so a non-string cannot reach `ContextUsage.model` either: that struct is serialized to
      the browser, which does its own string work on the field, so guarding only the throw would
      have moved the crash rather than removed it;
    - `loadTranscriptContext` validates `message.model` **where it is read**, not only downstream.
      That value is parsed JSONL written by another process and `entry` is `any`, so nothing
      type-checks it; it was dormant only because `threadContext` is the sole production caller and
      always passes a model of its own.
16. ~~**Window sizing ignored `resolvedModel`.**~~ **Fixed** in both mirrors. Rows were matched on
    `value` alone, so `default`/`opus`/`sonnet` were sized correctly only by luck: an alias row's
    name says nothing about its family, and any alias resolving to a 200k model was sized long and
    never greyed. Both strings are now consulted, and `contextWindowFor` falls back to the captured
    row list when the caller has no resolved id to hand.
17. ~~**"Unknown ⇒ 1M" was wrong for models that exist today.**~~ **Fixed by flipping the default:
    an unrecognised model is now treated as 200k.** `claude-opus-4-5`, `claude-sonnet-4-5`,
    `claude-opus-4-1` and `claude-3-5-haiku` are all 200k, missed both the set and the prefixes, and
    `supportedModels()` is plan-filtered, so another plan can be offered them with no build change.
    All four are now named explicitly as well, so today's models are right by name rather than by
    fallback. **Why this direction:** under-reporting fullness is silent — it never greys anything
    and surfaces nothing until a turn fails — whereas over-reporting is visible on the meter and a
    user can report it. **Known consequence:** a genuinely new 1M model reads as short and is
    greyed on a large thread until `LONG_WINDOW_MODELS` learns it. The current-pick exemption means
    a thread already on such a model is never locked out of its own row, and the tooltip for an
    unrecognised model says GitBot *assumes* the window rather than asserting the model is small.
18. ~~**Nits.**~~ **Fixed:** the greying threshold had zero headroom, so at 199k a 200k model was
    still offered while its own tooltip said the next turn could not fit — it now compares against
    the target model's window with a 0.9 margin. `modelRow` resolved `claude-opus-5-5` to the
    `default` row (two rows share that resolution) and is now deterministic, preferring a real model
    row over the recommendation pointer. `threadContext` now applies the Jarvis exception the other
    paths have. `MODEL_MAX_LENGTH`'s comment said 30 characters where it is 29.

### Known costs of the fixes above — recorded, not bugs

Both follow from decisions taken deliberately in items 16 and 17. Neither is being unpicked.

- **`contextWindowFor` reads process-wide state, so the same thread's meter can change after the
  first turn.** When the caller supplies no `resolvedModel`, the function falls back to the captured
  `supportedClaudeModels()` list (`src/context-window.ts`) — which is empty until a turn has run in
  this process. So an alias row that resolves to a known-long model reads **200k before any turn and
  1M after one**, with nothing else having changed. The direction is the safe one (it over-reports
  fullness, which is visible, rather than under-reporting, which is silent), and removing the
  fallback would partly reopen finding 16 — an alias whose name hides its family would go back to
  being sized long and never greyed. The cost is observable non-determinism and a pure-looking
  function coupled to a module-level cache. Pass `resolvedModel` explicitly where determinism
  matters; the tests do.
- **A genuinely new 1M model cannot be selected on a large thread until the table learns it.** With
  unrecognised models assumed short (item 17), every row the table does not know is blocked once a
  conversation is past the headroom threshold — so when Anthropic ships a model GitBot predates, it
  is offered but unselectable on exactly the long threads most likely to want it, until it is added
  to `LONG_WINDOW_MODELS` / `LONG_WINDOW_PREFIXES`. The current pick is exempt, so no thread is ever
  stranded on a model it cannot change away from, and the tooltip says the window is assumed rather
  than asserting the model is small. This is the accepted price of making staleness visible instead
  of silent.

### Raised in review and deliberately deferred

Seen, judged, and left alone on purpose — recorded so they are not rediscovered as news. Nothing
here is a defect; each is a cost the current design accepts.

- **A `runtimeWindow` miss is visible only in the server log, never in the UI.** The browser sees a
  window and cannot tell whether it came from the SDK or from the static table. Surfacing the
  distinction would mean a new field on the `context` event and somewhere in the meter to put it.
- **Eight style nits**, listed in the review: the now-used-by-tests `resetSupportedModels`, the
  test-only `SHORT_WINDOW` export, `EFFORT_OPTIONS[1]` encoding "medium" positionally, the unread
  `effort` on `GET /sessions/:id/config`, `liveClaudeModels` never being invalidated for a page kept
  open across a restart, `ClaudeModelInfo.description` being optional where the SDK's is required,
  the doubled `claudeControls` guard inside `composerFooter`, and `namingModel`'s
  `/\bmodel\b|\beffort\b/` gate over the combined message and stderr.
- **The meter's model chip reads "Default"** on every thread in the default state (known gap 6).
- **The `claudeQuery` test seam's shape** — installed at module load and restored in `after()` — and
  its uncovered paths: the `canUseTool` permission flow and the error/abort branches of `runAgent`
  are still untested through it.
