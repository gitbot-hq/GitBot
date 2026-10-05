# 07 · A finished child wakes Jarvis

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

When a child's turn ends — done, error, or aborted — and the child has `reportTo` set, gitbot takes the child's last top-level assistant message (same extraction as the setup verdict uses), caps it at about 4,000 characters, and starts a turn in the owning Jarvis thread with:

```
[<bot> · <project> · thread <id> · <done|error|aborted>]
<last message>
```

The report shows in the Jarvis thread as a compact report row, not as a user message. An open browser picks the turn up live (per slice 02's finding). Jarvis may answer the user or start the next child — so sequences work from here.

The child never knows about Jarvis.

## Acceptance criteria

- [ ] Child turn end with `reportTo` starts exactly one Jarvis turn with the report
- [ ] Child without `reportTo` triggers nothing
- [ ] Message extraction ignores sub-agent output; cap applied with a truncation note
- [ ] Report row renders in the Jarvis thread; live in an open browser, and on reload
- [ ] A two-step sequence (child A → Jarvis starts child B → report) works end to end
- [ ] Tests: extraction + cap; wake only when owned; report format

## Blocked by

- 02
- 06

## Notes from spike 02 (updated after 06)

- **The open tab doesn't notice a server-started turn.** The UI never subscribes to `/permissions/events`; rejoin only runs when a thread is opened or switched to (the view-key effect in `chat.tsx`). Needs one app-level subscription that rejoins the open thread when its session goes `running`, and reloads history on `running → done` (short turns can finish before the tab reacts). 06 already reworked the rejoin (lookup by thread id, `/sessions/:id/status` returns `gitbotId`, `seq` and `pending`; replay vs live split by `seq`; live events always render) — reuse it rather than writing a second path.
- **Start report turns with `startTurn`** (`src/turns.ts`, extracted in 06), not a fake HTTP request. Report turns must not update the thread's preview or auto-title, and carry the `[Bot · project · thread <id> · status]` header so the UI renders them as a row.
- `seq` no longer resets per turn (06); `store.events` still does.
- A cheap guard in `startTurn` refuses a turn when another store for the same thread is running (409). A report that arrives while Jarvis is still mid-turn will hit this — see the parked [report collides with Jarvis's turn](../future/report-collides-with-jarvis-turn.md). Decide in this slice whether to drop such a report, retry once the turn ends, or park it (user previously said to ignore the collision for now).
- Parked: [first-turn parallel session](../future/first-turn-parallel-session.md).
