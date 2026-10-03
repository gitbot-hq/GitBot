// A child's report to its Jarvis thread arrives as a user message that opens
// with gitbot's header (src/reports.ts formatReport):
//   [<bot> · <project> · thread <id> · <done|error>]
//   <last message>
// The header is the only marker, so it is read both live and from history.

export type Report = {
  bot: string;
  project: string;
  threadId: string;
  status: string;
  message: string;
};

const HEADER = /^\[(.+?) · (.+) · thread ([\w-]+) · (done|error|aborted)\]\n?/;

/** The report a message carries, or null for anything the user wrote. */
export function parseReport(text: string): Report | null {
  const m = HEADER.exec(text);
  if (!m) return null;
  return { bot: m[1], project: m[2], threadId: m[3], status: m[4], message: text.slice(m[0].length).trim() };
}
