import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import webpush from "web-push";
import { latestLine, turnOutcome } from "./attention";
import { dataDir, getBot, getThread } from "./bot-store";
import { approvalLabel } from "./child-approvals";
import { isAskUserQuestion } from "./ask-user-question";
import { lastAssistantMessage } from "./reports";
import {
  isShuttingDown,
  jsonError,
  jsonOk,
  onTurnEnd,
  permissionsEmitter,
  readBody,
  sessions,
  type EndedTurn,
  type IRequest,
  type IResponse,
  type PermissionDumpItem,
} from "./server-common";

// Browser push notifications (Web Push). A browser that opted in from the UI
// gets a notification when a turn ends (done or failed) and when an agent
// stops to wait on an approval or a question. Push services (FCM, Mozilla,
// Apple) only relay: the payload is encrypted to the browser's keys, and the
// VAPID key pair below signs each request as coming from this gitbot.
//
// On unless GITBOT_PUSH=0. Until a browser subscribes there is nothing to send
// to, and nothing is sent.

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** Push is on unless GITBOT_PUSH turns it off. Read each time, so tests can flip it. */
export function pushEnabled(): boolean {
  return !OFF_VALUES.has((process.env.GITBOT_PUSH ?? "").trim().toLowerCase());
}

/** The VAPID subject when GITBOT_PUSH_SUBJECT gives none: the project's home. */
export const DEFAULT_PUSH_SUBJECT = "https://github.com/gitbot-hq/GitBot";

/** Hosts no push service can reach anyone at. */
function localHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
    !h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":")
  );
}

/**
 * True for a subject Apple's push service accepts: an https: URL or a
 * mailto: address on a real, public domain. Apple answers anything else,
 * `mailto:me@localhost` included, with 403 BadJwtToken.
 */
