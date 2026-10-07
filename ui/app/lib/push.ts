// Browser push notifications, the client's part: the service worker
// (public/sw.js), the browser's PushManager subscription, and telling the
// server about it (api.ts). The server decides what is worth a notification
// (src/push.ts); this only turns them on and off for this browser.

import { getPushKey, pushSubscribe, pushTest, pushUnsubscribe } from "./api";
import { currentPushEnvironment, pushBlocker, type PushBlocker } from "./push-support";

export type PushState =
  /** This browser can't subscribe here; see PushBlocker for why. */
  | PushBlocker
  /** The gitbot server has push turned off (GITBOT_PUSH=0). */
  | "server-off"
  /** The user blocked notifications for this site in the browser. */
  | "denied"
  | "off"
  | "on";

const SW_URL = "/sw.js";

/** What stops this browser from subscribing, or null when nothing does. */
function blocker(): PushBlocker | null {
  if (typeof window === "undefined") return "unsupported";
  return pushBlocker(currentPushEnvironment());
}

/** The VAPID public key as the bytes PushManager wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const current = sub.options.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** This browser's subscription, if it has one. Registers nothing. */
async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Where this browser stands. When it is subscribed, the server is told again
 * (idempotent), so a server that dropped it, or lost its file, hears of it.
 */
export async function pushState(): Promise<PushState> {
  const blocked = blocker();
  if (blocked) return blocked;
  const { enabled, publicKey } = await getPushKey();
  if (!enabled || !publicKey) return "server-off";
  if (Notification.permission === "denied") return "denied";
  const sub = await currentSubscription();
  if (!sub || Notification.permission !== "granted") return "off";
  // Subscribed under another key (the server's keys were remade): stale.
  if (!sameKey(sub, keyBytes(publicKey))) return "off";
  await pushSubscribe(sub.toJSON());
  return "on";
}

/**
 * Turns notifications on for this browser. Call it from a click: browsers
 * only show the permission prompt in answer to one, and iOS only from a tap
 * in the installed app, with nothing awaited before the request.
 */
export async function enablePush(): Promise<PushState> {
  const blocked = blocker();
  if (blocked) return blocked;
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off";
  const { enabled, publicKey } = await getPushKey();
  if (!enabled || !publicKey) return "server-off";
  const key = keyBytes(publicKey);
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await pushSubscribe(sub.toJSON());
  return "on";
}

/** Turns notifications off for this browser, on both ends. */
export async function disablePush(): Promise<PushState> {
  const blocked = blocker();
  if (blocked) return blocked;
  const sub = await currentSubscription();
  if (sub) {
    // The server first: should the browser end fail, nothing more is sent anyway.
    await pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

/** Asks the server to push a test notification to this browser. */
export async function testPush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) throw new Error("This browser is not subscribed");
  await pushTest(sub.endpoint);
}

/** A thread a notification click asked the open app to show. */
export interface OpenThreadRequest {
  threadId: string;
  botId?: string;
}

/**
 * The thread a notification click opened this page on (`/?thread=…&bot=…`),
 * read once and removed from the address bar, so a reload does not reopen it.
 */
export function takeThreadFromUrl(): OpenThreadRequest | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const threadId = url.searchParams.get("thread");
  if (!threadId) return null;
  const botId = url.searchParams.get("bot") ?? undefined;
  url.searchParams.delete("thread");
  url.searchParams.delete("bot");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return { threadId, botId };
}

/** Calls back when a notification click asks this already-open app to show a thread. */
export function onOpenThreadMessage(callback: (req: OpenThreadRequest) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; threadId?: unknown; botId?: unknown } | null;
    if (data?.type !== "gitbot:open-thread" || typeof data.threadId !== "string") return;
    callback({ threadId: data.threadId, botId: typeof data.botId === "string" ? data.botId : undefined });
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
