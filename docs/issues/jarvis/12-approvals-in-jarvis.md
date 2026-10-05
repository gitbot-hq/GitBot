# 12 · Approvals shown in the Jarvis thread

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

When a Jarvis-owned child is waiting on an approval, gitbot shows it in the Jarvis thread without waking Jarvis — the UI derives it from the existing global approvals stream.

- **A row in the conversation**, styled like Jarvis's messages but placed by gitbot: "⏸ **PR Validator** needs permission to run `npm test` · **Review**". Review switches the hub to the child with its approval card in view. The row updates in place once answered ("Approved: `npm test`" / "Denied: …"). Several approvals stack as rows and remain in the thread's history.
- **The locked composer** status changes to "PR Validator is waiting on your approval · Review".

Jarvis never approves. Rows must survive a reload (persisted alongside the Jarvis thread, or reconstructable).

## Acceptance criteria

- [ ] Approval in a child produces a row in its Jarvis thread, live
- [ ] Review opens the child with the approval card visible
- [ ] Row updates to approved / denied; stacked rows for successive approvals
- [ ] Composer status reflects waiting-on-approval
- [ ] No Jarvis turn is started by an approval
- [ ] Rows still shown after reload
- [ ] Tests: row state from a fixed approvals snapshot; no wake on approval

## Blocked by

- 08
