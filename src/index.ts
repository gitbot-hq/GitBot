#!/usr/bin/env node

process.on("SIGINT", () => {
  console.log();
  process.exit(0);
});

import { Command } from "commander";
import { isIP } from "node:net";
import { start } from "./server";

const program = new Command();

program
  .name("gitbot")
  .description("gitbot — build and run AI bots on top of Claude Code and other coding agents")
  .version(require("../package.json").version);

program
  .command("start")
  .description("Start the bot hub — create bots, pick a repo, and run them in threads")
  .option("-c, --caffeinate", "run caffeinate for 8 hours to prevent sleep")
  .option("-p, --port <port>", "bind this local port and serve the UI at http://localhost:<port>", "3000")
  .option("--host <address>", "IP address to bind; use 0.0.0.0 for LAN access", "127.0.0.1")
  .option("-t, --token", "require a one-time access link for browsers on the network")
  // Keep the flag so existing scripts continue to work.
  .option("-l, --local", "bind a local port (the default)")
  .action(async (opts) => {
    const port = Number(opts.port);
    if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
      console.error("  --port must be a number between 1 and 65535");
      process.exit(1);
    }
    if (!isIP(opts.host)) {
      console.error("  --host must be an IPv4 or IPv6 address");
      process.exit(1);
    }
    if (opts.token && (opts.host === "127.0.0.1" || opts.host === "::1")) {
      console.log("  note: -t only matters for network clients; this server is bound to loopback, so nothing else can connect anyway");
    }
    await start(opts.host, port, opts.caffeinate ?? false, opts.token === true);
  });

program.parse();
