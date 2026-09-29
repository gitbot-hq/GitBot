# CDX-8 — The approval card is where a human is the security boundary

**Depends on:** CDX-1. **Status:** not started.

Found by physically testing CDX-1 in a browser. These are UI defects, and most
live in `ui/app/components/chat.tsx:1519-1553` — **shared by all three agents**,
so claude-code and opencode almost certainly have them too. Codex just made them
visible, because `untrusted` raises far more cards than anything did before.

## 1. A dead card stays on screen with live-looking buttons

Press Stop while a card is up. The card stays fully rendered with Allow / Deny /
Allow all. Clicking Allow fires **no HTTP request at all** and nothing happens —
no error, no disabled state, no explanation.

Two causes, both client-side:

- `chat.tsx:1017` — the `aborted` SSE handler never clears `perms`, so the entry
  keeps `verdict === undefined` forever.
- `chat.tsx:1208` — `answerPerm()` returns early on `if (!sid) return` once the
  session is over, which is why no request is sent.

The server side is clean: `GET /permissions/events` is empty immediately after
the abort, and a new session is unaffected. This is purely the user-facing half.

Fix: on `aborted` / `done`, mark unanswered cards as expired and render them as
such. A button that silently does nothing is worse than no button.

## 2. Long commands are clipped — the dangerous part scrolls off

`chat.tsx:1523` is `<pre>{JSON.stringify(p.input, null, 2)}</pre>`. Observed
live, cut off mid-string at the card edge with a horizontal scrollbar:

```
"command": "/bin/zsh -lc \"printf '%s\n' 'hello from ask mode' > not…
"reason": "Need write permission to create notes-ask.txt in the work…
```

The user is being asked to authorise a command whose target they cannot see
without scrolling sideways. On the one screen where the human *is* the security
boundary, that is a real defect, not cosmetic.

Fix: wrap rather than clip, and render the fields structurally instead of
dumping raw JSON — command, cwd, and reason are not equal in weight.

## 3. The card shows protocol noise

`"kind": "command"` appears on every codex card and means nothing to a user.
`kind` only matters when it is `writeStdin`, which CDX-1 already gives a distinct
headline. Show it only when it differs from the default.

The command is also duplicated: a `Bash …` tool row renders directly above the
card saying the same thing.

## 4. "Allow all" can report a verdict that never happened

`chat.tsx:1244-1248` infers a card's verdict from its *absence* from
`GET /permissions` after the PATCH, so it marks the card "Allowed" regardless of
what actually happened. CDX-1 fixed the server half — a dead client now resolves
`false` and logs it instead of fabricating an accept — but the UI still says
"Allowed Bash" for a command that never ran.

Fix: have PATCH return a per-card result, and render that.

## 5. Verdict notes render detached from their card

`Allowed Bash` / `Denied Bash` notes appear at the bottom of the whole
conversation, below the assistant's reply, rather than inline where the card
was. With several approvals in one turn you get a stack of orphaned lines with
nothing tying them to what they refer to.

## 6. `<turn_aborted>` leaks into the chat as a user message

After any Stop, reloading the transcript renders a bubble, styled as the user's
own message, containing the raw marker:

> `<turn_aborted>` The user interrupted the previous turn on purpose. Any running
> unified exec processes may still be running in the background… `</turn_aborted>`

`stripEnvelopes()` (`src/start-codex.ts:863-890`) already strips a list of these
envelopes from rollout text — `<turn_aborted>` is simply not on the list. One
line to add, and worth checking what else codex has started emitting.

## Acceptance criteria

1. Aborting with a card up leaves a visibly inert, explained card — not live
   buttons that do nothing.
2. A long command is fully readable without horizontal scrolling.
3. `kind` shows only when meaningful.
4. "Allow all" reports what actually happened.
5. Verdict notes sit where their card was.
6. No `<turn_aborted>` bubble after an abort.
7. claude-code and opencode cards are checked for 1, 2, 4 and 5 — the component
   is shared, so any fix should land for all three.

## Review focus (adversarial)

- Does clearing/expiring cards on abort break the rejoin path
  (`chat.tsx:728-746`), which replays only still-pending approvals?
- Does restructuring the card hide a field that mattered? The full input must
  stay reachable.
- Is the expired state distinguishable from a denied one?
- Does the envelope strip catch `<turn_aborted>` in transcripts already on disk?
