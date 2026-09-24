import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { CodexAppServer } from "./codex-app-server";

test("Codex app-server keeps an approval request open until its decision is returned", async () => {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const received: any[] = [];
  const client = new CodexAppServer(toServer, fromServer, (message) => received.push(message));
  const lines = createInterface({ input: toServer });
  const writes: any[] = [];
  lines.on("line", (line) => writes.push(JSON.parse(line)));

  const initialization = client.request("initialize", { clientInfo: { name: "gitbot" } });
  assert.equal(writes[0].method, "initialize");
  fromServer.write(`${JSON.stringify({ id: writes[0].id, result: { userAgent: "codex" } })}\n`);
  await initialization;

  fromServer.write(`${JSON.stringify({ id: 71, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" } })}\n`);
  assert.equal(received[0].method, "item/fileChange/requestApproval");
  assert.equal(writes.length, 1, "approval must not be answered before the user decides");
  client.respond(received[0].id, { decision: "accept" });
  assert.deepEqual(writes[1], { id: 71, result: { decision: "accept" } });

  client.close();
  lines.close();
});
