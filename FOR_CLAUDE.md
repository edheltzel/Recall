# For You, Claude Code Instance

This document explains the Recall memory system installed on this machine. Read this to understand how to use persistent memory effectively.

---

## What Is Recall?

Recall is a persistent memory framework. It gives you:

1. **Searchable history** of all past conversations via MCP tools and CLI
2. **Automatic extraction** — sessions are parsed into structured summaries when they end
3. **Structured records** — decisions, learnings, breadcrumbs you can create and search
4. **Tiered session-start context** — `RecallStart` injects two tiers at the top of every session: **L0 identity** (who the user is) and **L1 top 12 records** ranked by importance. Read the L0 and L1 content at the start of every session — it is authoritative baseline context

## Your MCP Tools

These tools are available via the `recall-memory` MCP server:

### memory_search

Search all memory with FTS5 full-text search. **Use this BEFORE asking the user to repeat anything.**

```
memory_search({ query: "kubernetes auth", project: "my-app" })
```

### memory_hybrid_search

Combines keyword (FTS5) and semantic (embedding) search. Best for natural language queries.

```
memory_hybrid_search({ query: "how did we handle rate limiting" })
```

### memory_recall

Get recent context — LoA entries, decisions, breadcrumbs. Good for session start.

```
memory_recall({ limit: 5, project: "my-app" })
```

### memory_add

Record structured information during sessions:

```
memory_add({ type: "decision", content: "Use PostgreSQL over MySQL", detail: "Better JSON support and extensions" })
memory_add({ type: "learning", content: "bun:sqlite uses $param syntax", detail: "Not :param like better-sqlite3" })
memory_add({ type: "breadcrumb", content: "Auth refactor in progress, do not touch middleware yet" })
memory_add({ type: "decision", content: "Ship onboarding command first", importance: 9 })
```

Parameters:
- `confidence` (optional, "high" | "medium" | "low", default: "medium") — How certain is this decision?
  - HIGH = explicitly discussed and agreed upon
  - MEDIUM = implied or reasonably inferred
  - LOW = speculative or uncertain
  - Note: Low-confidence decisions are filtered from session context to save context budget
- `importance` (optional, integer 1-10, default: 5) — How load-bearing is this record? Higher importance surfaces the record earlier in the L1 tier at session start. LoA entries have a floor of 5 and cannot be pinned lower.

### decision_update

Update a decision's lifecycle status:

```
decision_update({ id: 5, action: "supersede" })
```

Parameters:
- `id` (number): The decision record ID to update
- `action` ("supersede" | "revert"): Mark the decision as superseded by a newer one, or revert it if it was wrong

When to use: When a newer decision replaces an older one, or when a decision turned out to be incorrect and should no longer influence future sessions.

### context_for_agent

Before spawning agents via the Task tool, call this to prepare memory context:

```
context_for_agent({ agent_task: "Refactor the auth middleware", project: "my-app" })
```

### memory_dump

Dump the current session into SQLite mid-conversation. Messages become immediately searchable. Works across Claude Code, OpenCode, and Pi.

```
memory_dump({ title: "Working on auth refactor", skip_fabric: true })
```

- `title` (required): Descriptive title for this session
- `project` (optional): Override project name
- `skip_fabric` (optional, default: true): Skip Fabric extraction for speed

After dumping, open a new session and use `memory_search` to query the dumped conversation.

### memory_stats

Get database statistics (record counts, database size).

### loa_show

Show a full Library of Alexandria entry with its extracted wisdom.

## Slash Commands

These slash commands are available in any Claude Code session:

| Command | What it does |
|---------|-------------|
| `/Recall:dump <title>` | Flush session to DB + capture LoA entry. Run at end of every session. |
| `/Recall:search <query>` | FTS5 search across all memory. Example: `/Recall:search kubernetes auth` |
| `/Recall:recent [table]` | Recent records. Example: `/Recall:recent decisions` |
| `/Recall:scout [focus]` | Memory-first codebase scout report (repo map, key paths, tests, risks, next steps). Example: `/Recall:scout auth` |
| `/Recall:stats` | Database statistics at a glance |
| `/Recall:add` | Add a record. Example: `/Recall:add breadcrumb "Auth refactor in progress"` |
| `/Recall:doctor` | Health check all subsystems |
| `/Recall:update` | Check-only: prints current vs. latest GitHub release + `cd <path> && ./update.sh` recipe. Never rebuilds mid-session. |
| `/Recall:loa` | Browse Library of Alexandria entries |

## Codebase Scouting

