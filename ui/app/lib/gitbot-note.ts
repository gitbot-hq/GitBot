// Notes gitbot prepends to the user's next message in a Jarvis thread
// (src/child-lock.ts), one per line, then a blank line:
//   [you stopped <bot> on <project>]
//   [<bot> on <project> was interrupted by a restart]
// They are for Jarvis, not the user: the user's own bubble shows only what
// they typed, live and from history.

const NOTE = /^\[(?:you stopped .+ on .+|.+ on .+ was interrupted by a restart)\]$/;

/** The user's message without gitbot's leading notes. */
export function stripGitbotNotes(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && NOTE.test(lines[i])) i++;
  if (i === 0) return text;
  return lines.slice(i).join("\n").replace(/^\n+/, "");
}
