"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBots } from "./lib/api";

// Entry point: first-run users (no bots yet) get onboarding, everyone else
// lands in the app. Renders nothing — the layout's theme script has already
// painted the right background, so there's no flash while we decide.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    getBots().then(
      ({ bots }) => {
        if (!cancelled) router.replace(bots.length === 0 ? "/onboarding" : "/v2");
      },
      // Server unreachable or erroring: /v2 owns the error state.
      () => {
        if (!cancelled) router.replace("/v2");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
