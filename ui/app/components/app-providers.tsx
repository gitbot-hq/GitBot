"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DEFAULT_USER_NAME, getUserPref, setUserPref, type UserPref } from "../lib/user-prefs";

const INITIAL_USER: UserPref = { name: DEFAULT_USER_NAME, email: "", bio: "", location: "", emailVerified: false, photo: null };
const ProfileContext = createContext({ user: INITIAL_USER, ready: false, saveUser: (_user: UserPref) => {} });
const NavigationContext = createContext<(href: string) => void>(() => {});

export function useUserProfile() { return useContext(ProfileContext); }
export function usePageNavigation() { return useContext(NavigationContext); }

export default function AppProviders({ children }: { children: ReactNode }) {
  const [user, setUser] = useState(INITIAL_USER);
  const [ready, setReady] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const fallback = useRef<{ animation: Animation; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pending = useRef<{ href: string; resolve: () => void; transition: ViewTransition; timer: ReturnType<typeof setTimeout> } | null>(null);

  useLayoutEffect(() => {
    setUser(getUserPref());
    setReady(true);
    function sync(event: StorageEvent) {
      if (event.key === "gitbot-user" || event.key === null) setUser(getUserPref());
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useLayoutEffect(() => {
    if (pending.current?.href === pathname) pending.current.resolve();
    if (fallback.current) {
      clearTimeout(fallback.current.timer);
      fallback.current.animation.cancel();
      fallback.current = null;
      const content = document.querySelector<HTMLElement>(".page-body");
      const animation = content?.animate(
        [{ opacity: 0.35, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      return () => animation?.cancel();
    }
  }, [pathname]);

  useLayoutEffect(() => () => {
    if (fallback.current) {
      clearTimeout(fallback.current.timer);
      fallback.current.animation.cancel();
      fallback.current = null;
    }
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current.resolve();
    pending.current.transition.skipTransition();
  }, []);

  const saveUser = useCallback((next: UserPref) => {
    setUser(next);
    setUserPref(next);
  }, []);

  const navigate = useCallback((href: string) => {
    if (href === pathname || pending.current || fallback.current) return;
    document.documentElement.dataset.routeNavigated = "true";
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      router.push(href);
      return;
    }
    if (!document.startViewTransition) {
      const content = document.querySelector<HTMLElement>(".page-body");
      if (!content) { router.push(href); return; }
      const animation = content.animate(
        [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0.35, transform: "translateY(-3px)" }],
        { duration: 90, easing: "ease-out", fill: "forwards" },
      );
      const current = { animation, timer: setTimeout(() => {
        animation.cancel();
        if (fallback.current === current) fallback.current = null;
      }, 1200) };
      fallback.current = current;
      void animation.finished.then(() => router.push(href), () => {});
      return;
    }
    let resolve = () => {};
    const committed = new Promise<void>((done) => { resolve = done; });
    const transition = document.startViewTransition(() => {
      router.push(href);
      return committed;
    });
    // A slow/failed route must never leave the old snapshot blocking the UI.
    const timer = setTimeout(() => { resolve(); transition.skipTransition(); }, 1200);
    const current = { href, resolve, transition, timer };
    pending.current = current;
    void transition.ready.catch(() => {});
    void transition.finished.catch(() => {}).finally(() => {
      clearTimeout(timer);
      if (pending.current === current) pending.current = null;
    });
  }, [pathname, router]);

  return <ProfileContext.Provider value={{ user, ready, saveUser }}>
    <NavigationContext.Provider value={navigate}>{children}</NavigationContext.Provider>
  </ProfileContext.Provider>;
}
