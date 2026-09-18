import WebSocket from "ws";
import { randomBytes } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { showRelayQR, setPushNotificationSender, relayTokenPath } from "./server-common";
import { handleRequest } from "./server";
import type { IRequest, IResponse } from "./server-common";
import type { RelayToGitbotFrame, GitbotToRelayFrame } from "./relay-types";

// --- RelayRequest ---
// Implements IRequest without depending on a real socket.
// The body is already available as a string from the WS frame.

class RelayRequest implements IRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;

  private _body: string;
  private _closeListeners: Array<() => void> = [];
  private _dataListeners: Array<(chunk: Buffer | string) => void> = [];
  private _endListeners: Array<() => void> = [];
  private _errorListeners: Array<(err: Error) => void> = [];

  constructor(method: string, url: string, headers: Record<string, string>, body: string) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this._body = body;
  }

  on(event: "close", listener: () => void): this;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    if (event === "close") this._closeListeners.push(listener as () => void);
    else if (event === "data") this._dataListeners.push(listener as (chunk: Buffer | string) => void);
    else if (event === "end") this._endListeners.push(listener as () => void);
    else if (event === "error") this._errorListeners.push(listener as (err: Error) => void);
    return this;
  }

  // Called by relay-client to deliver the body to readBody() callers
  emitBody(): void {
    if (this._body) {
      for (const fn of this._dataListeners) fn(this._body);
    }
    for (const fn of this._endListeners) fn();
  }

  // Called when the WS closes — notifies SSE listeners to detach
  emitClose(): void {
    for (const fn of this._closeListeners) fn();
  }
}

// --- RelayResponse ---
// Captures writeHead/write/end calls and forwards them as WS frames to the relay.

class RelayResponse implements IResponse {
  headersSent = false;
  writableEnded = false;

  private _requestId: string;
  private _ws: WebSocket;

  constructor(requestId: string, ws: WebSocket) {
    this._requestId = requestId;
    this._ws = ws;
  }

  private _send(frame: GitbotToRelayFrame): void {
    if (this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(frame));
    }
  }

  writeHead(statusCode: number, headers?: Record<string, string>): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this._send({ requestId: this._requestId, type: "response_start", statusCode, headers: headers ?? {} });
  }

  write(chunk: string): void {
    if (this.writableEnded) return;
    this._send({ requestId: this._requestId, type: "data", chunk });
  }

  end(chunk?: string): void {
    if (this.writableEnded) return;
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this._send({ requestId: this._requestId, type: "end" });
  }
}

// --- Token persistence ---

async function loadOrCreateToken(workspaceCwd: string): Promise<string> {
  const tokenPath = relayTokenPath(workspaceCwd);
  try {
    const existing = (await readFile(tokenPath, "utf-8")).trim();
    if (existing.length >= 16) {
      return existing;
    }
    throw new Error("token too short");
  } catch {
    // File missing, unreadable, or invalid — generate a fresh one
    const token = randomBytes(32).toString("base64url");
    try {
      await writeFile(tokenPath, token, "utf-8");
    } catch (writeErr: any) {
      console.warn(`[relay] could not save token to ${tokenPath}: ${writeErr.message} (token will not persist across restarts)`);
    }
    return token;
  }
}

// --- startRelayMode ---

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export async function startRelayMode(
  relayUrl: string,
  availableAgents: string[],
  workspaceCwd: string,
): Promise<void> {
  // Normalise: accept http(s):// or ws(s):// — convert to ws(s)://
  const wsUrl = relayUrl
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");

  // Load or generate a stable token for this workspace — done once, reused across reconnects
  const token = await loadOrCreateToken(workspaceCwd);

  // Track active RelayRequests so we can fire their close listeners on WS disconnect
  const activeRequests = new Map<string, RelayRequest>();

  let backoff = BACKOFF_INITIAL_MS;
  let stopping = false;

  function connect(): void {
    if (stopping) return;

    const ws = new WebSocket(`${wsUrl}/grass-connect`);

    ws.on("open", () => {
      backoff = BACKOFF_INITIAL_MS;
      const registerFrame: GitbotToRelayFrame = { type: "register", token };
      ws.send(JSON.stringify(registerFrame));
      setPushNotificationSender((title, body, data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "push_notification", title, body, data } satisfies GitbotToRelayFrame));
        }
      });
    });

    ws.on("message", async (raw) => {
      let frame: RelayToGitbotFrame;
      try {
        frame = JSON.parse(raw.toString()) as RelayToGitbotFrame;
      } catch {
        return;
      }

      if (frame.type === "registered") {
        // Registration accepted — show QR for app to scan
        await showRelayQR(relayUrl, token);
        return;
      }

      if (frame.type === "register_error") {
        console.error(`[relay] registration rejected: ${frame.reason}`);
        stopping = true; // don't reconnect — token conflict won't resolve on its own
        ws.close();
        return;
      }

      if (frame.type === "request") {
        const { requestId, method, path, headers, body } = frame;

        const req = new RelayRequest(method, path, headers, body);
        const res = new RelayResponse(requestId, ws);

        activeRequests.set(requestId, req);

        // Deliver body asynchronously so handler can attach data/end listeners first
        setImmediate(() => req.emitBody());

        try {
          await handleRequest(req, res, availableAgents, workspaceCwd);
        } catch (err: any) {
          console.error(`[relay] unhandled error for requestId=${requestId}:`, err.message);
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
          if (!res.writableEnded) res.end(JSON.stringify({ error: "Internal server error" }));
        } finally {
          // Only remove from active map once the response is fully ended.
          // SSE responses stay active until res.end() is called by the event listener.
          if (res.writableEnded) {
            activeRequests.delete(requestId);
          }
        }
        return;
      }
    });

    ws.on("close", (code) => {
      setPushNotificationSender(null);
      // Notify all active SSE listeners so they detach from the session emitter
      for (const [id, req] of activeRequests) {
        req.emitClose();
        activeRequests.delete(id);
      }

      if (stopping) return;

      // Code 4000 means the relay evicted this connection because a newer one
      // registered with the same token — the new connection is already live, so
      // do NOT reconnect (that would evict the new connection and loop forever).
      if (code === 4000) return;

      setTimeout(() => {
        connect();
      }, backoff);

      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    });

    ws.on("error", (err) => {
      console.error(`[relay] ws error: ${err.message}`);
      // 'close' event fires after 'error', reconnect happens there
    });
  }

  // Handle graceful shutdown — stopping flag prevents reconnect loop
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  connect();

  // Keep process alive — relay mode has no HTTP server to hold the event loop open
  await new Promise<void>(() => {});
}
