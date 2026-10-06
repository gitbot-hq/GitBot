import type { HistoryMsg, TodoItem } from "./gitbot";

/**
 * The plan the panel should show after loading a transcript.
 *
 * The last todos anywhere in the history — TodoWrite always writes the whole
 * list, so the last one written is the plan — or `prev` when the transcript
 * holds none. Seeding never clears: history reloads happen mid-turn as well as
 * on open (a quiet refresh, a rejoin), and the live stream runs ahead of the
 * transcript, so returning null there would blank a plan the agent is still
 * working through. A thread switch clears the panel explicitly instead.
 *
 * Sub-agent plans never reach here: the server leaves `todos` off a sidechain
 * tool call, so a Task's private list cannot stand in for the main agent's.
 */
export function nextPlan(
  prev: TodoItem[] | null,
  messages: readonly HistoryMsg[],
): TodoItem[] | null {
  let last: TodoItem[] | null = null;
  for (const m of messages) {
    for (const b of m.content || []) if (b.todos) last = b.todos;
  }
  return last ?? prev;
}
