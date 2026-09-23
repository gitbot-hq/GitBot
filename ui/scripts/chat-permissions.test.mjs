import assert from "node:assert/strict";
import test from "node:test";
import { postChat } from "../app/lib/api.ts";

test("chat permission choices send the matching session mode", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ sessionId: "test" }) };
  };

  try {
    for (const mode of ["ask-permissions", "allow-all-edits", "yolo", "plan"]) {
      await postChat("thread", "hello", mode);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ permissionMode, mode }) => [permissionMode, mode]), [
    ["ask-permissions", "build"],
    ["allow-all-edits", "build"],
    ["yolo", "build"],
    ["yolo", "plan"],
  ]);
});
