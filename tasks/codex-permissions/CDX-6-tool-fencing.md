# CDX-6 — Enforce bot allowedTools / disallowedTools

**Depends on:** CDX-4. **Status:** not started.

Today codex admits it cannot fence tools and emits a warning saying so
(`src/start-codex.ts:126-136`):

> Tool limits are not enforced on Codex. {bot} runs with every tool its sandbox
> allows.

The approval channel gives us a real interception point, so this becomes
enforceable.

## Benchmark

`allowListHooks()` (`src/start-claude-code.ts:207-225`) denies any tool not on
the list via a `PreToolUse` hook, with the reason
`"{bot} is only allowed these tools: …"`. Match that behaviour and that message.

## Build

Intercept every approval request **before** `shouldAutoApprove` and before the
user ever sees a card. If the mapped tool name is off-list, answer `decline`
(or `cancel` where `decline` is not offered) with the bot's reason, and emit
something the user can see — a silent decline is indistinguishable from the
model changing its mind.

Then delete the "not enforced" warning.

## The honest limitation

This is weaker than the claude-code hook, and the issue is not done until that
gap is written down accurately:

- Enforcement only reaches operations that **raise an approval**. In
  `yolo`/`danger-full-access` (`approvalPolicy: never`) nothing is raised, so
  nothing can be fenced.
- Codex's tool taxonomy is not Claude's. `commandExecution` maps to `Bash`,
  `fileChange` to `Edit`/`Write` — but a shell command can do anything, so
  `allowedTools: ["Read"]` does not mean what a user would assume. Decide and
  document whether the list matches our mapped names or codex's own, and say so
  in the UI.

Where fencing cannot hold, keep telling the truth — narrow the existing warning
to those cases rather than deleting it outright.

## Acceptance criteria

1. A bot with `allowedTools: ["Read"]` on codex: a shell command is declined
   with the bot's reason, visible in the transcript.
2. A bot with `disallowedTools: ["Bash"]`: same.
3. An on-list tool runs normally, still subject to the usual approval flow.
4. In `yolo` mode the limitation is surfaced rather than silently ignored.
5. The blanket "not enforced" warning is gone for cases now enforced, and
   retained — accurately worded — for cases that are not.
6. A bot with no tool lists is unaffected.

## Review focus (adversarial)

- **Fence bypass.** `allowedTools: ["Read"]` and the agent runs `cat` via a
  shell command — does the fence hold? If not, the UI must not claim it does.
- Ordering: fencing must precede auto-approve, or `yolo` silently disables it.
- Case sensitivity and trimming, matching `allowListHooks`' normalisation.
- MCP tool naming (`mcp__server__tool`) — consistent with the claude-code path?
- Does a declined-by-fence request still resolve the JSON-RPC request properly?
- Is the resulting user-facing claim about enforcement actually true in every
  mode?
