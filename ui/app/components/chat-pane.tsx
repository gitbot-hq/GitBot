"use client";

import { useState } from "react";
import type { Message, Thread } from "../lib/gitbot";

// Chat pane: largest column. Presentational — messages in, onSend out.
// The future adapter wires onSend to POST /chat; nothing fetches here.
export default function ChatPane({
  thread,
  messages,
  onSend,
}: {
  thread: Thread;
  messages: Message[];
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  return (
    <main className="chat" aria-label="Chat">
      <header className="chat-head">
        <h1>{thread.title}</h1>
      </header>
      <section className="chat-body">
        {messages.map((message) => (
          <article
            key={message.id}
            className={
              message.role === "user" ? "bubble user" : "bubble assistant"
            }
          >
            {message.text}
          </article>
        ))}
        {messages.length === 0 && (
          <p className="chat-empty">
            New thread. Say hello — bot replies plug in next step.
          </p>
        )}
      </section>
      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${thread.title}…`}
          aria-label="Message"
        />
        <button type="submit" disabled={!draft.trim()}>
          ↑
        </button>
      </form>
    </main>
  );
}
