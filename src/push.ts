import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
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

/**
 * Who runs this push sender, for push services that need to reach someone.
 * Must be a mailto: or https: URL (Apple rejects anything else).
 */
function vapidSubject(): string {
  const configured = process.env.GITBOT_PUSH_SUBJECT?.trim();
  if (configured && /^(mailto:|https:\/\/)/.test(configured)) return configured;
  return "https://github.com/gitbot-hq/GitBot";
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
const MAX_SUBSCRIPTIONS = 50;

export function listSubscriptions(): StoredSubscription[] {
  const parsed = readJson(subscriptionsFile());
  return Array.isArray(parsed) ? (parsed as StoredSubscription[]) : [];
}

function saveSubscriptions(subs: StoredSubscription[]): void {
  writePrivate(subscriptionsFile(), subs);
}

const decodedLength = (s: string) => Buffer.from(s, "base64url").length;

/**
 * A browser's PushSubscription (its toJSON()), checked, or null. The keys
 * must be what the encryption needs: a P-256 public key and a 16-byte secret.
 */
export function parseSubscription(raw: unknown): Pick<StoredSubscription, "endpoint" | "keys"> | null {
  if (!raw || typeof raw !== "object") return null;
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string" || endpoint.length > 2048) return null;
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
  if (decodedLength(p256dh) !== 65 || decodedLength(auth) !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Adds a subscription, or refreshes the one with the same endpoint. The newest are kept past the cap. */
export function addSubscription(sub: Pick<StoredSubscription, "endpoint" | "keys">, userAgent?: string): number {
  const others = listSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
  const entry: StoredSubscription = { ...sub, createdAt: new Date().toISOString(), ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}) };
  const next = [...others, entry].slice(-MAX_SUBSCRIPTIONS);
  saveSubscriptions(next);
  return next.length;
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

// --- Routes: /push/key, /push/subscribe, /push/unsubscribe, /push/test ---

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

  const routes = ["/push/subscribe", "/push/unsubscribe", "/push/test"];
  if (method !== "POST" || !routes.includes(path)) return false;
  if (!pushEnabled()) {
    jsonError(res, 404, "Push notifications are off on this gitbot (GITBOT_PUSH=0)");
    return true;
  }
  const body = await readBody(req);

  if (path === "/push/subscribe") {
    const sub = parseSubscription(body?.subscription ?? body);
    if (!sub) {
      jsonError(res, 400, "Not a push subscription");
      return true;
    }
    const ua = req.headers?.["user-agent"];
    const count = addSubscription(sub, typeof ua === "string" ? ua : undefined);
    jsonOk(res, { subscribed: true, count });
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
