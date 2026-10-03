import { useEffect, useState } from "react";

/**
 * Whether this tab is visible. `onReturn` runs each time someone comes back
 * to it: the tab shown again, or its window focused.
 */
export function useTabVisible(onReturn?: () => void): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => {
      const now = !document.hidden;
      setVisible(now);
      if (now) onReturn?.();
    };
    setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, [onReturn]);
  return visible;
}
