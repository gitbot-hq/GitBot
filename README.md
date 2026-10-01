

| [![GitBot](ui/public/gitbot-logo.svg)](#gitbot) | [Overview](#gitbot) · [Get running](#get-running) · [Create a bot](#create-your-first-bot) · [How it works](#how-gitbot-works) · [Share](#share-a-bot-or-submit-one-to-marketplace) · [Security](#security-and-privacy) |
| :--- | ---: |

[![npm version](https://img.shields.io/npm/v/%40gitbot-hq%2Fgitbot?style=flat-square&label=npm)](https://www.npmjs.com/package/@gitbot-hq/gitbot)
[![npm downloads](https://img.shields.io/npm/dm/%40gitbot-hq%2Fgitbot?style=flat-square&label=downloads)](https://www.npmjs.com/package/@gitbot-hq/gitbot)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/github/license/gitbot-hq/GitBot?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/gitbot-hq/GitBot?style=flat-square&logo=github)](https://github.com/gitbot-hq/GitBot/stargazers)

<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/cover/dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="assets/cover/light.webp">
  <img alt="GitBot" src="assets/cover/light.webp">
</picture><br><br>



Create a bot once. Put your coding agents to work across your repos.

GitBot runs Claude Code, Codex, or OpenCode on your machine and gives each agent a reusable job, a place to work, and a conversation you can return to. You stay in control of its permissions.

```bash
npm install -g @gitbot-hq/gitbot
```

<br><br>

<picture><source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/hub.webp"><source media="(prefers-color-scheme: light)" srcset="assets/screenshots/hub-light.webp"><img src="assets/screenshots/hub-light.webp" alt="GitBot workspace with bots, threads, and a conversation"></picture>

<br><br><br>

## Get running

You'll need Node.js 18 or newer and at least one installed, signed-in coding agent. GitBot uses your existing agent login; it does not ask you to make a GitBot account.

| Agent | Before you start |
| --- | --- |
| Claude Code | Install and sign in to the `claude` CLI. |
| Codex | Install the `codex` CLI and run `codex login`. |
| OpenCode | Install the `opencode` CLI and configure a provider with `opencode auth login`. |

Install GitBot, then start it from the folder that holds your projects:

```bash
npm install -g @gitbot-hq/gitbot
cd /path/to/your/projects
gitbot start
```

Open **http://127.0.0.1:3000** on your computer. GitBot binds to localhost by default, so other devices cannot connect. For access from another device on a trusted network, run `gitbot start --host 0.0.0.0 -t`; GitBot then prints a network link that carries a one-time access token, and a QR code for it. Open that link (or scan the code) on the other device: it works once, that browser stays signed in until GitBot restarts, and every other browser on the network is refused. Without `-t`, anyone who can reach the port can use GitBot. The workspace works best on desktop.

> **Before connecting another device:** `-t` stops uninvited devices from reaching your agents. It does not encrypt the connection, so on a network you do not control, traffic can still be read or tampered with in transit. Keep it on a trusted network, never expose the port to the public internet, and use a VPN or TLS for anything more. [Read the security notes](#security-and-privacy).

<br><br><br>

## Create your first bot

A bot is a reusable set of instructions for a coding agent. You decide what it does, which agent runs it, and what it may do without asking.

<p align="center">
  <img src="assets/mascots/ghost.webp" width="80" alt="Ghost GitBot mascot">
  &nbsp;&nbsp;
  <img src="assets/mascots/star.webp" width="80" alt="Star GitBot mascot">
  &nbsp;&nbsp;
  <img src="assets/mascots/cat.webp" width="80" alt="Cat GitBot mascot">
</p>

1. In the **Bots** panel, select **+** and then **Create manually**.
2. Give the bot a **name** and a short **description** so you can recognize it later.
3. Choose an installed **agent**. Write the bot's standing job in **Instructions**.
4. Leave **Permissions** on **Ask before each tool** for Claude Code or OpenCode. For Codex, **Edit in the working directory** allows edits inside the selected folder; choose **Plan only** for read-only exploration. Add **Setup instructions** only if the bot needs to check or prepare something once on this machine.
5. Select **Create bot**. Open a new thread, choose the repo folder, and send your first message.

For a first bot, try instructions like these:

```text
You review the current repository for documentation that no longer matches the code.
Start by identifying one concrete mismatch. Explain it, propose a small fix,
and ask before editing files.
```

The instructions give the bot its job. Your message gives it today's task. A thread keeps that work together, so you can come back to it later.

| Choose how to create | Define the bot | Start a thread |
| --- | --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/create-menu.webp"><source media="(prefers-color-scheme: light)" srcset="assets/screenshots/create-menu-light.webp"><img src="assets/screenshots/create-menu-light.webp" alt="Create, generate, or import a bot from the Bots panel"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/create-bot-form.webp"><source media="(prefers-color-scheme: light)" srcset="assets/screenshots/create-bot-form-light.webp"><img src="assets/screenshots/create-bot-form-light.webp" alt="Create a bot with its name, agent, instructions, permissions, and mascot"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/create-thread.webp"><source media="(prefers-color-scheme: light)" srcset="assets/screenshots/create-thread-light.webp"><img src="assets/screenshots/create-thread-light.webp" alt="Choose a workspace and agent for a new thread"></picture> |

You can also choose **Create with an agent** and give an installed agent the guided authoring prompt, or **Import bot** if someone has shared a code with you. In both cases, review the bot's instructions and permissions before you let it work.

<br><br><br>

## See a bot at work

Choose a repo when you start a thread. The bot runs its agent in that folder and streams the conversation back to GitBot. You can close the browser tab and return to a running turn.

With Claude Code or OpenCode, GitBot shows an approval card when a tool requires permission. Codex has no per-action approval channel, so its selected permission mode chooses a sandbox instead.

![A GitBot working through a task in a conversation](assets/screenshots/gitbot-working.webp)

<br><br><br>

## How GitBot works

GitBot is a local server between your browser and the coding agents already installed on your machine:

```text
Browser  ->  GitBot on your machine  ->  Claude Code, Codex, or OpenCode
                  |                              |
                  +-- bots and threads           +-- works in your repo
```

- **Bots** hold reusable instructions, an agent choice, permissions, and optional setup steps.
- **Threads** are conversations with a bot in a chosen folder. Each thread stays with the agent that ran its first turn.
- **Setup steps** run in their own thread when a bot first needs preparation on a machine. The bot is not ready for regular work until setup is complete.
- **Your files stay on your machine.** Your chosen coding agent may send prompts and code to its configured provider. GitBot itself does not host the agent or your conversations.

<br><br><br>

## Share a bot, or submit one to Marketplace

**Share with code** copies the bot's settings and instructions so someone else can import it. It does not include chat history or local files. Check the instructions for private details before sharing.

**Publish to Marketplace** shows a prompt you can review and copy into a conversation with the bot. The bot can draft a public listing and prepare a pull request, but it must show you the listing and final diff and wait for your approval. Copying the prompt does not publish anything.

Prefer to submit a listing yourself? Open the [GitBot Library publishing guide](https://github.com/gitbot-hq/Library/blob/main/docs/publish-prompt.md). Marketplace bots live under `bots/<slug>/` in that repository and are reviewed through pull requests.

| Choose how to share | Share with code | Publish to Marketplace |
| --- | --- | --- |
| <picture><source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/share-menu.webp"><source media="(prefers-color-scheme: light)" srcset="assets/screenshots/share-menu-light.webp"><img src="assets/screenshots/share-menu-light.webp" alt="Share a bot with a code or publish it to Marketplace"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/share-code.webp"><source media="(prefers-color-scheme: light)" srcset="assets/screenshots/share-code-light.webp"><img src="assets/screenshots/share-code-light.webp" alt="Share a bot using its generated code"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/publish-marketplace.webp"><source media="(prefers-color-scheme: light)" srcset="assets/screenshots/publish-marketplace-light.webp"><img src="assets/screenshots/publish-marketplace-light.webp" alt="Publish a bot to Marketplace with an agent or manually"></picture> |

<br><br><br>

## Permissions and agent differences

Start with **Ask before tools** for Claude Code or OpenCode. For Codex, use **Read-only** when you do not want edits. Move to broader permissions only when you understand the bot's instructions and trust the repo it is working in. You can change a thread's permission mode from its chat bar. Codex and Plan changes apply from the next message; a broader Claude Code or OpenCode mode can also resolve approvals already waiting in the current reply.

| | Claude Code | OpenCode | Codex |
| --- | --- | --- | --- |
| Approval requests | When a tool requires it | When a tool requires it | No; the selected mode chooses a sandbox |
| Allowed or disallowed tool list | Yes | Yes | Not enforced |
| Resume threads and run setup steps | Yes | Yes | Yes |
| Model | Optional | Required as `provider/model` | Optional |

An **Allowed tools** list limits which tools a bot can use; its permission mode decides when to ask. Codex cannot enforce that list, so choose Claude Code or OpenCode when a strict tool fence matters.

<br><br><br>

## Security and privacy

> **Important:** GitBot binds to `127.0.0.1` by default, and there is no login: only programs on your own machine can connect. Using `--host 0.0.0.0` enables access on all IPv4 network interfaces, and on its own that means anyone who can reach the port can run agents with your machine's access. Add `-t` to require an access link: GitBot prints a one-time link, the first browser to open it is given a session cookie, the link is then dead, and every other request from the network is refused. Programs on the machine itself never need it. The session lasts until GitBot restarts; each start prints a new link. Treat the link like a password.
>
> **What `-t` does not do.** It is access control, not encryption. The link, the cookie and everything you type travel as plain HTTP, so on a café or office network someone in a position to watch or alter traffic can still read it, replay it, or impersonate the server. If that is a risk you care about, put GitBot behind something that encrypts the connection: a VPN or overlay network such as Tailscale, an SSH tunnel to the machine, or a reverse proxy that terminates TLS. Enable LAN access only on a trusted network, never expose the port to the internet, and stop GitBot when you are not using it.

Bots act with your user account's file and shell access. Auto-approval removes a chance to inspect individual tool calls. Imported bots may include setup instructions that run when imported, so read them and their permission mode first.

GitBot has no account, telemetry, or hosted database. Bots and thread records live under `~/.gitbot` by default. Your chosen agent sends prompts and code according to its provider configuration. GitBot uses local network interfaces to print its LAN address without looking up your public IP.

<br><br><br>

## Useful commands

```bash
gitbot start                 # use port 3000
gitbot start -p 4000         # choose another port
gitbot start --caffeinate    # keep a Mac awake during long jobs
gitbot start --host 0.0.0.0     # opt in to LAN access on a trusted network
gitbot start --host 0.0.0.0 -t  # same, but require the one-time access link GitBot prints
```

The folder where you run `gitbot start` becomes the workspace shown first in the folder picker. A thread can still run in another folder you can read.

`--host` accepts an IPv4 or IPv6 address. The default is `127.0.0.1`; use `::1` for IPv6 loopback or a specific interface address to limit where GitBot listens. The legacy `--local` flag remains accepted for compatibility.

`-t` (`--token`) generates a new access link on every start and only affects clients on the network; requests that arrive over loopback never need it, so this machine's own browser and local scripts keep working while the server is shared. The link admits one browser. To sign in another device, restart GitBot for a fresh link.

<br><br><br>

## Need help?

| If you see... | Try this |
| --- | --- |
| An agent is missing from the menu | Install and sign in to its CLI, then restart GitBot. |
| Port 3000 is already in use | Run `gitbot start -p 4000`. |
| An imported bot needs an agent you don't have | Install that agent or change the bot's agent. |
| The web UI has not been built | If running from source, run `npm run build`. |

For implementation details, see the [API reference](docs/API.md), [architecture notes](docs/ARCHITECTURE.md), [bot authoring prompt](docs/bot-author-prompt.md), and [web UI guide](ui/README.md).

<br><br><br>

## Contribute

GitBot is open source. For more than a small fix, [open an issue](https://github.com/gitbot-hq/GitBot/issues) first. Keep the change focused, run the build and TypeScript checks, and describe the behavior you tested in your pull request.

<br><br><br>

## License

[MIT](LICENSE)
