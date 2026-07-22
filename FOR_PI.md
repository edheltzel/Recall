# For You, Pi Agent

This document explains the Recall memory system installed on this machine. Read this to understand how to use persistent memory effectively.

---

## What Is Recall?

Recall is a persistent memory framework. It gives you:

1. **Searchable history** of all past conversations via MCP tools and CLI
2. **Automatic extraction** — sessions are exported and parsed into structured summaries
3. **Structured records** — decisions, learnings, breadcrumbs you can create and search
4. **Tiered session-start context (v0.7.0+)** — L0 identity (`identity.md`) + L1 top 12 records by importance. Review both at session start

The L0 tier reads from `~/.claude/MEMORY/identity.md` (or project-local
`./.atlas-recall/identity.md`, or `RECALL_IDENTITY_PATH` if set). If the
user has never written one, recommend `recall onboard` via Bash to create it.

## Your MCP Tools

These tools are available via the `recall-memory` MCP server. Recall enables the adapter's direct-tool mode by default, which normalizes the server prefix to `recall_memory_`; an existing explicit `directTools` preference is preserved:

On the first Pi session after adding the server, `pi-mcp-adapter` populates its metadata cache in the background and keeps the operations available through its `mcp` proxy tool.
After one Pi reload or restart, the nine direct names below are registered from that cache.
If a direct name is not present yet, call the same base operation through `mcp`, for example `mcp({ server: "recall-memory", tool: "memory_search", args: '{"query":"deployment"}' })`.

### recall_memory_memory_search

Search all memory with FTS5 full-text search. **Use this BEFORE asking the user to repeat anything.** Use `table` for a hard filter; use `bias_type` to prefer one type while preserving other matches.

```
recall_memory_memory_search({ query: "kubernetes auth", project: "my-app" })
recall_memory_memory_search({ query: "database choice", table: "decisions" })      // decisions only
recall_memory_memory_search({ query: "database choice", bias_type: "decisions" })  // decisions first, broader context kept
```

Bias quick picks: `decisions` for “what did we decide,” `learnings` for “what did we learn,” `breadcrumbs` for “where did we leave off,” `loa` for curated summaries, `messages` for raw conversation traces.

### recall_memory_memory_hybrid_search

Combines keyword (FTS5) and semantic (embedding) search. Best for natural language queries.

```
recall_memory_memory_hybrid_search({ query: "how did we handle rate limiting" })
```

### recall_memory_memory_recall

Get recent context — LoA entries, decisions, breadcrumbs. Good for session start.

```
recall_memory_memory_recall({ limit: 5, project: "my-app" })
```

### recall_memory_memory_add

Record structured information during sessions:

```
recall_memory_memory_add({ type: "decision", content: "Use PostgreSQL over MySQL", detail: "Better JSON support and extensions" })
recall_memory_memory_add({ type: "learning", content: "bun:sqlite uses $param syntax", detail: "Not :param like better-sqlite3" })
recall_memory_memory_add({ type: "breadcrumb", content: "Auth refactor in progress, do not touch middleware yet" })
recall_memory_memory_add({ type: "decision", content: "Ship onboarding first", importance: 9 })
```

The optional `importance` parameter (integer 1-10, default 5) controls
L1 tier ranking at session start. LoA entries have a floor of 5.

### recall_memory_memory_stats

Get database statistics (record counts, database size).

### recall_memory_loa_show

Show a full Library of Alexandria entry with its extracted wisdom.

### recall_memory_context_for_agent

Get context to pass to a subagent before delegating tasks:

```
recall_memory_context_for_agent({ agent_task: "implement the auth middleware", project: "my-app" })
```

### recall_memory_memory_dump

Persist caller-supplied visible messages as a session and LoA entry. Use the `recall-dump` skill so the explicit user-consent gate is preserved.

### recall_memory_decision_update

Change an existing decision's status by ID when it is superseded, reverted, or confirmed.

## The CLI

You can also use the `recall` CLI directly via shell commands:

```bash
recall search "deployment pipeline"    # Search memory
recall search "database choice" --bias-type decisions  # Prefer decisions, keep other matches
recall search "auth" --show-provenance # Show Record Provenance for every result
recall provenance backfill             # Classify legacy unknown-provenance rows (dry-run; --execute to apply)
recall stats                           # Database statistics
recall loa list                        # Browse curated knowledge
recall onboard                         # Interactive L0 identity setup (run once per user)
recall path                            # Show DB + install paths (diagnostics)
recall doctor --fix                    # Repair drifted/missing Recall symlinks
recall migrate --to /new/path/recall.db  # Relocate the DB and rewrite MCP configs
```

## Codebase Scouting

Canonical workflow — memory-first, sensitive-data boundary, opt-in artifacts — lives in [`agent-skills/recall-scout/SKILL.md`](agent-skills/recall-scout/SKILL.md). This guide supplies only the tool-name mapping:

