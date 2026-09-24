<a href="#gitbot"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/gitbot-logo-dark.svg"><source media="(prefers-color-scheme: light)" srcset="ui/public/gitbot-logo-light.svg"><img src="ui/public/gitbot-logo-light.svg" alt="GitBot" width="112"></picture></a>&nbsp;&nbsp; [Overview](#gitbot) · [Get running](#get-running) · [Create a bot](#create-your-first-bot) · [How it works](#how-gitbot-works) · [Share](#share-a-bot-or-submit-one-to-marketplace) · [Security](#security-and-privacy)

<br><br>

# GitBot

[![npm version](https://img.shields.io/npm/v/%40gitbot-hq%2Fgitbot?style=flat-square&label=npm)](https://www.npmjs.com/package/@gitbot-hq/gitbot)
[![npm downloads](https://img.shields.io/npm/dm/%40gitbot-hq%2Fgitbot?style=flat-square&label=downloads)](https://www.npmjs.com/package/@gitbot-hq/gitbot)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/github/license/gitbot-hq/GitBot?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/gitbot-hq/GitBot?style=flat-square&logo=github)](https://github.com/gitbot-hq/GitBot/stargazers)

Create a bot once. Put your coding agents to work across your repos.

GitBot runs Claude Code, Codex, or OpenCode on your machine and gives each agent a reusable job, a place to work, and a conversation you can return to. You stay in control of its permissions.

```bash
npm install -g @gitbot-hq/gitbot
```

<br><br>

> **Video to add:** A 30-45 second tour. Start at `gitbot start`, create a bot, open a thread in a repo, and show one useful reply. Keep the install command visible in the opening frame.

![GitBot workspace with bots, threads, and a conversation](assets/screenshots/hub.png)

*Current workspace screenshot. Replace with an up-to-date capture before publishing.*

<br><br>

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

Open **http://localhost:3000** on your computer. GitBot prints a network address and QR code if you want to connect from another device on the same trusted network. The workspace works best on desktop.

> **Before connecting another device:** GitBot has no authentication. Anyone who can reach its port can use the agents running on your machine. Keep it on a trusted network and never expose the port to the public internet. [Read the security notes](#security-and-privacy).

<br><br>

## Create your first bot

A bot is a reusable set of instructions for a coding agent. You decide what it does, which agent runs it, and what it may do without asking.

1. In the **Bots** panel, select **+** and then **Create manually**.
2. Give the bot a **name** and a short **description** so you can recognize it later.
3. Choose an installed **agent**. Write the bot's standing job in **Instructions**.
4. Leave **Permissions** on **Ask when needed** (or **Ask to make changes** for Codex) for your first bot. Add **Setup instructions** only if the bot needs to check or prepare something once on this machine.
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
| ![Create, generate, or import a bot from the Bots panel](assets/screenshots/create-menu.png) | ![Create a bot with its name, agent, instructions, permissions, and mascot](assets/screenshots/create-bot-form.png) | ![Choose a workspace and agent for a new thread](assets/screenshots/create-thread.png) |

You can also choose **Create with an agent** and give an installed agent the guided authoring prompt, or **Import bot** if someone has shared a code with you. In both cases, review the bot's instructions and permissions before you let it work.

<br><br>

## See a bot at work

Choose a repo when you start a thread. The bot runs its agent in that folder and streams the conversation back to GitBot. You can close the browser tab and return to a running turn.

Safe actions may run without asking. When an agent requests more access, GitBot shows what it wants to do so you can allow or deny it. For Codex, reads can run inside its sandbox; writes or restricted actions can raise an approval card.

![Approval request inside a GitBot conversation](assets/screenshots/approval.png)

*Current approval screenshot. Replace with a recent, representative example before publishing.*

> **Video to add:** A short real task in one repo. Show the prompt, an approval decision, the resulting edit or answer, and the same thread after returning to it. Avoid sped-up typing that hides what the agent actually did.

<br><br>

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

<br><br>

## Share a bot, or submit one to Marketplace

**Share with code** copies the bot's settings and instructions so someone else can import it. It does not include chat history or local files. Check the instructions for private details before sharing.

**Publish to Marketplace** shows a prompt you can review and copy into a conversation with the bot. The bot can draft a public listing and prepare a pull request, but it must show you the listing and final diff and wait for your approval. Copying the prompt does not publish anything.

Prefer to submit a listing yourself? The publish dialog opens the GitBot repository on GitHub. A final manual submission recipe will go here once the Marketplace listing format and validation are defined. There is no public `library/` template to follow yet.

| Choose how to share | Share with code | Publish to Marketplace |
| --- | --- | --- |
| ![Share a bot with a code or publish it to Marketplace](assets/screenshots/share-menu.png) | ![Share a bot using its generated code](assets/screenshots/share-code.png) | ![Publish a bot to Marketplace with an agent or manually](assets/screenshots/publish-marketplace.png) |

<br><br>

## Permissions and agent differences

Start with **Ask when needed** (called **Ask to make changes** for Codex). Move to broader permissions only when you understand the bot's instructions and trust the repo it is working in. You can change a thread's permission mode from its chat bar. Codex and Plan changes apply from the next message; a broader Claude Code or OpenCode mode can also resolve approvals already waiting in the current reply.

| | Claude Code | OpenCode | Codex |
| --- | --- | --- | --- |
| Approval requests | When a tool requires it | When a tool requires it | For writes or access outside its read-only sandbox |
| Allowed or disallowed tool list | Yes | Yes | Not enforced |
| Resume threads and run setup steps | Yes | Yes | Yes |
| Model | Optional | Required as `provider/model` | Optional |

An **Allowed tools** list limits which tools a bot can use; its permission mode decides when to ask. Codex cannot enforce that list, so choose Claude Code or OpenCode when a strict tool fence matters.

<br><br>

## Security and privacy

> **Important:** GitBot has no authentication and listens on all network interfaces. Anyone who can reach its port can run agents using your machine's access. Use a trusted network, do not expose the port to the internet, and stop GitBot when you are not using it.

Bots act with your user account's file and shell access. Auto-approval removes a chance to inspect individual tool calls. Imported bots may include setup instructions that run when imported, so read them and their permission mode first.

GitBot has no account, telemetry, or hosted database. Bots and thread records live under `~/.gitbot` by default. Your chosen agent sends prompts and code according to its provider configuration. GitBot also looks up your public IP at startup to print its network address.

<br><br>

## Useful commands

```bash
gitbot start                 # use port 3000
gitbot start -p 4000         # choose another port
gitbot start --caffeinate    # keep a Mac awake during long jobs
```

The folder where you run `gitbot start` becomes the workspace shown first in the folder picker. A thread can still run in another folder you can read.

<br><br>

## Need help?

| If you see... | Try this |
| --- | --- |
| An agent is missing from the menu | Install and sign in to its CLI, then restart GitBot. |
| Port 3000 is already in use | Run `gitbot start -p 4000`. |
| An imported bot needs an agent you don't have | Install that agent or change the bot's agent. |
| The web UI has not been built | If running from source, run `npm run build`. |

For implementation details, see the [API reference](docs/API.md), [architecture notes](docs/ARCHITECTURE.md), and [web UI guide](ui/README.md).

<br><br>

## Contribute

GitBot is open source. For more than a small fix, [open an issue](https://github.com/gitbot-hq/GitBot/issues) first. Keep the change focused, run the build and TypeScript checks, and describe the behavior you tested in your pull request.

<br><br>

## License

[MIT](LICENSE)
