import { test } from "node:test";
import assert from "node:assert/strict";
import { flushQueue, recoverConflict, serverTurnWithin, SERVER_TURN_TIMEOUT_MS, type ConflictDeps, type FlushDeps, type ServerTurn } from "../ui/app/lib/flush-queue";

// The chat's queued follow-up, once its own turn has ended: a turn gitbot
// started there (a queued report, a schedule) is joined first, and the
// message is sent when that turn ends. Never a 409, never bounced back.

const running: ServerTurn = { streaming: true, sdkSessionId: "sdk-1", gitbotId: "g-1", seq: 4, pending: [] };
const idle: ServerTurn = { streaming: false, sdkSessionId: "sdk-1", gitbotId: "g-1", seq: 9, pending: [] };

/** A chat as flushQueue sees it, recording what it did, in order. */
function chat(opts: { queue?: string | null; locked?: boolean; server?: ServerTurn | null | Error } = {}) {
  const log: string[] = [];
  const state = { queue: opts.queue === undefined ? "and then?" : opts.queue, locked: !!opts.locked, inTurn: false, here: true };
  let answer = opts.server === undefined ? idle : opts.server;
  const deps: FlushDeps = {
    queued: () => state.queue,
    take: () => { log.push(`take ${state.queue}`); state.queue = null; },
    locked: () => state.locked,
    free: () => state.here && !state.inTurn,
    serverTurn: async () => {
      log.push("ask server");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    join: (turn) => { log.push(`join ${turn.gitbotId}`); state.inTurn = true; },
    send: (text) => { log.push(`send ${text}`); state.inTurn = true; },
    restore: (text) => { log.push(`restore ${text}`); },
  };
  return { deps, log, state, setServer: (t: ServerTurn | null) => { answer = t; } };
}

test("maybeFlush with a queued message and an unjoined server-started turn joins first, then sends", async () => {
  const c = chat({ server: running });
  assert.equal(await flushQueue(c.deps), "joined");
  assert.deepEqual(c.log, ["ask server", "join g-1"]);
  assert.equal(c.state.queue, "and then?", "still queued: not sent, not bounced back");
  // The joined turn ends; the chat's turn end comes back to flush.
  c.state.inTurn = false;
  c.setServer(idle);
  assert.equal(await flushQueue(c.deps), "sent");
  assert.deepEqual(c.log, ["ask server", "join g-1", "ask server", "take and then?", "send and then?"]);
  assert.equal(c.state.queue, null);
});

test("maybeFlush with no server-started turn sends the queued message at once", async () => {
  for (const server of [idle, null, new Error("offline")]) {
    const c = chat({ server });
    assert.equal(await flushQueue(c.deps), "sent");
    assert.deepEqual(c.log, ["ask server", "take and then?", "send and then?"]);
  }
});

test("maybeFlush on a locked thread returns the message to the composer at once, and still follows a turn gitbot started", async () => {
  const idleLocked = chat({ locked: true, server: idle });
  assert.equal(await flushQueue(idleLocked.deps), "restored");
  assert.deepEqual(idleLocked.log, ["take and then?", "restore and then?", "ask server"]);
  // A report turn bypasses the lock: it is joined like any other.
  const busyLocked = chat({ locked: true, server: running });
  assert.equal(await flushQueue(busyLocked.deps), "joined");
  assert.deepEqual(busyLocked.log, ["take and then?", "restore and then?", "ask server", "join g-1"]);
});

test("maybeFlush with nothing queued still asks the server, and joins a turn gitbot started", async () => {
  // The status stream can show "running" → "running" with nothing between, and miss it.
  const busy = chat({ queue: null, server: running });
  assert.equal(await flushQueue(busy.deps), "joined");
  assert.deepEqual(busy.log, ["ask server", "join g-1"]);
  for (const server of [idle, null, new Error("offline")]) {
    const c = chat({ queue: null, server });
    assert.equal(await flushQueue(c.deps), "none");
    assert.deepEqual(c.log, ["ask server"]);
  }
});

test("maybeFlush: a message sent while the server is asked goes behind nothing, and is sent", async () => {
  // Nothing queued at the turn end; the user sends while the server is asked (the chat queues it).
  const c = chat({ queue: null, server: idle });
  const asked = flushQueue(c.deps);
  c.state.queue = "typed meanwhile";
  assert.equal(await asked, "sent");
  assert.deepEqual(c.log, ["ask server", "take typed meanwhile", "send typed meanwhile"]);
});

test("maybeFlush: what changed while the server was asked wins", async () => {
  // The user started a turn of their own, or the chat already joined one: the queue is left for that turn's end.
  const busy = chat({ server: idle });
  const asked = flushQueue(busy.deps);
  busy.state.inTurn = true;
  assert.equal(await asked, "left");
  assert.equal(busy.state.queue, "and then?");
  assert.ok(!busy.log.some((l) => l.startsWith("send")));

  // The user removed the queued message meanwhile: nothing is sent.
  const removed = chat({ server: idle });
  const asked2 = flushQueue(removed.deps);
  removed.state.queue = null;
  assert.equal(await asked2, "none");
  assert.ok(!removed.log.some((l) => l.startsWith("send")));
  assert.deepEqual(removed.log, ["ask server"]);

  // The user edited it: the edited text is what goes.
  const edited = chat({ server: idle });
  const asked3 = flushQueue(edited.deps);
  edited.state.queue = "and then, edited?";
  assert.equal(await asked3, "sent");
  assert.deepEqual(edited.log, ["ask server", "take and then, edited?", "send and then, edited?"]);

  // The thread got locked meanwhile (the ended turn started a child).
  const locked = chat({ server: idle });
  const asked4 = flushQueue(locked.deps);
  locked.state.locked = true;
  assert.equal(await asked4, "restored");
  assert.deepEqual(locked.log, ["ask server", "take and then?", "restore and then?"]);

  // The user moved to another thread.
  const away = chat({ server: running });
  const asked5 = flushQueue(away.deps);
  away.state.here = false;
  assert.equal(await asked5, "left");
  assert.deepEqual(away.log, ["ask server"]);
});

/** A 409'd send as recoverConflict sees it. */
function conflict(opts: { locked?: boolean; server?: ServerTurn | null | Error } = {}) {
  const log: string[] = [];
  const state = { locked: !!opts.locked, here: true };
  const answer = opts.server === undefined ? running : opts.server;
  const deps: ConflictDeps = {
    locked: () => state.locked,
    here: () => state.here,
    serverTurn: async () => {
      log.push("ask server");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    requeue: () => log.push("requeue"),
    join: (turn) => log.push(`join ${turn.gitbotId}`),
    giveBack: () => log.push("give back"),
  };
  return { deps, log, state };
}

test("a send that loses the race to a server-started turn waits in the queue and follows that turn", async () => {
  const c = conflict({ server: running });
  assert.equal(await recoverConflict(c.deps), "queued");
  assert.deepEqual(c.log, ["ask server", "requeue", "join g-1"]);
});

test("any other 409 gives the words back with the error, as before", async () => {
  // A locked Jarvis thread.
  const locked = conflict({ locked: true });
  assert.equal(await recoverConflict(locked.deps), "returned");
  assert.deepEqual(locked.log, ["give back"]);
  // Nothing running there (a bot that still needs setup, say), or no answer.
  for (const server of [idle, null, new Error("offline")]) {
    const c = conflict({ server });
    assert.equal(await recoverConflict(c.deps), "returned");
    assert.deepEqual(c.log, ["ask server", "give back"]);
  }
  // The user moved on: their words already went to that thread's draft.
  const away = conflict({ server: running });
  const asked = recoverConflict(away.deps);
  away.state.here = false;
  assert.equal(await asked, "left");
  assert.deepEqual(away.log, ["ask server"]);
});

test("a status check that hangs or fails counts as nothing running: the queued message is sent as before", async () => {
  assert.ok(SERVER_TURN_TIMEOUT_MS >= 2000 && SERVER_TURN_TIMEOUT_MS <= 3000);
  const hang = () => new Promise<ServerTurn | null>(() => {});
  const c = chat();
  c.deps.serverTurn = () => serverTurnWithin(hang, 20);
  const started = Date.now();
  assert.equal(await flushQueue(c.deps), "sent");
  assert.ok(Date.now() - started < 1000, "not held for as long as the request hangs");
  assert.deepEqual(c.log, ["take and then?", "send and then?"]);

  // An error is the same; an answer in time is used as is.
  assert.equal(await serverTurnWithin(() => Promise.reject(new Error("offline")), 20), null);
  assert.equal(await serverTurnWithin(async () => running, 1000), running);
  // A late answer is ignored once the timeout has spoken.
  const late = await serverTurnWithin(() => new Promise((r) => setTimeout(() => r(running), 60)), 10);
  assert.equal(late, null);
});
