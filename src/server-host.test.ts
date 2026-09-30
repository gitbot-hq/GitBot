import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createHttpServer, findAvailablePort, getLocalIP, showQR } from "./server-common";

test("server binds to loopback by default and exposes LAN only when requested", async () => {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); };
  const lan = getLocalIP();
  const connect = (host: string, port: number) => new Promise<void>((resolve, reject) => {
    const req = http.get({ host, port, path: "/host-check", timeout: 2000 }, res => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("timeout", () => req.destroy(new Error("Connection timed out")));
    req.on("error", reject);
  });
  try {
    for (const host of [undefined, "0.0.0.0"]) {
      logs.length = 0;
      const { server, PORT } = await createHttpServer({ host, portOverride: 0, caffeinate: false, label: "test" });
      server.on("request", (_req, res) => {
        if (!res.headersSent) res.end("ok");
      });
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        assert.equal(address.address, host ?? "127.0.0.1");
        await connect("127.0.0.1", PORT);
        if (lan !== "localhost") {
          if (host) await connect(lan, PORT);
          else await assert.rejects(connect(lan, PORT), { code: "ECONNREFUSED" });
        }
        assert.ok(logs.some(line => line.includes(`http://${host ? lan : "127.0.0.1"}:${PORT}`)));
        assert.equal(await findAvailablePort(PORT, PORT + 1, host), PORT + 1);
      } finally {
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      }
    }
    logs.length = 0;
    await showQR("::1", 3000);
    assert.ok(logs.some(line => line.includes("http://[::1]:3000")));
  } finally {
    console.log = log;
  }
});