export function validPushSubject(subject: string): boolean {
  const mailto = /^mailto:[^@\s/?#]+@([^@\s/?#]+)$/i.exec(subject);
  if (mailto) return !localHost(mailto[1]);
  if (!/^https:\/\//i.test(subject)) return false;
  try {
    return !localHost(new URL(subject).hostname);
  } catch {
    return false;
  }
}

let warnedSubject: string | undefined;

/**
 * Who runs this push sender, for push services that need to reach someone
 * (GITBOT_PUSH_SUBJECT, e.g. mailto:you@example.com). One they would reject
 * is replaced by the default, with a warning, rather than breaking Safari.
 */
export function vapidSubject(): string {
  const configured = process.env.GITBOT_PUSH_SUBJECT?.trim();
  if (!configured) return DEFAULT_PUSH_SUBJECT;
  if (validPushSubject(configured)) return configured;
  if (warnedSubject !== configured) {
    warnedSubject = configured;
    console.warn(
      `[push] GITBOT_PUSH_SUBJECT=${configured} is not an https: URL or a mailto: address on a public domain; ` +
        `Apple would reject it, so using ${DEFAULT_PUSH_SUBJECT}`,
    );
  }
  return DEFAULT_PUSH_SUBJECT;
}

// --- Storage: two small files in the data directory, readable by the owner only ---

const vapidFile = () => join(dataDir(), "push-vapid.json");
const subscriptionsFile = () => join(dataDir(), "push-subscriptions.json");

/** Writes atomically, owner read/write only: the private key and the endpoints are secrets. */
function writePrivate(file: string, value: unknown): void {
  if (!existsSync(dataDir())) mkdirSync(dataDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err: any) {
    console.error(`[push] could not read ${file}: ${err.message}`);
    return undefined;
  }
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapidCache: VapidKeys | null = null;

/**
 * This gitbot's VAPID key pair, made on first use and kept. Replacing it
 * would orphan every subscription: each one is bound to the public key.
 */
export function vapidKeys(): VapidKeys {
  if (vapidCache) return vapidCache;
  const file = vapidFile();
  const stored = readJson(file) as Partial<VapidKeys> | undefined;
  if (typeof stored?.publicKey === "string" && typeof stored.privateKey === "string") {
    // Tighten a file someone loosened, or one copied in by hand.
    try {
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    } catch {}
    vapidCache = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    return vapidCache;
  }
  const keys = webpush.generateVAPIDKeys();
  writePrivate(file, { ...keys, createdAt: new Date().toISOString() });
  console.log(`  push: created VAPID keys in ${file}`);
  vapidCache = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  return vapidCache;
}

/** For tests: forget the cached keys, so the next read goes to disk. */
export function resetVapidCache(): void {
  vapidCache = null;
}

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
  userAgent?: string;
}

/** Enough for every browser one person uses; a cap so the file cannot grow without bound. */
export const MAX_SUBSCRIPTIONS = 50;

export function listSubscriptions(): StoredSubscription[] {
  const parsed = readJson(subscriptionsFile());
  return Array.isArray(parsed) ? (parsed as StoredSubscription[]) : [];
}

function saveSubscriptions(subs: StoredSubscription[]): void {
  writePrivate(subscriptionsFile(), subs);
}

const decodedLength = (s: string) => Buffer.from(s, "base64url").length;

/**
 * The push services browsers subscribe through, by host: exact names, and
 * suffixes (".x") that match true subdomains only. Every notification is sent
 * to the subscription's endpoint, so an endpoint anywhere else would let
 * whoever registered it read them (and would make gitbot POST to any host).
 */
const PUSH_SERVICES: { name: PushService; hosts: string[]; suffixes: string[] }[] = [
  { name: "Google", hosts: ["fcm.googleapis.com"], suffixes: [] },
  { name: "Mozilla", hosts: [], suffixes: [".push.services.mozilla.com"] },
  { name: "Apple", hosts: ["web.push.apple.com"], suffixes: [".push.apple.com"] },
  { name: "Microsoft", hosts: [], suffixes: [".notify.windows.com"] },
];

export type PushService = "Google" | "Mozilla" | "Apple" | "Microsoft";

/** The push service an endpoint belongs to, or null when it is not an https: URL on one. */
export function pushServiceOf(endpoint: string): PushService | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  for (const service of PUSH_SERVICES) {
    if (service.hosts.includes(host)) return service.name;
    if (service.suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return service.name;
  }
  return null;
}

/**
 * A browser's PushSubscription (its toJSON()), checked, or null. The endpoint
 * must be on a known push service, and the keys what the encryption needs: a
 * P-256 public key and a 16-byte secret.
 */
export function parseSubscription(raw: unknown): Pick<StoredSubscription, "endpoint" | "keys"> | null {
  if (!raw || typeof raw !== "object") return null;
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string" || endpoint.length > 2048) return null;
  if (!pushServiceOf(endpoint)) return null;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
  if (decodedLength(p256dh) !== 65 || decodedLength(auth) !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Thrown when a new browser subscribes while MAX_SUBSCRIPTIONS are already kept. */
export class SubscriptionLimitError extends Error {
  constructor() {
    super(
      `This gitbot already has ${MAX_SUBSCRIPTIONS} subscribed browsers. ` +
        "Delete one under Profile → Notifications, then try again.",
    );
  }
}

/**
 * Adds a subscription, or refreshes the one with the same endpoint (new keys
 * and user agent; it keeps its date). A new one past the cap is refused, not
 * made room for: evicting the oldest would let anyone push the user's out.
 */
export function addSubscription(sub: Pick<StoredSubscription, "endpoint" | "keys">, userAgent?: string): number {
  const subs = listSubscriptions();
  const existing = subs.find((s) => s.endpoint === sub.endpoint);
  if (!existing && subs.length >= MAX_SUBSCRIPTIONS) throw new SubscriptionLimitError();
  const ua = userAgent?.slice(0, 200) || existing?.userAgent;
  const entry: StoredSubscription = {
    ...sub,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(ua ? { userAgent: ua } : {}),
  };
  const next = existing ? subs.map((s) => (s === existing ? entry : s)) : [...subs, entry];
  saveSubscriptions(next);
  return next.length;
}

/** A subscription's id, safe to show: a hash of the endpoint, which is a secret. */
export function subscriptionId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

/** What the settings list shows for a subscription: no endpoint, no keys. */
export interface SubscriptionSummary {
  id: string;
  /** The push service, or null for an endpoint that is on none (saved before the check; never sent to). */
  service: PushService | null;
  /** "Chrome on macOS", from the user agent it subscribed with; null when none was saved. */
  device: string | null;
  /** When it first subscribed; null when not known. */
  addedAt: string | null;
  /** True for the browser that asked. */
  current: boolean;
}

/** "Chrome on macOS" from a User-Agent string, or null when it says nothing useful. */
export function describeUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  const os =
    /iPhone/.test(ua) ? "iPhone" :
    /iPad/.test(ua) ? "iPad" :
    /Android/.test(ua) ? "Android" :
    /CrOS/.test(ua) ? "ChromeOS" :
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" : null;
  const mobileApple = os === "iPhone" || os === "iPad";
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? "Edge" :
    /OPR\/|Opera/.test(ua) ? "Opera" :
    /Firefox\/|FxiOS\//.test(ua) ? "Firefox" :
    /SamsungBrowser\//.test(ua) ? "Samsung Internet" :
    /Chrome\/|CriOS\//.test(ua) ? "Chrome" :
    // The Home Screen app on iOS leaves "Safari" out of its user agent.
    /Safari\//.test(ua) || (mobileApple && /AppleWebKit\//.test(ua)) ? "Safari" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}

export function summarizeSubscriptions(currentEndpoint?: string): SubscriptionSummary[] {
  return listSubscriptions().map((s) => ({
    id: subscriptionId(s.endpoint),
    service: pushServiceOf(s.endpoint),
    device: describeUserAgent(s.userAgent),
    addedAt: typeof s.createdAt === "string" && !Number.isNaN(Date.parse(s.createdAt)) ? s.createdAt : null,
    current: currentEndpoint !== undefined && s.endpoint === currentEndpoint,
  }));
}

/** Removes the subscription with this id (see subscriptionId); true if it was there. */
export function removeSubscriptionById(id: string): boolean {
  const match = listSubscriptions().find((s) => subscriptionId(s.endpoint) === id);
  return match ? removeSubscriptions([match.endpoint]) : false;
}

/** Removes the subscriptions with these endpoints; true if any was there. */
export function removeSubscriptions(endpoints: readonly string[]): boolean {
  const gone = new Set(endpoints);
  const subs = listSubscriptions();
  const kept = subs.filter((s) => !gone.has(s.endpoint));
  if (kept.length === subs.length) return false;
  saveSubscriptions(kept);
  return true;
}

// --- Sending ---

/** What the service worker gets: enough to show the notification and open the thread. */
export interface PushPayload {
  title: string;
  body: string;
  /** One notification per thread: a newer one replaces the older. */
  tag: string;
  /** Where a click goes: the app, opened on the thread. */
  url: string;
  kind: "done" | "failed" | "approval" | "question" | "test";
  threadId?: string;
  botId?: string;
}

/** The send call. A seam: tests swap it to record instead of reaching a push service. */
export const pushSender = {
  send: (sub: StoredSubscription, payload: string, options: webpush.RequestOptions): Promise<unknown> =>
    webpush.sendNotification(sub, payload, options),
};

export interface SendResult {
  sent: number;
  failed: number;
  /** Subscriptions the push service said are gone (404/410), now dropped. */
  removed: number;
}

/** How long a push service holds a notification for a browser that is offline. */
const TTL_SECONDS = 60 * 60;

/** Sends one notification to every subscribed browser, dropping the ones that are gone. */
export function sendToAll(payload: PushPayload): Promise<SendResult> {
  return sendTo(listSubscriptions(), payload);
}

async function sendTo(subs: StoredSubscription[], payload: PushPayload): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, removed: 0 };
  // One saved before endpoints were checked may point anywhere: never send there.
  subs = subs.filter((s) => pushServiceOf(s.endpoint));
  if (!pushEnabled() || subs.length === 0) return result;
  const { publicKey, privateKey } = vapidKeys();
  const options: webpush.RequestOptions = {
    TTL: TTL_SECONDS,
    urgency: payload.kind === "approval" || payload.kind === "question" ? "high" : "normal",
    vapidDetails: { subject: vapidSubject(), publicKey, privateKey },
  };
  const body = JSON.stringify(payload);
  const gone: string[] = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await pushSender.send(sub, body, options);
        result.sent++;
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          gone.push(sub.endpoint);
        } else {
          result.failed++;
          console.error(`[push] ${new URL(sub.endpoint).host}: ${status ?? ""} ${err?.body || err?.message || err}`.trim());
        }
      }
    }),
  );
  if (gone.length && removeSubscriptions(gone)) result.removed = gone.length;
  return result;
}

