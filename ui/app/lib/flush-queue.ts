// The chat's "up next" slot, once the chat's own turn is over. gitbot can
// start a turn on the open thread by itself the moment the chat's turn ends:
// a child's report that waited for Jarvis (src/deferred-turns.ts), and later a
// scheduled run. Sending the queued message then would only get a 409 ("Session
// is already running"). So the server is asked first: a turn running there is
// joined, live, and the message stays queued until that turn ends, when the
// chat's next turn end comes back here. Kept free of React so it can be tested.

/** What GET /sessions/:id/status answers, as far as flushing cares. */
export type ServerTurn = { streaming: boolean; sdkSessionId: string | null; gitbotId?: string; seq?: number; pending?: string[] };

/** How long the chat waits for the status check before going ahead as if nothing ran. */
export const SERVER_TURN_TIMEOUT_MS = 2500;

/**
 * The status check, bounded: a stalled request (a half-dead connection)
 * answers null after `ms`, so a queued message is sent as before rather than
 * waiting in the tray for as long as the request hangs. An error is null too.
 */
export function serverTurnWithin(ask: () => Promise<ServerTurn | null>, ms = SERVER_TURN_TIMEOUT_MS): Promise<ServerTurn | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ask().then(
      (turn) => { clearTimeout(timer); resolve(turn); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

export interface FlushDeps {
  /** The queued message now, or null. Read again after every wait: the user may edit or remove it. */
  queued: () => string | null;
  /** Empties the queue (the slot and the tray). */
  take: () => void;
  /** The thread is locked on a Jarvis child: nothing may be sent. */
  locked: () => boolean;
  /** Still on this thread, and the chat is not already in a turn. */
  free: () => boolean;
  /** The thread's session as the server holds it, or null when it has none. */
  serverTurn: () => Promise<ServerTurn | null>;
  /** Joins the server's running turn on this thread. The queue is left as it is. */
  join: (turn: ServerTurn) => void;
  send: (text: string) => void;
  /** Puts the text back in the composer. */
  restore: (text: string) => void;
}

/**
 * - `none`: nothing to send, and no turn running to join.
 * - `restored`: the thread is locked; the queued message went back to the composer.
 * - `joined`: a turn gitbot started is running; the chat follows it, and any queued message waits.
 * - `sent`: the queued message started the chat's next turn.
 * - `left`: the user moved on or started a turn of their own; the queue is theirs to flush.
 *
 * The server is asked even with nothing queued: a turn that starts the
 * instant the chat's own ends can slip past the status stream unseen.
 */
export type FlushResult = "none" | "restored" | "joined" | "sent" | "left";

export async function flushQueue(d: FlushDeps): Promise<FlushResult> {
  let restored = false;
  const first = d.queued();
  if (first && d.locked()) {
    d.take();
    d.restore(first);
    restored = true;
  }
  const turn = await d.serverTurn().catch(() => null);
  if (!d.free()) return "left";
  if (turn?.streaming) {
    d.join(turn);
    return "joined";
  }
  const text = d.queued();
  if (!text) return restored ? "restored" : "none";
  // Locked while the server was asked (a child started meanwhile): same as above.
  if (d.locked()) {
    d.take();
    d.restore(text);
    return "restored";
  }
  d.take();
  d.send(text);
  return "sent";
}

export interface ConflictDeps {
  locked: () => boolean;
  /** Still on this thread. */
  here: () => boolean;
  serverTurn: () => Promise<ServerTurn | null>;
  /** Takes the refused message's bubble back and queues its text (ahead of anything queued since). */
  requeue: () => void;
  join: (turn: ServerTurn) => void;
  /** Takes the bubble back and returns the text to the composer, with the server's error. */
  giveBack: () => void;
}

/**
 * POST /chat answered 409. A turn gitbot started got in first (the user sent
 * at the instant it began): the message waits in the queue and the chat
 * joins that turn, so the user's words are never bounced back. Any other
 * refusal (a locked Jarvis thread, a bot that still needs setup) returns them
 * to the composer with the error, as before.
 */
export async function recoverConflict(d: ConflictDeps): Promise<"queued" | "returned" | "left"> {
  if (d.locked()) {
    d.giveBack();
    return "returned";
  }
  const turn = await d.serverTurn().catch(() => null);
  if (!d.here()) return "left";
  if (turn?.streaming && !d.locked()) {
    d.requeue();
    d.join(turn);
    return "queued";
  }
  d.giveBack();
  return "returned";
}
