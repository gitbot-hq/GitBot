import type { SessionStore } from "./server-common";
import { withJarvisReminder } from "./jarvis";
import { formatScheduleTag } from "./schedule-tag";

/**
 * The turn's prompt as the agent receives it: the message as gitbot shows it,
 * with the schedule tag on its first line when a schedule started the turn,
 * and Jarvis's turn reminder at its end on a Jarvis thread (saying, for a
 * scheduled turn, whether this Jarvis thread made the schedule). Neither is ever
 * part of the shown message. Without a schedule this is exactly what the
 * runner sent before the tag existed.
 */
export function agentPromptText(store: Pick<SessionStore, "scheduled" | "botPreset">, shown: string): string {
  let text = shown;
  if (store.scheduled) {
    const tag = formatScheduleTag(store.scheduled);
    text = shown ? `${tag}\n${shown}` : tag;
  }
  return store.botPreset?.jarvis ? withJarvisReminder(text, store.scheduled) : text;
}
