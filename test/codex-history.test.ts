import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { historyToolBlocks, loadTranscript } from "../src/start-codex";

// Rollouts live under CODEX_HOME/sessions, read when the loader runs.
const home = mkdtempSync(join(tmpdir(), "gitbot-codex-"));
process.env.CODEX_HOME = home;

function rollout(id: string, payloads: unknown[]): void {
  const dir = join(home, "sessions", "2026", "10", "07");
  mkdirSync(dir, { recursive: true });
  const lines = payloads.map((payload) => JSON.stringify({ type: "response_item", payload }));
  // Non-item lines sit among them in a real rollout.
  lines.unshift(JSON.stringify({ type: "session_meta", payload: { id } }));
  writeFileSync(join(dir, `rollout-2026-10-07T10-00-00-${id}.jsonl`), lines.join("\n"));
}

const say = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});

test("codex history keeps tool calls between the messages they ran between", async () => {
  rollout("t-order", [
    say("user", "fix it"),
    { type: "reasoning", summary: [], encrypted_content: "x" },
    say("assistant", "Looking first."),
    { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls", workdir: "/w" }), call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "a.txt" },
    { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "cat a.txt" }), call_id: "c2" },
    { type: "function_call_output", call_id: "c2", output: "hi" },
    say("assistant", "Now the edit."),
    {
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "c3",
      status: "completed",
      input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-hi\n+bye\n*** Add File: b.txt\n+new\n*** End Patch\n",
    },
    { type: "custom_tool_call_output", call_id: "c3", output: "Success." },
    say("assistant", "Done."),
  ]);
  const messages = await loadTranscript("t-order", "/w");
  const flat = messages.flatMap((m) =>
    m.content.map((b: any) => `${m.role}:${b.type === "text" ? b.text : `${b.tool_name}(${b.tool_input})`}`),
  );
  assert.deepEqual(flat, [
    "user:fix it",
    "assistant:Looking first.",
    "assistant:Bash(ls)",
    "assistant:Bash(cat a.txt)",
    "assistant:Now the edit.",
    "assistant:Edit(a.txt)",
    "assistant:Write(b.txt)",
    "assistant:Done.",
  ]);
});

test("codex tool calls are named as the live stream names them", () => {
  const one = (payload: unknown) => historyToolBlocks(payload).map((b) => `${b.tool_name}(${b.tool_input})`);
  assert.deepEqual(one({ type: "web_search_call", status: "completed", action: { type: "search", query: "q", queries: ["q"] } }), ["WebSearch(q)"]);
  assert.deepEqual(one({ type: "local_shell_call", action: { type: "exec", command: ["git", "status"] } }), ["Bash(git status)"]);
  assert.deepEqual(
    one({ type: "function_call", namespace: "mcp__node_repl", name: "js", arguments: '{"code":"1"}' }),
    ['mcp__node_repl__js({"code":"1"})'],
  );
  assert.deepEqual(
    one({ type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "a", status: "completed" }, { step: "b", status: "pending" }] }) }),
    ["TodoWrite([done] a, [open] b)"],
  );
  // A call without a live counterpart keeps its own name.
  assert.deepEqual(one({ type: "function_call", name: "view_image", arguments: '{"path":"/x.png"}' }), ['view_image({"path":"/x.png"})']);
  // Plumbing and outputs are not tool calls.
  for (const payload of [
    { type: "function_call", name: "write_stdin", arguments: '{"session_id":1}' },
    { type: "function_call_output", call_id: "c", output: "x" },
    { type: "tool_search_call", call_id: "c", arguments: {} },
    { type: "reasoning", summary: [] },
    { type: "web_search_call", action: { type: "open_page" } },
  ]) {
    assert.deepEqual(historyToolBlocks(payload), []);
  }
});
