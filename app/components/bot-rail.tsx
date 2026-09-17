import type { Bot } from "../lib/gitbot";
import BotAvatar from "./bot-avatar";

// Superleft rail: slim icon column. Hover (or keyboard focus) reveals
// the bot name via tooltip — the rail itself never widens.
export default function BotRail({
  bots,
  activeBotId,
  onSelect,
}: {
  bots: Bot[];
  activeBotId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="rail" aria-label="Bots">
      <span className="rail-mark" aria-hidden="true">
        g
      </span>
      {bots.map((bot) => (
        <button
          key={bot.id}
          className={bot.id === activeBotId ? "rail-btn active" : "rail-btn"}
          data-name={bot.name}
          onClick={() => onSelect(bot.id)}
          aria-label={bot.name}
          aria-current={bot.id === activeBotId ? "true" : undefined}
        >
          <BotAvatar bot={bot} size={52} />
        </button>
      ))}
    </nav>
  );
}
