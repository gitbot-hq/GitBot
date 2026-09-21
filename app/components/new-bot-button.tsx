"use client";

import { useEffect, useRef, useState } from "react";
import { IconPlus } from "@tabler/icons-react";

// New-bot ghost button. The dashed frame is a measured SVG rect so the
// 8px / 4px dashes follow the rounded corners exactly at any width
// (a ResizeObserver keeps the viewBox 1:1 with the box).
export default function NewBotButton({ onClick }: { onClick?: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 188, h: 50 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setBox({
        w: Math.max(1, Math.round(r.width)),
        h: Math.max(1, Math.round(r.height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <button ref={ref} type="button" className="new-bot" onClick={onClick} aria-label="Add new bot" data-tip="Add new bot">
      <svg
        className="dash-frame"
        viewBox={`0 0 ${box.w} ${box.h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          x="0.75"
          y="0.75"
          width={box.w - 1.5}
          height={box.h - 1.5}
          rx="9"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.55"
          strokeWidth="1.5"
          strokeDasharray="6 4"
        />
      </svg>
      <IconPlus size={20} stroke={2} aria-hidden="true" />
    </button>
  );
}
