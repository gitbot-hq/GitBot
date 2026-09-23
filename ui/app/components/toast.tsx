"use client";

import { useCallback, useState } from "react";

let id = 0;

// Toasts auto-dismiss after 2.4s, matching the original.
export function useToast() {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const toast = useCallback((text: string) => {
    const tid = ++id;
    setToasts((prev) => [...prev, { id: tid, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== tid));
    }, 2400);
  }, []);
  const view =
    toasts.length > 0 ? (
      <div aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    ) : null;
  return { toast, view };
}