Canonical workflow — memory-first, sensitive-data boundary, opt-in artifacts — lives in [`commands/Recall/scout.md`](commands/Recall/scout.md). This guide supplies only the tool-name mapping:

| Canonical step | Your tool / invocation |
|---|---|
| Invoke the workflow | `/Recall:scout [focus]` slash command |
| "Search Recall first" (memory-first) | `memory_search` (keyword), `memory_hybrid_search` (natural language) |
| Persist a report (only if endorsed) | Write tool → `.agents/atlas/artifacts/YYYY-MM-DD-scout-<focus>.md` |

## The CLI

You can also use the `mem` CLI directly via Bash:

```bash
mem search "deployment pipeline"    # Search memory
mem stats                           # Database statistics
mem loa list                        # Browse curated knowledge
mem dump "Session title"            # Capture current session
mem onboard                         # Interactive L0 identity setup (run once per user)
mem pin decisions 42 10             # Pin a record to high importance
mem path                            # Show DB + install paths (handy for diagnostics)
mem doctor --fix                    # Repair drifted/missing Recall symlinks
mem migrate --to /new/path/recall.db  # Relocate the DB and rewrite MCP configs
```

### L0 identity file

The L0 tier reads from `~/.claude/MEMORY/identity.md` by default, with
`./.atlas-recall/identity.md` taking precedence if present. The `RECALL_IDENTITY_PATH`
env var overrides both. If the user has never created this file, the L0 section of
session context is empty — recommend running `mem onboard` to fix it.

## Core Rules

1. **Memory-first at session start** — A `SessionStart` hook (`RecallStart.ts`) automatically loads two tiers: **L0 identity** (user-authored `identity.md`, always on, capped at 1200 chars) and **L1 top 12** (messages/decisions/learnings/LoA ranked by importance, with 4 slots reserved for LoA). Review both before your first response. If you need more detail, call `memory_recall()` or `memory_hybrid_search()`. L2/L3 tiers are documented in the preamble but NOT injected — fetch them on demand.
2. **Search memory before git** — When you need context about past work, **always search Recall first** (`memory_search` or `memory_hybrid_search`) before falling back to `git log`, `git show`, or commit history. Recall contains structured decisions, learnings, and session summaries that are richer than commit messages.
3. **Search before asking** — Before asking the user to repeat information, search memory first
4. **Record decisions** — When architectural decisions are made, use `memory_add` to record them
5. **Context for agents** — Before spawning agents, call `context_for_agent` to give them relevant history
6. **Session capture** — When the user says `/dump` or `/Recall:dump`, call `memory_dump({ title: "Descriptive Title" })` to capture the session into SQLite. This works mid-conversation — you don't need to wait for the session to end. The dumped messages are immediately searchable from any new session via `memory_search`.
7. **Onboarding check** — At session start, if the L0 tier is empty (the `## L0 — Identity` block in the RecallStart preamble is missing or empty), suggest the user run `mem onboard` once per session. Do not nag on subsequent turns. The L0 tier reads from `~/.claude/MEMORY/identity.md`; an empty tier means the user has not yet run the interview. Sample suggestion: "I notice your L0 identity tier is empty. Run `mem onboard` once to set up the baseline that every session loads — it takes about 90 seconds."

### Context Resolution Order

When you need information about past work or project context, follow this priority:

1. **SessionStart hook output** — Already loaded, check it first
2. **`memory_hybrid_search`** — Search Recall for relevant history (keyword + semantic)
3. **`memory_recall`** — Get recent LoA entries, decisions, breadcrumbs
4. **Native Claude memory** — Check conversation context and compact summaries
5. **`git log` / `git show`** — Only as a last resort for commit-level detail

## How Extraction Works

When a session ends, the `RecallExtract` hook:

1. Reads the conversation JSONL file
2. Sends it to Claude Haiku with an extraction prompt
3. Parses the response into structured sections (summary, ideas, decisions, errors, insights)
4. Appends to `~/.claude/MEMORY/DISTILLED.md` and updates `HOT_RECALL.md`
5. Updates `SESSION_INDEX.json` for searchable lookup
6. Tracks extraction state in `.extraction_tracker.json`

A cron job (`RecallBatchExtract.ts`) runs every 30 minutes to catch any sessions that weren't extracted at end (crashes, interruptions, etc.).

## Database Location

The SQLite database is at `~/.agents/Recall/recall.db` (or wherever `RECALL_DB_PATH` points; the legacy `MEM_DB_PATH` is still accepted). It uses:

- **WAL mode** for concurrent reads
- **FTS5** indexes on all text tables
- **Vector embeddings** (optional, requires Ollama) for semantic search
