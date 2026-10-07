// Can this browser get push notifications here, and if not, what would let
// it? Kept free of imports so scripts/push-support.test.mjs can load it.

/** Why this browser can't subscribe at all, or null when it can. */
export type PushBlocker =
  /** Not HTTPS or localhost: no browser offers push to such a page. */
  | "insecure"
  /** iOS in a Safari tab: push exists only once added to the Home Screen. */
  | "needs-install"
  /** Installed on iOS, but older than 16.4, which brought web push. */
  | "ios-too-old"
  /** Any other browser without Web Push. */
  | "unsupported";

export interface PushEnvironment {
  secure: boolean;
  /** iPhone, iPod or iPad (iPadOS says it is a Mac, but has touch). */
  ios: boolean;
  /** Running as an installed Home Screen app. */
  standalone: boolean;
  /** serviceWorker, PushManager and Notification are all there. */
  hasApis: boolean;
}

export function pushBlocker(env: PushEnvironment): PushBlocker | null {
  if (!env.secure) return "insecure";
  if (env.hasApis) return null;
  if (env.ios) return env.standalone ? "ios-too-old" : "needs-install";
  return "unsupported";
}

/** True on iPhone, iPod and iPad, including iPadOS's desktop-class Safari. */
export function isIos(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return platform === "MacIntel" && maxTouchPoints > 1;
}

/** This browser's environment. Only call it in the browser. */
export function currentPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    secure: window.isSecureContext,
    ios: isIos(nav.userAgent, nav.platform, nav.maxTouchPoints ?? 0),
    standalone: nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true,
    hasApis: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
  };
}
