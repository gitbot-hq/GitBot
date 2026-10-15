// The schedule tag: how a scheduled turn's prompt tells the agent it is a
// schedule coming due. Only the agent ever sees it. gitbot keeps the prompt
// untagged everywhere else (title, preview, the user_prompt event, Jarvis's
// tools), and a transcript loader turns the tag back into the structured
// `scheduled` field, so the chat draws its chip from the field, never from
// text. Dependency-free on purpose: every loader can import it.

/** Which schedule a turn is, and its run number. */
export interface ScheduledTurn {
  id: string;
  name: string;
  run: number;
  /**
   * True when the thread it runs on is the Jarvis thread that made it, with
   * its own create_schedule tool (createdBy jarvis, that thread), and nobody
   * else has changed its words or re-armed it since (changedByOther). Only such a
   * prompt is the user's own earlier request to that Jarvis; any other
   * schedule (the API has no access guard yet, so an agent with a shell can
   * make one) is data to it. The tag says so with `by="you"`.
   */
  createdHere?: true;
}

/** An attribute value as the tag carries it: no quotes or angle brackets, one line. */
function attr(value: string): string {
  return value.replace(/["<>\r\n]/g, "");
}

/** `<gitbot-schedule id="…" name="…" run="N"/>`, with ` by="you"` when createdHere. */
export function formatScheduleTag(s: ScheduledTurn): string {
  const by = s.createdHere ? ` by="you"` : "";
  return `<gitbot-schedule id="${attr(s.id)}" name="${attr(s.name)}" run="${Math.floor(s.run)}"${by}/>`;
}

// Well-formed only: the three attributes (and by="you"), in this order, at the very start
// of the text, where agentPromptText (the only writer) puts it. Its own line
// break goes with it, so the prompt comes back exactly as sent. A tag
// anywhere else (quoted in a compaction summary or a report, pasted into a
// message) is someone's text, and is left as text.
const TAG = /^<gitbot-schedule id="([^"<>\r\n]*)" name="([^"<>\r\n]*)" run="(\d+)"( by="you")?\/>[ \t]*(?:\r?\n)?/;

/**
 * Removes the schedule tag from the start of the text and returns its
 * fields. Text that does not open with a well-formed tag comes back
 * unchanged, with no `scheduled`.
 */
export function parseScheduleTag(text: string): { text: string; scheduled?: ScheduledTurn } {
  const m = TAG.exec(text);
  if (!m) return { text };
  return {
    text: text.slice(m[0].length),
    scheduled: { id: m[1], name: m[2], run: Number(m[3]), ...(m[4] ? { createdHere: true as const } : {}) },
  };
}
