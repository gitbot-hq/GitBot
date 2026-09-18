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
  .option("-l, --local", "bind a local port instead of connecting to the relay")
  .option("-r, --relay <url>", "connect to a relay server instead of binding a local port (e.g. wss://relay.example.com)", "wss://relay.codeongrass.com")
  .action(async (opts, command) => {
    // -p defaults to 3000; an explicit --relay still wins over that default.
    const portFromUser = command.getOptionValueSource("port") !== "default";
    const relayFromUser = command.getOptionValueSource("relay") !== "default";
    const port = opts.port && !(relayFromUser && !portFromUser) ? Number(opts.port) : undefined;
    if (port !== undefined && !Number.isInteger(port)) {
      console.error("  --port must be a number");
      process.exit(1);
    }
    const local = opts.local || port !== undefined;
    await start("local", port, opts.caffeinate ?? false, local ? undefined : opts.relay);
  });

program.parse();
