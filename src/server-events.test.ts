import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { handleRequest } from "./server";
import { createSession, emitEvent, sessions } from "./server-common";

test("event stream marks replay complete before live updates", async () => {
  const store = createSession("replay-boundary-test", "codex", process.cwd());
  emitEvent(store, "assistant", { content: "Already in history" });
  const request = Object.assign(new EventEmitter(), {
    method: "GET",
    url: `/events?sessionId=${store.gitbotId}`,
    headers: {},
  });
  const chunks: string[] = [];
  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write(chunk: string) { chunks.push(chunk); },
    end() { this.writableEnded = true; },
  };
  try {
    await handleRequest(request, response, ["codex"], process.cwd());
    emitEvent(store, "tool_use", { tool_name: "Bash", tool_input: "test" });
    const stream = chunks.join("");
    assert.match(stream, /event: assistant[\s\S]*event: replay_complete[\s\S]*event: tool_use/);
  } finally {
    request.emit("close");
    sessions.delete(store.gitbotId);
  }
});
