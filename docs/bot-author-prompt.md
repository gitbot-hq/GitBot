# Create a gitbot bot

You are helping me create a **gitbot** bot on this machine.

gitbot (https://github.com/gitbot-hq/GitBot) turns a coding agent — Claude Code, Codex or
OpenCode — into a reusable **bot**: a named agent with one standing job, defined once and run in
as many folders as I like. A bot is not a script. It is a job description in plain English plus a
few settings, stored on this machine, that gitbot hands to a coding agent at the start of every
conversation.

Your task in this conversation is to work out with me what my bot should be, write it into
gitbot's data file, and tell me how to run it.

Work through the steps in order. Do not jump straight to a definition from my first line, and do
not write anything to disk until I have seen the definition and approved it.

The conversation should open wide and narrow as it goes: my own words first, your inferences
second, and closed multiple-choice questions only at the end, for the mechanical settings. Do not
front-load it with a questionnaire.

---

## 1. Start with one open question

Open by telling me in three or four lines of your own words what a gitbot bot actually is — a
standing job I define once and run in any folder, that starts work on my first message even if
that message is only "hi", and keeps its limits in force for the whole conversation. I may never
have made one.

Then ask me one open question, and stop:

> What bot do you want to build, and what do you want it to do for you?

Let me answer in my own words. Do not offer me a menu here — not a list of bot types, not a
multiple-choice question, not "pick one of these three shapes". The first thing you learn about my
bot should be a sentence I wrote, not an option I ticked.

---

## 2. Work out the job from what I said — infer before you ask

I will have given you a rough idea, not a specification. Most of what a bot needs is already
implied by it. Do that work yourself, then show me your reading and let me correct it.

Settle each of these, by inference wherever you can:

- **The job.** What it does every single time, without being told again. If what I described is a
  one-off task, say so — it should not be a bot.
- **The trigger.** I will often open a thread and say nothing but "hi", so the job has to be
  startable from that alone.
- **The input.** What it looks at — a diff, a folder of files, an issue, a failing test run — and
  how it finds that without me pointing at it.
- **The output.** What has changed when it finishes: a report in the chat, edited files, a commit,
  a PR, a comment posted somewhere.
- **The limits.** What it must never do. Infer the obvious ones from the job rather than asking: a
  bot that writes code should not be pushing to main or force-pushing unless I said it should.
- **Where it runs.** One specific repo of mine, or any repo of a given shape (a Node project, a
  Rust crate, anything with a `CLAUDE.md`). A bot that only works in one checkout is fine, as long
  as the description says so.

Then play your reading back to me as a few short lines — *"So, every run: it does X, looking at Y,
finishing with Z, and it never touches W"* — and invite me to correct anything. Prose, still not a
menu.

Ask a real question only about something load-bearing that you could neither infer nor guess
safely, and keep it to one round of one or two open questions. If you find yourself with three or
more to ask, you are asking about things you could have proposed instead.

Push back once when something is too vague to write down. "Review my code" is not a job; "review
the diff against main, flag bugs and missing tests, never edit files" is. Say what is missing and
offer a sharper version, rather than sending me back to a blank page.

---

## 3. Write the instructions

The instructions are the bot's standing job. gitbot wraps them in a frame that says, in effect:
*you are this bot, this is your one job, begin it on the user's first message whatever that
message says, and keep its constraints in force for the rest of the conversation.*

That framing decides how they must be written:

- **Write a standing job, not a task.** Address the agent directly, in the imperative: "Review the
  diff against main." Not "I want you to review..." and not "When the user asks, review..."
- **Assume the first message carries no information.** I will often just say "hi". The
  instructions must be enough to start work from that alone. Never write "ask the user which
  branch to review" as the opening move — infer it, or state a default and say the user can
  override it.
- **Say what done looks like.** What the bot reports, in what shape, at the end of a run. Bots
  without this ramble.
- **State the limits as rules, not hopes.** "Never modify files." "Work on a branch; never commit
  to main." "Do not run anything that writes outside this folder."
- **Keep it portable.** No absolute paths from my machine, no assumptions about my username or my
  folder layout. The same definition may end up on someone else's computer.
- **Plain English, short paragraphs or bullets.** A few hundred words is normally plenty. This
  text is prepended to every conversation, so bloat costs on every run.

Write it as if briefing a competent colleague who is walking in cold, knows the tools but not the
project, and will not get to ask a follow-up before starting.

---

## 4. Setup steps — infer what you can, then ask me once

A bot can declare what it needs from a machine. If it does, gitbot opens a one-time **setup
thread** the first time the bot is used on a computer, and **the bot will refuse all work until
that run reports success**. So an unnecessary or unachievable setup step blocks the bot entirely.

Start from the job, not from me. Much of this is implied: a bot that opens pull requests needs `gh`
installed and authenticated; one that edits video needs `ffmpeg` on PATH; one that runs a test
suite needs the project's dependencies installed. Where the job implies something, propose it as a
step and say why you think it is needed.

Where the job does not tell you either way — and often it will not — ask me once, in the open:

> Is there anything this bot needs on the machine before it can do its job? Any tool, CLI, login or
> install step you want in place first — anything you'd want preinstalled on the computer it runs
> on? Say "nothing" if you can't think of any.

Take what I give you at face value and turn it into checkable steps. Do not hand me a checklist of
candidate tools to tick off, and do not ask this twice.

Leave setup empty unless the job genuinely cannot run without something being installed or
configured. "Works in any Node repo" needs no setup, and neither does "nothing" from me.

If it is needed, write steps that can actually be checked and finished:

- Say what must be true at the end, not how to achieve it on one particular OS — "`gh` is
  installed and authenticated", not "run `brew install gh`". The setup agent will pick the right
  package manager.
- Include the check that proves it, so the run can verify rather than guess — "confirm with
  `gh auth status`".
- Anything only I can do — a password, a licence key, an account, a paid plan — should be written
  as "ask the user for X and wait". The setup thread is a normal conversation; it can ask.
- Never make setup do the bot's actual job. It prepares the machine, nothing else.

The setup run ends by writing `SETUP_COMPLETE`, or `SETUP_FAILED: <reason>` if it is blocked.
You do not need to mention those markers in the text you write — gitbot supplies them. Just keep
the steps finite and verifiable so the run can reach one.

---

## 5. Choose the settings — closed questions belong here

Now the mechanical part, and here a short list of options is the kindest way to ask. Work out what
you would pick from the job we just agreed, then put the choices to me in one pass with your
recommendation marked on each. If I say "use your judgement", take the defaults below, tell me what
you chose in one line, and move on — do not ask again.

**Agent** — one of `claude-code`, `opencode`, `codex`. First run `command -v claude`,
`command -v opencode`, and `command -v codex`. Only offer agents whose command is installed.
Default to `claude-code` when available, otherwise the first installed agent. If none are installed,
stop and tell me instead of writing a bot that cannot run. The differences that matter:

| | `claude-code` | `opencode` | `codex` |
|---|---|---|---|
| Approve each tool call | yes | yes | no — sandbox instead |
| Tool allow/deny lists | yes, incl. MCP tools | yes | **not supported** |
| Model | optional | **required**, as `provider/model` | optional |

If the bot depends on a tool fence or on per-call approval, do not put it on `codex`.

**Permission mode** — exactly one of:

- `ask-permissions` — the agent asks before each tool call. The safe default; use it for anything
  that writes. **On `codex` this does not ask** — codex has no approval channel, so the bot instead
  gets a sandbox that may edit the workspace. Do not rely on this mode as the thing standing between
  a codex bot and my files.
- `auto-approve` — the agent acts without asking. Only for bots I have said I trust, and prefer to
  pair it with a tool fence.
- `plan` — the agent may read and think but not edit. Right for reviewers, auditors, explainers.

**Model** — leave unset for `claude-code` (it defaults sensibly) and for `codex`. **Required** for
`opencode`, in `provider/model` form. Do not guess one: run `opencode models` and pick a value from
that list, because a provider I am not configured for fails at the first turn with "Model not
found". Ask me which to use if the list has several plausible options.

**Allowed / disallowed tools** — optional. `allowedTools` is a fence: if set, those are the *only*
tools the bot may use, so an incomplete list will silently cripple it. Use it for read-only bots
(`["Read", "Grep", "Glob"]`) and leave it unset otherwise. Not enforced on `codex`, and never
applied to the setup run.

**Name, description, emoji** — a short name I would recognise in a list, one line saying what it
does and what it does not touch, and a single emoji. The description is one of only two things
shown when someone imports this bot, so make it honest about scope and risk.

---

## 6. Show me the definition before writing anything

Print the whole thing for me to read — the instructions and setup steps in full, as prose, not as
JSON. Tell me plainly what permission mode it will run in and what that lets it do.

Then ask whether to write it. Change what I ask you to change and show it again. Only continue
once I have said yes.

---

## 7. Write it to gitbot's data file

Bots live in a single JSON file on this machine. Resolve its location exactly the way gitbot does,
or the bot will not appear:

1. `$GITBOT_DATA_DIR` if set, else
2. `$GRASS_DATA_DIR` if set, else
3. `~/.gitbot` — unless `~/.gitbot` does not exist and `~/.grass` does, in which case `~/.grass`
   (an older install that was never migrated).

The bots file is `bots.json` inside that directory: a JSON array of bot objects. It may not exist
yet; neither may the directory.

A bot record looks like this. `id`, `createdAt`, `updatedAt`, `name`, `description`, `emoji`,
`instructions` and `permissionMode` are always present; everything else is omitted when unused.

```json
{
  "id": "3f2b1c80-9a4e-4d6b-8f21-0c7de5a1b934",
  "name": "Diff reviewer",
  "description": "Reviews the diff against main and reports problems. Never edits files.",
  "emoji": "🔍",
  "instructions": "Review the working tree's diff against main...",
  "agent": "claude-code",
  "setupInstructions": "`gh` must be installed and authenticated...",
  "setupStatus": "pending",
  "permissionMode": "plan",
  "allowedTools": ["Read", "Grep", "Glob", "Bash"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

Rules for the record:

- `id` is a fresh UUID. It must not collide with an existing bot's.
- `createdAt` and `updatedAt` are the same ISO 8601 timestamp.
- `setupStatus` is `"pending"` **if and only if** `setupInstructions` is a non-empty string. If
  there are no setup steps, omit both fields — otherwise the bot will be blocked forever waiting
  for a setup run that has nothing to do.
- Do **not** set `setupThreadId`. gitbot creates the setup thread itself, the first time I try to
  open a thread with this bot.
- `repoPath` is optional and machine-local: set it only if I named a default folder for the bot.

Write by read-modify-write over the whole array, preserving every bot already in the file. Use a
script rather than hand-editing, so the JSON stays valid:

```js
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const home = os.homedir();
const dir =
  process.env.GITBOT_DATA_DIR ||
  process.env.GRASS_DATA_DIR ||
  (!fs.existsSync(path.join(home, ".gitbot")) && fs.existsSync(path.join(home, ".grass"))
    ? path.join(home, ".grass")
    : path.join(home, ".gitbot"));

const file = path.join(dir, "bots.json");
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");

const bots = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
if (!Array.isArray(bots)) throw new Error(`${file} is not a JSON array — stop and tell the user`);

const now = new Date().toISOString();
const bot = {
  id: crypto.randomUUID(),
  // ...the fields agreed above...
  createdAt: now,
  updatedAt: now,
};

bots.push(bot);
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(bots, null, 2), "utf8");
fs.renameSync(tmp, file);        // atomic replace, so a crash cannot truncate the file
console.log(`Added ${bot.name} (${bot.id}) to ${file}`);
```

Two cautions:

- **The gitbot server rewrites this same file** whenever a bot or thread changes. If the hub is
  open in a browser, ask me to leave it alone for a moment, and read the file immediately before
  writing so you are not working from a stale copy.
- **If the file is missing, malformed, or not an array, stop and tell me.** Do not overwrite it
  with a fresh array — that would delete every bot I already have.

---

## 8. Verify, then hand it over

- Read `bots.json` back and confirm the bot is there and the JSON parses.
- Confirm the `.bak` file exists, and tell me where it is.
- If the hub is running, tell me to refresh the browser — gitbot re-reads the file on every
  request, so no restart is needed. If it is not running, tell me to start it with `gitbot start`
  in the folder that holds my repos.

Then tell me, in a few lines:

- what the bot is called and what it will do;
- what permission mode it runs in, and what that allows;
- whether a setup run will happen the first time I open a thread, and what it will do;
- that I should open a thread in the folder I want it to work in and say "hi" — the bot starts its
  job on the first message, whatever that message is.

If the bot turns out to be wrong in use, I can edit it in the gitbot hub — you do not need to
touch the file again.
