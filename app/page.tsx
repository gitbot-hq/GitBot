"use client";

import { useState } from "react";
import BotRail from "./components/bot-rail";
import ChatPane from "./components/chat-pane";
import ThreadSidebar from "./components/thread-sidebar";
import type { Bot, Message, Thread } from "./lib/gitbot";

// ---------------------------------------------------------------------------
// MOCK DATA — same shape as the live server (see app/lib/gitbot.ts).
// Delete this block when the adapter (GET bots/threads/history) lands;
// components already take props, so nothing else changes.
// ---------------------------------------------------------------------------
const MOCK_BOTS: Bot[] = [
  {
    id: "046dbe0b-c451-4b8c-87b5-b5f5e403e3f9",
    name: "X-Bot",
    description: "Reads X and gives posts I can engage with",
    emoji: "🤖",
    instructions: "",
    permissionMode: "ask-permissions",
    agent: "codex",
    model: "gpt-5.6-luna",
  },
  {
    id: "3afa986a-7c50-4a0d-a1b8-ded638135e4d",
    name: "Test Bot",
    description: "Casual chatting",
    emoji: "🤖",
    instructions: "",
    permissionMode: "auto-approve",
    agent: "codex",
    model: "gpt-5.6-luna",
  },
];

const MOCK_THREADS: Thread[] = [
  { id: "t1", botId: MOCK_BOTS[0].id, title: "Launch replies" },
  { id: "t2", botId: MOCK_BOTS[0].id, title: "Thread style test" },
  { id: "t3", botId: MOCK_BOTS[1].id, title: "Hello world" },
];
// ---------------------------------------------------------------------------

export default function Home() {
  const [activeBotId, setActiveBotId] = useState(MOCK_BOTS[0].id);
  const [activeThreadId, setActiveThreadId] = useState(MOCK_THREADS[0].id);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});

  const bot = MOCK_BOTS.find((b) => b.id === activeBotId) ?? MOCK_BOTS[0];
  const threads = MOCK_THREADS.filter((t) => t.botId === bot.id);
  const thread =
    threads.find((t) => t.id === activeThreadId) ?? threads[0] ?? MOCK_THREADS[0];

  function selectBot(id: string) {
    setActiveBotId(id);
    const first = MOCK_THREADS.find((t) => t.botId === id);
    if (first) setActiveThreadId(first.id);
  }

  // Local-only echo so the layout is testable. Replaced by POST /chat.
  function send(text: string) {
    setMessages((prev) => ({
      ...prev,
      [thread.id]: [
        ...(prev[thread.id] ?? []),
        { id: `${Date.now()}`, role: "user", text },
      ],
    }));
  }

  return (
    <div className="shell">
      <BotRail bots={MOCK_BOTS} activeBotId={bot.id} onSelect={selectBot} />
      <ThreadSidebar
        bot={bot}
        threads={threads}
        activeThreadId={thread.id}
        onSelect={setActiveThreadId}
      />
      <ChatPane
        thread={thread}
        messages={messages[thread.id] ?? []}
        onSend={send}
      />
    </div>
  );
}
