# A child's report can arrive while Jarvis is still mid-turn

Found in: spike 02 review. Relevant once slice 07 (a finished child wakes Jarvis) exists.

## Problem

`docs/JARVIS.md` (Lock and wake) says neither user messages nor reports ever need a queue. That is not quite true: Jarvis's turn keeps generating after `start_thread` returns, and a child that fails fast (setup 409, agent unavailable, quick error) or finishes quickly can end before Jarvis's turn does. The report then hits a running Jarvis session — a 409, or, on Jarvis's first turn, the parallel-session hole in [first-turn-parallel-session.md](first-turn-parallel-session.md).

## Likely fix

There is at most one child per Jarvis thread, so at most one pending report: hold it in a single slot and deliver it when the Jarvis turn ends.

## Related, also from the spike

The design says the report fires on done, error, or aborted, and also that Stop does not wake Jarvis. Since only the user aborts, the simplest rule is: done and error wake Jarvis, aborted never does.

## Decision for slice 07 (2026-10-03): keep parked

Since 06, `startTurn` refuses a turn with 409 when the thread already has a running store. So a report that arrives while Jarvis is still mid-turn (e.g. a child that fails fast while Jarvis is still writing "I've started it") is **refused, dropped, and logged** on the server — the user checks the child themselves. Also decided for 07: done and error wake Jarvis; aborted never does.

Recommended fix when picked up: hold that one report in a single slot per Jarvis thread and deliver it when Jarvis's turn ends (~15 lines + a test). One child max per Jarvis thread means it's a slot, not a queue.
