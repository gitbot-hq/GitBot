// gitbot's service worker: push notifications only.
//
// There is deliberately no "fetch" handler and no cache. Pages are served
// no-cache and hashed assets immutable (src/static-ui.ts), and that is what
// keeps an upgraded gitbot from showing its old UI; a worker that cached
// would undo it. This file only shows the notifications the server pushes
// (src/push.ts) and opens the thread one is about when it is clicked.

self.addEventListener("install", () => {
  // Nothing to set up: take over from an older version at once.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // Every push must show a notification: browsers penalise (Chrome) or
  // cancel (Safari) subscriptions that receive pushes silently.
  event.waitUntil(
    self.registration.showNotification(data.title || "gitbot", {
      body: data.body || "",
      // One notification per thread: a newer one replaces the older.
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      requireInteraction: data.kind === "approval" || data.kind === "question",
      data: { url: data.url || "/", threadId: data.threadId, botId: data.botId },
    }),
  );
});

/** True for the page that hosts the app shell, which can open a thread in place. */
function isAppPage(client) {
  const path = new URL(client.url).pathname;
  return path === "/" || path === "/index.html";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const ours = windows.filter((c) => new URL(c.url).origin === self.location.origin);
      // An open app tab switches to the thread in place, keeping its state.
      const app = ours.find((c) => c.focused && isAppPage(c)) || ours.find(isAppPage);
      if (app) {
        await app.focus();
        if (data.threadId) app.postMessage({ type: "gitbot:open-thread", threadId: data.threadId, botId: data.botId });
        return;
      }
      // Another gitbot page (the marketplace, say): take it to the thread.
      const other = ours[0];
      if (other) {
        try {
          const moved = await other.navigate(url);
          if (moved) {
            await moved.focus();
            return;
          }
        } catch {
          // Not ours to navigate (opened before this worker): open a new tab instead.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
