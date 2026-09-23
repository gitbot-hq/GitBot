import type { BotActivity } from '../components/bot-maker/registry';

/** Classify the existing chat status labels; unknown tools are simply working. */
export function chatMascotActivity(label: string | null): BotActivity | undefined {
  if (!label) return undefined;
  if (label === 'Thinking…' || label === 'Reconnecting…') return 'thinking';
  if (label === 'Waiting for your approval…') return 'listening';
  const tool = label.match(/^Running (.+?)…$/)?.[1].toLowerCase();
  if (tool && /^(read|read_file|readfile|grep|glob|webfetch|websearch|web_fetch|web_search)$/.test(tool)) return 'reading';
  return 'working';
}
