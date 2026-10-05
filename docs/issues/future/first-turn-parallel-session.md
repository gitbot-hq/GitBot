# A second message during a thread's first turn starts a parallel session

Found in: spike 02 review. Affects gitbot today, not only Jarvis.

## Problem

On a thread's first turn `thread.sdkSessionId` is null, so `/chat` creates the session store under a random id (`src/server.ts`, the `existingId ?? randomUUID()` branch). When the agent reports its session id, `start-claude-code.ts` sets `store.sdkSessionId` and binds the thread, but the sessions map is never re-keyed. Every later `/chat` looks the store up by the SDK session id, misses, and creates a second store.

Consequences:

- The `409 Session is already running` guard only fires when the store is found. A second message sent while the first turn is still running is not refused:
  - before the agent's init, it starts a brand-new, unrelated session on the same thread;
  - after init, it resumes the same SDK session concurrently with the running turn.
- The session dump (`/permissions/events`) can list the same thread twice — a stale `done` entry and the live one.

## Likely fix

Look sessions up by thread id (one live store per thread), include `threadId` in the session dump, and call `notifyPermissionsChanged()` when init assigns the session id. Test: a second `/chat` on the same thread during the first turn gets 409.

## Update from the 06 review

Since 06, this is on the main path: the children panel exists to open a child that is mid-first-turn. If the user opens the child before the agent's init, the composer looks idle (rejoin keys on `sdkSessionId`, still null) and a send starts a parallel session on the same thread.

Cheap mitigation that doesn't fix the root cause: in `startTurn`, when `threadId` is set and the lookup by `existingId` misses, return the existing `409 Session is already running` if any store has `s.threadId === threadId && s.status === "running"`. Optionally let `/sessions/:id/status` and `/events` fall back to `s.threadId === id` so the UI can rejoin a first turn by thread id.

**Mitigation added in 06:** `startTurn` refuses with 409 when another store for the same thread is running. The root cause (keying) is still open.
