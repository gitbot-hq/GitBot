import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { basename, join } from "path";
// What web-push resolves the endpoint's host with when it sends.
import { parse as legacyParse } from "url";
import webpush from "web-push";
import { errorLine, latestLine, turnOutcome } from "./attention";
import { dataDir, getBot, getThread } from "./bot-store";
import { askUserQuestionLabel, isAskUserQuestion } from "./ask-user-question";
import { decide, liveTabs, parsePresence, PresenceLimitError, presenceClock, recordPresence } from "./presence";
import { lastAssistantMessage } from "./reports";
import {
  isShuttingDown,
  jsonError,
  jsonOk,
  onTurnEnd,
  permissionsEmitter,
  readBody,
  sessions,
  turnReportsTo,
  type EndedTurn,
  type IRequest,
  type IResponse,
  type PermissionDumpItem,
} from "./server-common";

// Browser push notifications (Web Push). A browser that opted in from the UI
// gets a notification when an agent stops to wait on an approval or a
// question, and when a turn ends (done or failed), unless gitbot's open tabs
// say the user can already see it (src/presence.ts). Push services (FCM, Mozilla,
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

/** Every entry in the subscriptions file as written, valid or not. Never throws. */
function storedEntries(): unknown[] {
  try {
    const parsed = readJson(subscriptionsFile());
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    console.error(`[push] could not read ${subscriptionsFile()}: ${err?.message ?? err}`);
    return [];
  }
}

const isValidEntry = (s: unknown): s is StoredSubscription => parseSubscription(s) !== null;

let warnedInvalid = false;

/**
 * The stored subscriptions this gitbot accepts (parseSubscription). Read
 * only, and never throws: it runs inside event listeners. Entries that fail
 * the checks (saved by an older build that took any endpoint, or by a newer
 * one that knows a push service this one doesn't) are skipped, not deleted:
 * never sent to, not listed, not counted toward the cap, but left in the
 * file for whichever build can use them.
 */
export function listSubscriptions(): StoredSubscription[] {
  const entries = storedEntries();
  const valid = entries.filter(isValidEntry);
  if (valid.length !== entries.length && !warnedInvalid) {
    warnedInvalid = true;
    console.warn(
      `[push] skipping ${entries.length - valid.length} subscription(s) in ${subscriptionsFile()} that this gitbot does not accept`,
    );
  }
  return valid;
}

const endpointOf = (s: unknown): unknown => (s && typeof s === "object" ? (s as { endpoint?: unknown }).endpoint : undefined);

/**
 * Saves the valid subscriptions given, keeping the file's invalid entries as
 * they were, except one with the same endpoint as a valid one: that browser
 * has subscribed again, and two entries would mean two of every push.
 */
function saveSubscriptions(valid: StoredSubscription[]): void {
  const endpoints = new Set(valid.map((s) => s.endpoint));
  const kept = storedEntries().filter((s) => !isValidEntry(s) && !endpoints.has(endpointOf(s) as string));
  writePrivate(subscriptionsFile(), [...kept, ...valid]);
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

/**
 * The push service an endpoint belongs to, or null when it is not a plain
 * https: URL on one. web-push sends with the legacy url.parse(), which reads
 * some strings differently from WHATWG URL: "https:fcm.googleapis.com/x" is
 * fcm.googleapis.com to one and no host (so localhost) to the other. Only an
 * endpoint already in canonical form, which both read alike, is accepted:
 * exactly its own href, no port, no credentials, and one hostname to both.
 */
export function pushServiceOf(endpoint: string): PushService | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.href !== endpoint) return null;
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
  if (legacyParse(endpoint).hostname !== url.hostname) return null;
  const host = url.hostname;
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
  /** The push service. Always set: entries on no known service are never listed. */
  service: PushService;
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
    service: pushServiceOf(s.endpoint)!, // listSubscriptions() returns only entries on a known service
    device: describeUserAgent(s.userAgent),
    addedAt: typeof s.createdAt === "string" && !Number.isNaN(Date.parse(s.createdAt)) ? s.createdAt : null,
    current: currentEndpoint !== undefined && s.endpoint === currentEndpoint,
  }));
}

// Ids deleted from settings. A browser re-sends its subscription on each
// visit (in case this gitbot lost it); one deleted from another device must
// not come back that way, so its refresh is refused and it unsubscribes
// itself. Turning notifications on again from that browser clears the mark.
const deletedFile = () => join(dataDir(), "push-deleted.json");
const MAX_DELETED = 200;

