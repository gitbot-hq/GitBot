# 13 · Attention signals

Type: AFK

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

With several Jarvis threads, the one that needs you is findable from anywhere. Two states: **needs you** (a child of the thread is waiting on an approval) and **has news** (a Jarvis turn ended since you last viewed the thread).

Server:
- Add `threadId` to each session in the `GET /permissions/events` snapshot.
- `Thread.lastActivityAt`, set when a turn ends (not `updatedAt`, which renames bump).
- `Thread.lastSeenAt` and `POST /threads/:id/seen`, called when a thread is opened or receives events while open. Has news = `lastActivityAt > lastSeenAt`.

UI, all derived, no state of its own:
- Thread rows: amber marker for needs you, dot for has news; preview shows the latest line; needs-you threads sort to the top.
- Jarvis in the Bots panel: a count across its threads.
- Tab title: "(n) gitbot" while anything needs you.

No new stream, no new event types, no OS notifications.

## Acceptance criteria

- [ ] Snapshot carries `threadId`
- [ ] Has news set on turn end, cleared on view, consistent across two browsers
- [ ] Needs-you markers, sort, Jarvis count and tab title all correct from the stream
- [ ] Tests: unread rule from the two timestamps; UI derivation from a fixed snapshot

## Blocked by

- 07
- 12
