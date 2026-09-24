import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { delimiter, join } from "node:path";
import { createSession, emitEvent, sessions } from "./server-common";
import { handleRequest } from "./server";
import { runAgent } from "./start-codex";

async function decide(sessionId: string, toolUseID: string, approved: boolean) {
  const request = Object.assign(new EventEmitter(), {
    method: "POST",
    url: `/sessions/${sessionId}/permission`,
    headers: {},
  });
  const response = {
    headersSent: false,
    writableEnded: false,
    status: 0,
    body: "",
    writeHead(status: number) { this.status = status; this.headersSent = true; },
    write(chunk: string) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; this.writableEnded = true; },
  };
  const handling = handleRequest(request, response, ["codex"], process.cwd());
  await new Promise<void>((resolve) => setImmediate(resolve));
  request.emit("data", JSON.stringify({ toolUseID, approved }));
  request.emit("end");
  await handling;
  return response;
}

for (const approved of [true, false]) {
  test(`Codex file approval ${approved ? "accepts" : "declines"} before the turn completes`, async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = `${join(__dirname, "..", "scripts", "fixtures")}${delimiter}${oldPath ?? ""}`;
    const store = createSession(`codex-approval-${approved}`, "codex", process.cwd());
    emitEvent(store, "user_prompt", { prompt: "Create gitbot-demo.md" });
    try {
      const running = runAgent(store);
      const permission = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Codex did not request file approval")), 2000);
        store.emitter.on("event", (event) => {
          if (event.type !== "permission_request") return;
          clearTimeout(timeout);
          assert.equal(event.toolName, "Write");
          assert.equal((event.input as any).changes[0].path, "gitbot-demo.md");
          resolve(String(event.toolUseID));
        });
      });
      assert.equal(store.status, "running", "the turn must pause for the answer");
      assert.ok(store.pendingPermissions.has(permission));
      const response = await decide(store.gitbotId, permission, approved);
      assert.equal(response.status, 200);
      assert.equal((await decide(store.gitbotId, permission, approved)).status, 409, "stale approval cannot be reused");
      await running;
      assert.equal(store.status, "done");
      assert.deepEqual(JSON.parse(String(store.events.find((event) => event.type === "assistant")?.content)), { decision: approved ? "accept" : "decline" });
      if (!approved) assert.equal(store.events.some((event) => event.type === "tool_use"), false, "declined edit must not appear as a completed write");
    } finally {
      process.env.PATH = oldPath;
      sessions.delete(store.gitbotId);
    }
  });
}

for (const [kind, toolName] of [["command", "Bash"], ["network", "Network"], ["permissions", "Permissions"]] as const) {
  test(`Codex ${kind} approval shows its scope and grants only the requested action`, async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = `${join(__dirname, "..", "scripts", "fixtures")}${delimiter}${oldPath ?? ""}`;
    const store = createSession(`codex-approval-${kind}`, "codex", process.cwd());
    emitEvent(store, "user_prompt", { prompt: `[${kind}] request` });
    try {
      const running = runAgent(store);
      const permission = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Codex did not request ${kind} approval`)), 2000);
        store.emitter.on("event", (event) => {
          if (event.type !== "permission_request") return;
          clearTimeout(timeout);
          assert.equal(event.toolName, toolName);
          if (kind === "network") assert.equal((event.input as any).host, "example.com");
          if (kind === "permissions") assert.deepEqual((event.input as any).requested.network, { enabled: true });
          resolve(String(event.toolUseID));
        });
      });
      assert.equal((await decide(store.gitbotId, permission, true)).status, 200);
      await running;
      const result = JSON.parse(String(store.events.find((event) => event.type === "assistant")?.content));
      assert.deepEqual(result, kind === "permissions" ? { permissions: { network: { enabled: true } }, scope: "turn" } : { decision: "accept" });
    } finally {
      process.env.PATH = oldPath;
      sessions.delete(store.gitbotId);
    }
  });
}

test("stopping Codex while approval is pending clears the request", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(__dirname, "..", "scripts", "fixtures")}${delimiter}${oldPath ?? ""}`;
  const store = createSession("codex-approval-abort", "codex", process.cwd());
  emitEvent(store, "user_prompt", { prompt: "Create gitbot-demo.md" });
  try {
    const running = runAgent(store);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Codex did not request approval")), 2000);
      store.emitter.on("event", (event) => {
        if (event.type !== "permission_request") return;
        clearTimeout(timeout);
        resolve();
      });
    });
    store.abortController?.abort();
    await running;
    assert.equal(store.pendingPermissions.size, 0);
    assert.equal(store.events.some((event) => event.type === "aborted"), true);
  } finally {
    process.env.PATH = oldPath;
    sessions.delete(store.gitbotId);
  }
});

test("Codex does not start a turn when its effective permissions differ", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(__dirname, "..", "scripts", "fixtures")}${delimiter}${oldPath ?? ""}`;
  process.env.GITBOT_TEST_CODEX_POLICY_MISMATCH = "1";
  const store = createSession("codex-policy-mismatch", "codex", process.cwd());
  emitEvent(store, "user_prompt", { prompt: "Create gitbot-demo.md" });
  try {
    await runAgent(store);
    assert.equal(store.status, "error");
    assert.match(String(store.events.find((event) => event.type === "error")?.message), /could not apply the selected permissions/);
    assert.equal(store.events.some((event) => event.type === "permission_request"), false);
  } finally {
    delete process.env.GITBOT_TEST_CODEX_POLICY_MISMATCH;
    process.env.PATH = oldPath;
    sessions.delete(store.gitbotId);
  }
});

test("Codex resumes an existing thread with approvals still enabled", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(__dirname, "..", "scripts", "fixtures")}${delimiter}${oldPath ?? ""}`;
  const store = createSession("codex-resume", "codex", process.cwd());
  store.sdkSessionId = "codex-test-thread";
  emitEvent(store, "user_prompt", { prompt: "Create gitbot-demo.md" });
  try {
    const running = runAgent(store);
    const permission = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Resumed Codex turn did not ask")), 2000);
      store.emitter.on("event", (event) => {
        if (event.type !== "permission_request") return;
        clearTimeout(timeout);
        resolve(String(event.toolUseID));
      });
    });
    assert.equal((await decide(store.gitbotId, permission, true)).status, 200);
    await running;
    assert.equal(store.status, "done");
    assert.equal(store.sdkSessionId, "codex-test-thread");
  } finally {
    process.env.PATH = oldPath;
    sessions.delete(store.gitbotId);
  }
});

test("Codex tool activity appears when an MCP call starts", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(__dirname, "..", "scripts", "fixtures")}${delimiter}${oldPath ?? ""}`;
  const store = createSession("codex-live-mcp", "codex", process.cwd());
  emitEvent(store, "user_prompt", { prompt: "[mcp] call" });
  try {
    await runAgent(store);
    const activity = store.events.filter((event) => event.type === "tool_use" || event.type === "tool_result");
    assert.deepEqual(activity.map((event) => event.type), ["tool_use", "tool_result"]);
    assert.equal(activity[0]?.tool_name, "mcp__cua_repl__js");
  } finally {
    process.env.PATH = oldPath;
    sessions.delete(store.gitbotId);
  }
});