function threadUrl(threadId?: string, botId?: string): string {
  if (!threadId) return "/";
  const params = new URLSearchParams({ thread: threadId });
  if (botId) params.set("bot", botId);
  return `/?${params}`;
}

// --- What is worth a notification ---

/**
 * The notification for a turn that ended, or null when it is not news worth
 * interrupting for: a turn the user stopped, one our own shutdown killed, or
 * a child's turn that reports to its Jarvis (the Jarvis turn the report
 * starts is the one to hear about; telling both would say it twice).
 */
export function turnEndNotification(turn: EndedTurn): PushPayload | null {
  if (isShuttingDown()) return null;
  if (!turn.threadId) return null;
  if (turn.reportable && turn.reportOwner) return null;
  const outcome = turnOutcome(turn);
  if (outcome === "stopped") return null;
  const thread = getThread(turn.threadId);
  if (!thread) return null;
  const botName = getBot(thread.botId)?.name ?? "Your bot";
  const line = latestLine(lastAssistantMessage(turn.events));
  const head = outcome === "failed" ? `${botName} hit an error` : `${botName} finished`;
  return {
    title: thread.title,
    body: line ? `${head}: ${line}` : head,
    tag: `thread-${thread.id}`,
    url: threadUrl(thread.id, thread.botId),
    kind: outcome === "failed" ? "failed" : "done",
    threadId: thread.id,
    botId: thread.botId,
  };
}

