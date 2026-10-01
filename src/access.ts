import { randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";

/**
 * Optional access control for a gitbot server, enabled by `gitbot start -t`.
 *
 * Without the flag nothing here applies. With it, the server makes a one-time
 * bootstrap token and prints it in the network link and QR code. The first page
 * load that carries it is answered with a redirect to the same page without
 * it, plus an HttpOnly cookie holding a separate session token; the bootstrap
 * token is spent at that moment and refused everywhere afterwards. From then
 * on only the session cookie is accepted, on every route including the event
 * stream, which cannot carry custom headers. Requests arriving over loopback
 * stay exempt so the machine's own browser and scripts keep working.
 */

export const SESSION_COOKIE = "gitbot_session";
export const TOKEN_PARAM = "token";

export type AccessGuard = {
  /** False when the server was started without -t: every request passes. */
  enabled: boolean;
  /** The one-time bootstrap token to print, or null when disabled. */
  bootstrapToken: string | null;
  /** True once the bootstrap token has been exchanged. */
  bootstrapUsed: boolean;
  /** The URL to print and encode: carries the bootstrap token when enabled. */
  urlFor(base: string): string;
  /**
   * Runs the gate for one request. Returns true when the request may proceed.
   * Returns false when it has already been answered here (redirect or denial).
   * Safe to call from several listeners: the verdict is cached per request.
   */
  allow(req: http.IncomingMessage, res: http.ServerResponse): boolean;
};

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || a.startsWith("127.");
}

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const DENIED_HTML = `<!doctype html><meta charset="utf-8"><title>gitbot</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36em;margin:4em auto;padding:0 1em;color:#222}code{background:#eee;padding:2px 5px;border-radius:4px}</style>
<h1>This gitbot needs its access link</h1>
<p>This server was started with <code>gitbot start -t</code>, so it only answers the browser that opened the link it printed (or scanned its QR code). That link works once. If you have already used it on another device, restart gitbot to get a new one.</p>`;

export function createAccessGuard(opts: { enabled: boolean }): AccessGuard {
  const bootstrapToken = opts.enabled ? generateToken() : null;
  let sessionToken: string | null = null;
  const verdicts = new WeakMap<http.IncomingMessage, boolean>();

  function deny(req: http.IncomingMessage, res: http.ServerResponse, status: number, message: string): false {
    const wantsHtml = (req.headers.accept ?? "").includes("text/html");
    res.writeHead(status, {
      "Content-Type": wantsHtml ? "text/html; charset=utf-8" : "application/json",
      "Cache-Control": "no-store",
    });
    res.end(wantsHtml ? DENIED_HTML : JSON.stringify({ error: message }));
    return false;
  }

  function decide(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (bootstrapToken === null) return true;
    if (isLoopbackAddress(req.socket?.remoteAddress)) return true;

    const url = new URL(req.url ?? "/", "http://gitbot.invalid");
    const offered = url.searchParams.get(TOKEN_PARAM);
    if (offered !== null) {
      // The bootstrap token buys exactly one session. A second use, or a wrong
      // value, is refused — and it is never accepted as a session on its own.
      if (sessionToken !== null || !equal(offered, bootstrapToken)) {
        return deny(req, res, 403, "This access link has already been used or is not valid");
      }
      sessionToken = generateToken();
      url.searchParams.delete(TOKEN_PARAM);
      const location = url.pathname + (url.search || "") + (url.hash || "");
      res.writeHead(303, {
        Location: location,
        "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
        "Cache-Control": "no-store",
      });
      res.end();
      return false;
    }

    const presented = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (sessionToken !== null && presented !== null && equal(presented, sessionToken)) return true;
    return deny(req, res, 401, "Not signed in: open the link printed by `gitbot start -t`");
  }

  return {
    enabled: bootstrapToken !== null,
    bootstrapToken,
    get bootstrapUsed() { return sessionToken !== null; },
    urlFor(base) {
      return bootstrapToken === null ? base : `${base}/?${TOKEN_PARAM}=${bootstrapToken}`;
    },
    allow(req, res) {
      const cached = verdicts.get(req);
      if (cached !== undefined) return cached;
      const verdict = decide(req, res);
      verdicts.set(req, verdict);
      return verdict;
    },
  };
}
