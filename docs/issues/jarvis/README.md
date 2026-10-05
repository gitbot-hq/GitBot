# Jarvis build issues

Tracer-bullet slices for [Jarvis](../../JARVIS.md). Each is built, tested and demoed before anything that depends on it.

| # | Slice | Type | Blocked by |
|---|---|---|---|
| 01 | [Test harness](01-test-harness.md) | AFK | — |
| 02 | [Spike: server-started turns and SDK tools on resume](02-spike-unknowns.md) | HITL | — |
| 03 | [Plain agent bots](03-plain-agent-bots.md) | AFK | 01 |
| 04 | [Jarvis exists and knows your bots](04-jarvis-knows-bots.md) | AFK | 01, 02 |
| 05 | [Jarvis knows your projects](05-jarvis-knows-projects.md) | AFK | 04 |
| 06 | [Jarvis starts a child thread](06-jarvis-starts-child.md) | AFK | 03, 05 |
| 07 | [A finished child wakes Jarvis](07-child-wakes-jarvis.md) | AFK | 02, 06 |
| 08 | [Lock and Stop](08-lock-and-stop.md) | AFK | 07 |
| 09 | [Restart recovery](09-restart-recovery.md) | AFK | 08 |
| 10 | [Jarvis can look at threads](10-read-thread-tools.md) | AFK | 06 |
| 11 | [Jarvis continues existing threads](11-continue-threads.md) | AFK | 07, 10 |
| 12 | [Approvals shown in the Jarvis thread](12-approvals-in-jarvis.md) | AFK | 08 |
| 13 | [Attention signals](13-attention-signals.md) | AFK | 07, 12 |
| 14 | [Workspace project scan](14-workspace-project-scan.md) | AFK | 05 |
| 15 | [Project memory](15-project-memory.md) | AFK | 05 |
| 16 | [Jarvis first](16-jarvis-first.md) | AFK | 04 |
| 17 | [Bot names that explain themselves](17-bot-names-that-explain.md) | AFK | — |
| 18 | [Access guard before shipping](18-access-guard.md) | HITL | — |

Shortest path to the core loop — Jarvis delegates and reports back: **01 → 02 → 04 → 05 → 06 → 07**. 03 is needed by 06 and can be built alongside. 17 and 18 can be built any time; 18 before Jarvis ships.
