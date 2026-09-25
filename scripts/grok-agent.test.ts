import assert from "node:assert/strict";
import test from "node:test";
import { formatGrokMessage, grokArgs, messagesFromHistory, userQueryText } from "../src/start-grok";

test("plan mode is a read-only flag and does not auto-approve", () => {
  const args = grokArgs({
    prompt: "hi",
    cwd: "/work",
    mode: "plan",
    permissionMode: "yolo",
    model: "grok-4.5",
  });
  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args.includes("--always-approve"), false);
  assert.equal(args[args.indexOf("--model") + 1], "grok-4.5");
});

test("ask-permissions stays on the default flag, auto-approve is always-approve", () => {
  const ask = grokArgs({ prompt: "hi", cwd: "/work", permissionMode: "ask-permissions" });
  assert.equal(ask[ask.indexOf("--permission-mode") + 1], "default");
  assert.equal(ask.includes("--always-approve"), false);

  const yolo = grokArgs({ prompt: "hi", cwd: "/work", permissionMode: "yolo", sessionId: "sess-1" });
  assert.equal(yolo.includes("--permission-mode"), false);
  assert.ok(yolo.includes("--always-approve"));
  assert.equal(yolo[yolo.indexOf("--resume") + 1], "sess-1");
});

test("rules and tool fences are passed through", () => {
  const args = grokArgs({
    prompt: "hi",
    cwd: "/work",
    permissionMode: "ask-permissions",
    rules: "Stay in the job.",
    allowedTools: ["Read", "Grep"],
    disallowedTools: ["Bash"],
  });
  assert.equal(args[args.indexOf("--rules") + 1], "Stay in the job.");
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep");
  assert.equal(args[args.indexOf("--disallowed-tools") + 1], "Bash");
});

test("streaming messages become the same hub events Claude produces", () => {
  const init = formatGrokMessage({
    type: "system",
    subtype: "init",
    session_id: "sess-1",
    model: "grok-4.5",
    permissionMode: "plan",
  });
  assert.equal((init as { type: string }).type, "system");

  const assistant = formatGrokMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "PONG" }] },
  });
  assert.deepEqual(assistant, { type: "assistant", content: "PONG" });

  const tool = formatGrokMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file: "hello.txt" } }] },
  });
  assert.deepEqual(tool, { type: "tool_use", tool_name: "Read", tool_input: { file: "hello.txt" } });

  const result = formatGrokMessage({
    type: "result",
    subtype: "success",
    result: "PONG",
    total_cost_usd: 0.01,
    duration_ms: 12,
    num_turns: 1,
  });
  assert.deepEqual(result, {
    type: "result",
    subtype: "success",
    result: "PONG",
    cost: 0.01,
    duration_ms: 12,
    num_turns: 1,
  });
});

test("history keeps the user query and the assistant reply", () => {
  const raw = [
    JSON.stringify({ type: "system", content: "You are Grok." }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>Say PONG</user_query>" }] }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<system-reminder>ignore</system-reminder>" }] }),
    JSON.stringify({ type: "assistant", content: "PONG" }),
  ].join("\n");
  assert.equal(userQueryText([{ type: "text", text: "<user_query>Say PONG</user_query>" }]), "Say PONG");
  assert.deepEqual(messagesFromHistory(raw), [
    { role: "user", content: [{ type: "text", text: "Say PONG" }] },
    { role: "assistant", content: [{ type: "text", text: "PONG" }] },
  ]);
});