/** The notification for an approval or question that just appeared. */
export function approvalNotification(item: PermissionDumpItem): PushPayload {
  const store = sessions.get(item.sessionId);
  const thread = store?.threadId ? getThread(store.threadId) : undefined;
  const botId = thread?.botId ?? store?.botId;
  const botName = (botId ? getBot(botId)?.name : undefined) ?? "Your bot";
  const question = isAskUserQuestion(item.toolName, item.input);
  const label = approvalLabel(item.toolName, item.input);
  return {
    title: thread?.title ?? item.repoName,
    body: question ? `${botName} has a question: ${label}` : `${botName} needs your approval: ${label}`,
    tag: thread ? `thread-${thread.id}` : `session-${item.sessionId}`,
    url: threadUrl(thread?.id, botId),
    kind: question ? "question" : "approval",
    threadId: thread?.id,
    botId,
  };
}

function send(payload: PushPayload | null): void {
  if (!payload) return;
  sendToAll(payload).catch((err) => console.error(`[push] ${err?.message ?? err}`));
}

/**
 * Sends a notification on each turn end worth one, and on each approval or
 * question that appears, whichever agent asked. Call once at start. With
 * push off it does nothing (and makes no keys).
 */
export function watchPush(): () => void {
  if (!pushEnabled()) {
    console.log("  push: off (GITBOT_PUSH=0)");
    return () => {};
  }
  vapidKeys();
  const offTurnEnd = onTurnEnd((_store, turn) => {
    if (listSubscriptions().length === 0) return;
    try {
      send(turnEndNotification(turn));
    } catch (err: any) {
      console.error(`[push] thread ${turn.threadId}: ${err?.message ?? err}`);
    }
  });

  // The approvals broadcast carries every pending one each time; only those
  // not seen before are news. Kept up to date even with no one subscribed,
  // so a browser that subscribes later is not told about old ones.
  let pending = new Set<string>();
  const onUpdate = (permissions: PermissionDumpItem[]) => {
    const now = new Set<string>();
    const fresh: PermissionDumpItem[] = [];
    for (const item of permissions) {
      const key = `${item.sessionId}:${item.toolUseID}`;
      now.add(key);
      if (!pending.has(key)) fresh.push(item);
    }
    pending = now;
    if (fresh.length === 0 || isShuttingDown() || listSubscriptions().length === 0) return;
    for (const item of fresh) {
      try {
        send(approvalNotification(item));
      } catch (err: any) {
        console.error(`[push] approval ${item.toolUseID}: ${err?.message ?? err}`);
      }
    }
  };
  permissionsEmitter.on("update", onUpdate);
  return () => {
    offTurnEnd();
    permissionsEmitter.off("update", onUpdate);
  };
}

// --- Routes: /push/key, /push/subscribe, /push/unsubscribe, /push/test, /push/subscriptions[/delete] ---