| Canonical step | Your tool / invocation |
|---|---|
| Invoke the workflow | `recall-scout` Agent Skill (discovered from Recall's native Pi package) |
| "Search Recall first" (memory-first) | `recall_memory_memory_search` (keyword), `recall_memory_memory_hybrid_search` (natural language) |
| Persist a report (only if endorsed) | Write to `.agents/atlas/artifacts/YYYY-MM-DD-scout-<focus>.md` |

## Lifecycle scripts

Three shell scripts in the Recall source directory manage installation.
They are platform-agnostic — Pi, Claude Code, and OpenCode share them.

| Script | Purpose |
|---|---|
| `./install.sh` | Install or reinstall. Idempotent. |
| `./update.sh --check` | Check if a newer GitHub release exists. Check-only. |
| `./update.sh` | Pull latest, rebuild, migrate DB, and refresh the Pi package plus MCP registration. Exit Pi first. |
| `./uninstall.sh --dry-run` | Preview what would be removed. |
| `./uninstall.sh` | Surgical remove; preserves `~/.agents/Recall/` (DB + backups + canonicals) by default. |
| `./uninstall.sh --purge` | Also destroy `~/.agents/Recall/` and any legacy DB (double-confirmed). |

If the user asks about updating or uninstalling, point them at these
scripts rather than instructing per-platform manual steps. Never run
`./update.sh` while the user is actively in a Pi session — the `recall`
binary lives in the same `bun link` process tree, and rebuilding
mid-session can corrupt in-flight extension invocations. Have them
exit Pi first.

## How Pi Is Installed

Pi packages can carry Recall's two extensions and nine Agent Skills together.
Pi packages cannot register an MCP server.

`recall install` therefore coordinates separate native pieces: the Recall Pi package, the `pi-mcp-adapter` package, the owned `recall-memory` entry in `mcp.json`, and this guide.
It also removes pre-package Recall extension and skill symlinks so Pi never loads two copies.

Do not treat `pi install npm:recall-memory` as a complete Recall install.
It omits the MCP adapter/configuration and does not guarantee that `recall` or `recall-mcp` is on `PATH`.

See [`docs/PI_INTEGRATION.md`](docs/PI_INTEGRATION.md) for the verified Pi capability matrix and the explicit differences from Codex and Claude plugin bundles.

## Core Rules

1. **Search before asking** — Before asking the user to repeat information, search memory first. Use `bias_type` when a likely record type should come first without hiding other context; use `table` only when you need one type exclusively.
2. **Record decisions** — When architectural decisions are made, use `recall_memory_memory_add` to record them
3. **Delegate with context** — Before spawning subagents, call `recall_memory_context_for_agent` to give them relevant history
4. **Capture sessions** — At the end of a session, run `recall dump "Descriptive Title"` (the `recall-dump` skill) to persist the conversation
5. **Onboarding check** — At session start, if the L0 identity tier is empty (no `~/.claude/MEMORY/identity.md` or the file is missing), suggest `recall onboard` once. Do not nag on subsequent turns.
6. **Never store secrets** — `recall_memory_memory_add` and `recall dump` persist content verbatim into `recall.db`, and stored records can resurface in future sessions' L0/L1 context. Redact API keys, tokens, passwords, and credential-bearing snippets before recording (e.g. `[REDACTED:api-key]`). When dumping a session that touched credentials, say so and confirm with the user first.
7. **Record corrections** — When the user corrects you ("no, actually…", "that's wrong, use X"), record it immediately: `recall_memory_memory_add({ type: "learning", content: "<what was wrong → what is right>", confidence: "high", importance: 7 })`. Corrections are the highest-signal and most perishable memory; do not wait for session end.

## How Extraction Works

A Recall extension (`RecallPreCompact.ts` + `RecallExtract.ts`) runs inside Pi:

1. `RecallPreCompact.ts` hooks into `before_agent_start` and injects relevant memory into the system prompt before each agent turn
2. `RecallExtract.ts` hooks into `session_shutdown` and reads the supported path from `ctx.sessionManager.getSessionFile()`
3. Pi sessions use tree-structured JSONL (each entry has `id` and `parentId`) rather than a linear format — the extension linearizes the active branch into flat markdown
4. The markdown is dropped into `$RECALL_HOME/MEMORY/pi-sessions/` (default `~/.agents/Recall/MEMORY/pi-sessions/`)
5. A batch extraction cron job (`RecallBatchExtract`) processes these files into structured memory

## Database Location

The SQLite database is at `~/.agents/Recall/recall.db` (or wherever `RECALL_DB_PATH` points; the legacy `MEM_DB_PATH` is still accepted). It uses:

- **WAL mode** for concurrent reads
- **FTS5** indexes on all text tables
- **Vector embeddings** (optional, requires Ollama) for semantic search

The same database is shared with Claude Code, OpenCode, and Codex if they are installed — your memory is unified across platforms.
