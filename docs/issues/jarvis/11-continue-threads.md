# 11 · Jarvis continues existing threads

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

`send_to_thread(threadId, message)` — Jarvis sends a message into an existing gitbot thread, resuming its session. The thread keeps its bot and agent. It refuses a thread that is mid-turn.

Ownership: sending sets the thread's `reportTo` to the calling Jarvis thread, so its next turn end wakes Jarvis (slice 07) and locks the Jarvis thread (slice 08). When the user types in that thread themselves, `reportTo` is cleared and reports stop.

## Acceptance criteria

- [ ] Sending resumes the thread with the same bot and agent
- [ ] Mid-turn thread is refused with a clear message
- [ ] Jarvis takes ownership on send; the report arrives on turn end
- [ ] User typing in the thread clears ownership; no further reports
- [ ] Tests: ownership transitions; mid-turn refusal

## Blocked by

- 07
- 10