function header(req: IRequest, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** host[:port], lowercased, without a default port (proxies differ on writing ":443"). */
function normalHost(host: string): string {
  return host.trim().toLowerCase().replace(/:(80|443)$/, "");
}

/**
 * False when a browser sent this request from another site: its Origin names
 * a host other than the one it reached. Behind a reverse proxy, a tunnel, or
 * the Next dev server, Host may be the upstream's (127.0.0.1:3000) while
 * X-Forwarded-Host keeps the one the browser used, so either may match. A web
 * page cannot set X-Forwarded-Host itself: it is no header the CORS preflight
 * allows. No Origin at all (curl, an old browser's same-origin request) passes.
 */
export function sameOriginRequest(req: IRequest): boolean {
  const origin = header(req, "origin");
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null": a sandboxed frame, a file: page
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const want = normalHost(url.host);
  const hosts = [header(req, "host"), ...(header(req, "x-forwarded-host")?.split(",") ?? [])];
  return hosts.some((h) => h !== undefined && h.trim() !== "" && normalHost(h) === want);
}

/** True for a JSON body (application/json, with or without a charset). */
function jsonContentType(req: IRequest): boolean {
  return (header(req, "content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

const POST_ROUTES = ["/push/subscribe", "/push/unsubscribe", "/push/test", "/push/subscriptions", "/push/subscriptions/delete"];

export async function handlePushRoutes(req: IRequest, res: IResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0];
  if (!path.startsWith("/push/")) return false;

  // The UI asks this first: with push off, it hides the control.
  if (method === "GET" && path === "/push/key") {
    if (!pushEnabled()) {
      jsonOk(res, { enabled: false, publicKey: null });
      return true;
    }
    jsonOk(res, { enabled: true, publicKey: vapidKeys().publicKey });
    return true;
  }

  if (method !== "POST" || !POST_ROUTES.includes(path)) return false;
  // gitbot has no login: these change who gets every notification, so only
  // its own pages may call them, never another site the user has open.
  if (!sameOriginRequest(req)) {
    jsonError(res, 403, "Push settings can only be changed from gitbot's own page");
    return true;
  }
  if (!jsonContentType(req)) {
    jsonError(res, 415, "Send JSON (Content-Type: application/json)");
    return true;
  }
  if (!pushEnabled()) {
    jsonError(res, 404, "Push notifications are off on this gitbot (GITBOT_PUSH=0)");
    return true;
  }
  const body = await readBody(req);

  if (path === "/push/subscribe") {
    const sub = parseSubscription(body?.subscription ?? body);
    if (!sub) {
      jsonError(res, 400, "Not a push subscription from a known push service");
      return true;
    }
    let count: number;
    try {
      count = addSubscription(sub, header(req, "user-agent"));
    } catch (err) {
      if (!(err instanceof SubscriptionLimitError)) throw err;
      jsonError(res, 409, err.message);
      return true;
    }
    jsonOk(res, { subscribed: true, count });
    return true;
  }

  // The list for settings. POST, so the asking browser's endpoint (to mark it
  // "this device") travels in the body rather than in a URL.
  if (path === "/push/subscriptions") {
    const current = typeof body?.endpoint === "string" ? body.endpoint : undefined;
    jsonOk(res, { subscriptions: summarizeSubscriptions(current) });
    return true;
  }

  if (path === "/push/subscriptions/delete") {
    if (typeof body?.id !== "string" || !body.id) {
      jsonError(res, 400, "id is required");
      return true;
    }
    jsonOk(res, { removed: removeSubscriptionById(body.id) });
    return true;
  }

  if (path === "/push/unsubscribe") {
    const endpoint = body?.endpoint ?? body?.subscription?.endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      jsonError(res, 400, "endpoint is required");
      return true;
    }
    jsonOk(res, { removed: removeSubscriptions([endpoint]) });
    return true;
  }

  // /push/test: to the one browser asking, when it says which; else to all.
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
  const subs = listSubscriptions();
  if (subs.length === 0 || (endpoint && !subs.some((s) => s.endpoint === endpoint))) {
    jsonError(res, 404, "This browser is not subscribed");
    return true;
  }
  const payload: PushPayload = {
    title: "gitbot",
    body: "Notifications are on. You'll hear when a thread finishes or needs you.",
    tag: "gitbot-test",
    url: "/",
    kind: "test",
  };
  jsonOk(res, await sendTo(endpoint ? subs.filter((s) => s.endpoint === endpoint) : subs, payload));
  return true;
}
