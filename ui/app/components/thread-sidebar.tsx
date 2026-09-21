import type { Bot, Thread } from "../lib/gitbot";
import BotAvatar from "./bot-avatar";

// Thread sidebar: threads for the active bot. Presentational —
// selection state and data come from props.
export default function ThreadSidebar({
  bot,
  threads,
  activeThreadId,
  onSelect,
}: {
  bot: Bot;
  threads: Thread[];
  activeThreadId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="threads" aria-label="Threads">
      <header className="threads-head">
        <BotAvatar bot={bot} size={32} />
        <div className="threads-title">
          <b>{bot.name}</b>
          <small>{bot.agent}</small>
        </div>
      </header>
      <p className="threads-label">Threads</p>
      <div className="threads-list">
        {threads.map((thread) => (
          <button
            key={thread.id}
            className={
              thread.id === activeThreadId ? "thread-row active" : "thread-row"
            }
            onClick={() => onSelect(thread.id)}
          >
            {thread.title}
          </button>
        ))}
        {threads.length === 0 && (
          <p className="threads-empty">No threads yet.</p>
        )}
      </div>
    </aside>
  );
}
