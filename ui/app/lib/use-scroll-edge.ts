"use client";

import { useEffect, useState, type RefObject } from "react";

/** Highlight the edge content is moving toward; clear it at that boundary. */
export function useScrollEdge(ref: RefObject<HTMLElement | null>, resetKey?: string | boolean) {
  const [edge, setEdge] = useState<"top" | "bottom" | null>(null);

  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    let previousTop = scroller.scrollTop;
    setEdge(null);

    function update() {
      if (!scroller) return;
      const top = Math.max(0, scroller.scrollTop);
      const remaining = scroller.scrollHeight - scroller.clientHeight - top;
      const delta = top - previousTop;
      previousTop = top;
      setEdge((current) => {
        const next = delta > 0.5 ? "top" : delta < -0.5 ? "bottom" : current;
        if (scroller.scrollHeight <= scroller.clientHeight + 1) return null;
        if (next === "top" && top <= 1) return null;
        if (next === "bottom" && remaining <= 1) return null;
        return next;
      });
    }

    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref, resetKey]);

  return edge;
}
