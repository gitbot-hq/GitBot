import { useEffect } from "react";
import { attentionTitle } from "./attention";

// "(n) " in front of the tab title while n Jarvis threads need you. The
// chat's tab alerts (status-favicon.ts) also write the title; both go
// through titled(), so neither drops the other's part.

let needsYou = 0;

/** A title with the current "(n) " prefix, whatever it had before. */
export function titled(title: string): string {
  return attentionTitle(title, needsYou);
}

/** A title without any "(n) " prefix: what to keep as the original. */
export function untitled(title: string): string {
  return attentionTitle(title, 0);
}

function apply() {
  const next = titled(document.title);
  if (document.title !== next) document.title = next;
}

export function useAttentionTitle(count: number) {
  useEffect(() => {
    needsYou = count;
    apply();
  }, [count]);
  // Next.js writes the page's own <title> as it loads, which can land after
  // the count: put the prefix back whenever the title is rewritten.
  useEffect(() => {
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      needsYou = 0;
      document.title = untitled(document.title);
    };
  }, []);
}
