#!/usr/bin/env node

process.on("SIGINT", () => {
  console.log();
  process.exit(0);
});

import { Command } from "commander";
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
  .option("-p, --port <port>", "bind this local port and serve the UI at http://localhost:<port> (implies --local)", "3000")
  .option("-l, --local", "bind a local port; combine with --relay to do both")
  .option("-r, --relay <url>", "connect to a relay server; on its own no local port is bound (e.g. wss://relay.example.com)", "wss://relay.codeongrass.com")
  .action(async (opts, command) => {
    // Both options carry defaults, so only an explicit flag counts as a choice:
    // nothing → local on 3000, -r alone → relay only, -r with -p/-l → both.
    const portFromUser = command.getOptionValueSource("port") !== "default";
    const relayFromUser = command.getOptionValueSource("relay") !== "default";
    const local = opts.local || portFromUser || !relayFromUser;
    const port = local ? Number(opts.port) : undefined;
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
      console.error("  --port must be a number between 1 and 65535");
      process.exit(1);
    }
    await start("local", port, opts.caffeinate ?? false, relayFromUser ? opts.relay : undefined);
  });

program.parse();
