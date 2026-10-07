#!/usr/bin/env node

process.on("SIGINT", () => {
  console.log();
  process.exit(0);
});

import { Command } from "commander";
import { isIP } from "node:net";
import { start } from "./server";
import { resolveHost } from "./server-common";

const program = new Command();

program
  .name("gitbot")
  .description("gitbot — build and run AI bots on top of Claude Code and other coding agents")
  .version(require("../package.json").version);

program
  .command("start")
  .description("Start the bot hub — create bots, pick a repo, and run them in threads")
  .option("-c, --caffeinate", "run caffeinate for 8 hours to prevent sleep")
  .option("-p, --port <port>", "serve the UI on this port", "3000")
  .option("-l, --lan", "let devices on your network connect too (default: only this computer)")
  .option("--host <address>", "bind one specific IP address instead; overrides -l")
  .action(async (opts) => {
    const port = Number(opts.port);
    if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
      console.error("  --port must be a number between 1 and 65535");
      process.exit(1);
    }
    if (opts.host !== undefined && !isIP(opts.host)) {
      console.error("  --host must be an IPv4 or IPv6 address");
      process.exit(1);
    }
    await start(resolveHost({ lan: opts.lan, host: opts.host }), port, opts.caffeinate ?? false);
  });

program.parse();