function deletedIds(): string[] {
  const parsed = readJson(deletedFile());
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}

export function wasDeleted(endpoint: string): boolean {
  return deletedIds().includes(subscriptionId(endpoint));
}

function forgetDeleted(endpoint: string): void {
  const ids = deletedIds();
  const id = subscriptionId(endpoint);
  if (ids.includes(id)) writePrivate(deletedFile(), ids.filter((x) => x !== id));
}

/** Removes the subscription with this id (see subscriptionId); true if it was there. */
export function removeSubscriptionById(id: string): boolean {
  const match = listSubscriptions().find((s) => subscriptionId(s.endpoint) === id);
  if (!match) return false;
  writePrivate(deletedFile(), [...deletedIds().filter((x) => x !== id), id].slice(-MAX_DELETED));
  return removeSubscriptions([match.endpoint]);
}

/** Removes the subscriptions with these endpoints; true if any was there. */
export function removeSubscriptions(endpoints: readonly string[]): boolean {
  // Invalid entries too, by exact endpoint: /push/unsubscribe is the only way
  // to clear one from the app, since they are never listed.
  const gone = new Set<unknown>(endpoints);
  const entries = storedEntries();
  const kept = entries.filter((s) => !gone.has(endpointOf(s)));
  if (kept.length === entries.length) return false;
  writePrivate(subscriptionsFile(), kept);
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

/**
 * How long a push service holds a notification for a browser that is
 * offline. Needs-you a day, so a phone off overnight still hears that an
 * agent is blocked (a stale one opens a thread that shows it answered); news
 * of a turn's end an hour.
 */
export function ttlSeconds(kind: PushPayload["kind"]): number {
  return kind === "approval" || kind === "question" ? 24 * 60 * 60 : 60 * 60;
}

/** Sends one notification to every subscribed browser, dropping the ones that are gone. */
export function sendToAll(payload: PushPayload): Promise<SendResult> {
  return sendTo(listSubscriptions(), payload);
}

async function sendTo(subs: StoredSubscription[], payload: PushPayload): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, removed: 0 };
  // A backstop to the checks on subscribe and on load: never send to an
  // endpoint off the known push services, or one that web-push's url.parse()
  // would resolve to another host than WHATWG URL does (pushServiceOf checks both).
  subs = subs.filter((s) => pushServiceOf(s.endpoint));
  if (!pushEnabled() || subs.length === 0) return result;
  const { publicKey, privateKey } = vapidKeys();
  const options: webpush.RequestOptions = {
    TTL: ttlSeconds(payload.kind),
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
//
// Presence (src/presence.ts) decides: nothing is pushed about what the user
// can already see. Needs-you goes out at once; finished and failed wait
// pushTiming.holdMs and are checked again, so a quick alt-tab, or a tab whose
// report arrives a moment late, doesn't buzz the phone. A held push lost to a
// restart is lost: acceptable for news that is only "it's done".

/** How long finished and failed are held before the second check, and how. A seam: tests run it by hand. */
export const pushTiming = {
  holdMs: 10_000,
  schedule(fn: () => void, ms: number): () => void {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** The Jarvis thread whose current turn this thread's session reports to, if any. */
function threadOwner(threadId: string): string | null {
  for (const store of sessions.values()) {
    if (store.threadId === threadId) {
      const owner = turnReportsTo(store);
      if (owner) return owner;
    }
  }
  return null;
}

/** Whether the user, where presence says they are, should hear about this now. */
export function worthSending(payload: PushPayload, now = presenceClock.now()): boolean {
  if (payload.kind === "test") return true;
  return decide(payload.kind, payload.threadId, liveTabs(now), now, threadOwner);
}

/**
 * The notification for a turn that ended, or null when it is not news worth
 * interrupting for: a turn the user stopped, one our own shutdown killed, or
 * a child's turn whose report reached its Jarvis (the Jarvis turn the report
 * starts is the one to hear about; telling both would say it twice). A child
 * whose report was refused (its Jarvis mid-turn) is told here, or never.
 *
 * reportDelivered is set by the report watcher (reports.ts), a turn-end
 * listener of its own: it must be registered before watchPush, as server.ts
 * does, so the flag is set by the time this reads it.
 */
export function turnEndNotification(turn: EndedTurn): PushPayload | null {
  if (isShuttingDown()) return null;
  if (!turn.threadId) return null;
  if (turn.reportable && turn.reportOwner && turn.reportDelivered) return null;
  const outcome = turnOutcome(turn);
  if (outcome === "stopped") return null;
  const thread = getThread(turn.threadId);
  if (!thread) return null;
  const botName = getBot(thread.botId)?.name ?? "Your bot";
  const failed = outcome === "failed";
  const line = failed ? errorLine(turn) : latestLine(lastAssistantMessage(turn.events));
  const head = failed ? `${botName} failed` : `${botName} finished`;
  return {
    title: thread.title,
    body: line ? `${head}: ${line}` : head,
    tag: `thread-${thread.id}`,
    url: threadUrl(thread.id, thread.botId),
    kind: failed ? "failed" : "done",
    threadId: thread.id,
    botId: thread.botId,
  };
}

const MAX_LABEL = 60;

function capLabel(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1).trimEnd()}…` : line;
}

/**
 * What an approval is for, short enough for a lock screen and never a whole
 * command (one can carry a token): the tool and the program it runs, with a
 * plain subcommand ("Bash: npm test…"); the tool and a file's name, not its
 * path; or a question's text. At most MAX_LABEL characters.
 */
export function shortApprovalLabel(toolName: string, input: unknown): string {
  if (isAskUserQuestion(toolName, input)) return capLabel(askUserQuestionLabel(input));
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const command = pick(i.command);
  if (command) {
    // Leading VAR=value words are settings, often secrets: skipped.
    const words = command.split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const shown = words.slice(0, 1);
    if (words[1] && /^[a-z][\w:.-]{0,19}$/i.test(words[1])) shown.push(words[1]);
    const more = words.length > shown.length;
    return capLabel(`${toolName}: ${shown.join(" ")}${more ? "…" : ""}`);
  }
  const file = pick(i.file_path) ?? pick(i.filePath) ?? pick(i.notebook_path) ?? pick(i.path);
  return capLabel(file ? `${toolName} ${basename(file)}` : toolName);
}

/** The tag an approval's notification goes under: its thread's, else its session's. */
function approvalTag(item: PermissionDumpItem): string {
  const threadId = sessions.get(item.sessionId)?.threadId;
  return threadId && getThread(threadId) ? `thread-${threadId}` : `session-${item.sessionId}`;
}

/**
 * The one notification for everything waiting in one thread (or thread-less
 * session): these items, all with the same approvalTag. One says what it is;
 * several are counted.
 */
export function approvalNotification(items: readonly PermissionDumpItem[]): PushPayload {
  const item = items[0];
  const store = sessions.get(item.sessionId);
  const thread = store?.threadId ? getThread(store.threadId) : undefined;
  const botId = thread?.botId ?? store?.botId;
  const botName = (botId ? getBot(botId)?.name : undefined) ?? "Your bot";
  const questions = items.filter((x) => isAskUserQuestion(x.toolName, x.input)).length;
  let body: string;
  if (items.length === 1) {
    const label = shortApprovalLabel(item.toolName, item.input);
    body = questions ? `${botName} asks: ${label}` : `${botName} needs approval: ${label}`;
  } else if (questions === items.length) {
    body = `${botName} has ${items.length} questions`;
  } else if (questions === 0) {
    body = `${botName} needs ${items.length} approvals`;
  } else {
    body = `${botName} needs you: ${items.length} waiting`;
  }
  return {
    title: thread?.title ?? item.repoName,
    body,
    tag: approvalTag(item),
    url: threadUrl(thread?.id, botId),
    kind: questions === items.length ? "question" : "approval",
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
 * question that appears, whichever agent asked. Call once at start, after
 * watchChildReports (see turnEndNotification). With push off it does nothing
 * (and makes no keys).
 */
export function watchPush(): () => void {
  if (!pushEnabled()) {
    console.log("  push: off (GITBOT_PUSH=0)");
    return () => {};
  }
  vapidKeys();

  // Held finished/failed pushes, by tag. Anything newer for the thread replaces one.
  const held = new Map<string, { cancel: () => void }>();
  const cancelHeld = (tag: string) => {
    held.get(tag)?.cancel();
    held.delete(tag);
  };
  const hold = (payload: PushPayload) => {
    cancelHeld(payload.tag);
    // Checked now and again after the hold: watched at either moment, it's not sent.
    if (!worthSending(payload)) return;
    const entry = { cancel: () => {} };
    held.set(payload.tag, entry);
    entry.cancel = pushTiming.schedule(() => {
      if (held.get(payload.tag) !== entry) return;
      held.delete(payload.tag);
      try {
        if (!isShuttingDown() && worthSending(payload)) send(payload);
      } catch (err: any) {
        console.error(`[push] thread ${payload.threadId}: ${err?.message ?? err}`);
      }
    }, pushTiming.holdMs);
  };

  const offTurnEnd = onTurnEnd((_store, turn) => {
    // Nothing here may throw into the emitter: the other listeners would miss the turn end.
    try {
      if (listSubscriptions().length === 0) return;
      const payload = turnEndNotification(turn);
      if (payload) hold(payload);
    } catch (err: any) {
      console.error(`[push] thread ${turn.threadId}: ${err?.message ?? err}`);
    }
  });

  // The approvals broadcast carries every pending one each time; only those
  // not seen before are news. Kept up to date even with no one subscribed,
  // so a browser that subscribes later is not told about old ones.
  let pending = new Set<string>();
  const notifyApprovals = (permissions: PermissionDumpItem[]) => {
    const now = new Set<string>();
    const freshTags = new Set<string>();
    const byTag = new Map<string, PermissionDumpItem[]>();
    for (const item of permissions) {
      const key = `${item.sessionId}:${item.toolUseID}`;
      now.add(key);
      let tag: string;
      try {
        tag = approvalTag(item);
      } catch (err: any) {
        console.error(`[push] approval ${item.toolUseID}: ${err?.message ?? err}`);
        continue;
      }
      byTag.set(tag, [...(byTag.get(tag) ?? []), item]);
      if (!pending.has(key)) freshTags.add(tag);
    }
    pending = now;
    if (freshTags.size === 0 || isShuttingDown() || listSubscriptions().length === 0) return;
    // One push per thread with something new, counting all it has waiting.
    for (const tag of freshTags) {
      try {
        const payload = approvalNotification(byTag.get(tag)!);
        if (!worthSending(payload)) continue;
        cancelHeld(tag);
        send(payload);
      } catch (err: any) {
        console.error(`[push] approvals ${tag}: ${err?.message ?? err}`);
      }
    }
  };
  // Wrapped whole: a throw here would stop the emit before the UI's live
  // update listener runs, and land in whichever notifyPermissionsChanged() caller fired it.
  const onUpdate = (permissions: PermissionDumpItem[]) => {
    try {
      notifyApprovals(permissions);
    } catch (err: any) {
      console.error(`[push] approvals: ${err?.message ?? err}`);
    }
  };
  permissionsEmitter.on("update", onUpdate);
  return () => {
    offTurnEnd();
    permissionsEmitter.off("update", onUpdate);
    for (const entry of held.values()) entry.cancel();
    held.clear();
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

const POST_ROUTES = ["/push/subscribe", "/push/unsubscribe", "/push/test", "/push/subscriptions", "/push/subscriptions/delete", "/push/presence"];

/** A presence report is a few short fields; anything bigger is not one. */
export const MAX_PRESENCE_BODY = 1024;

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
  if (path === "/push/presence" && Number(header(req, "content-length") ?? 0) > MAX_PRESENCE_BODY) {
    jsonError(res, 413, "Presence report too large");
    return true;
  }
  const body = await readBody(req);

  // A tab saying where the user is (src/presence.ts). Under /push/ for the
  // checks above: only gitbot's own page, JSON only, no CORS preflight
  // answered, so another site can't mute the user's notifications.
  if (path === "/push/presence") {
    const update = parsePresence(body);
    if (!update) {
      jsonError(res, 400, "Not a presence report");
      return true;
    }
    try {
      recordPresence(update);
    } catch (err) {
      if (!(err instanceof PresenceLimitError)) throw err;
      jsonError(res, 429, err.message);
      return true;
    }
    jsonOk(res, { ok: true });
    return true;
  }

  if (path === "/push/subscribe") {
    const sub = parseSubscription(body?.subscription ?? body);
    if (!sub) {
      jsonError(res, 400, "Not a push subscription from a known push service");
      return true;
    }
    // `refresh`: the page re-sending what the browser already has, not a click on Enable.
    if (body?.refresh === true && wasDeleted(sub.endpoint)) {
      jsonOk(res, { subscribed: false, deleted: true });
      return true;
    }
    if (body?.refresh !== true) forgetDeleted(sub.endpoint);
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
