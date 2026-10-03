import { useEffect, useRef, useState } from "react";

/** Someone is looking at this tab: it is shown and its window has focus. */
function lookedAt(): boolean {
  return !document.hidden && document.hasFocus();
}

/**
 * Whether someone is looking at this tab: shown, and its window focused (a
 * browser left open in the background is not being read). `onReturn` runs
 * once each time that starts again, however many events say so.
 */
export function useTabVisible(onReturn?: () => void): boolean {
  const [visible, setVisible] = useState(true);
  const last = useRef<boolean | null>(null);
  const returned = useRef(onReturn);
  returned.current = onReturn;
  useEffect(() => {
    const update = () => {
      const now = lookedAt();
      const before = last.current;
      last.current = now;
      setVisible(now);
      if (now && before === false) returned.current?.();
    };
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return visible;
}
