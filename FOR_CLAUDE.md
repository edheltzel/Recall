# For You, Claude Code Instance

This document explains the LMF3 memory system installed on this machine. Read this to understand how to use persistent memory effectively.

---

## What Is LMF3?

LMF3 is a persistent memory framework. It gives you:

1. **Searchable history** of all past conversations via MCP tools and CLI
2. **Automatic extraction** — sessions are parsed into structured summaries when they end
3. **Structured records** — decisions, learnings, breadcrumbs you can create and search

## Your MCP Tools

These tools are available via the `lmf-memory` MCP server:

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
```

### context_for_agent
Before spawning agents via the Task tool, call this to prepare memory context:

```
context_for_agent({ agent_task: "Refactor the auth middleware", project: "my-app" })
```

### memory_stats
Get database statistics (record counts, database size).

### loa_show
Show a full Library of Alexandria entry with its extracted wisdom.

## The CLI

You can also use the `mem` CLI directly via Bash:

```bash
mem search "deployment pipeline"    # Search memory
mem stats                           # Database statistics
mem loa list                        # Browse curated knowledge
mem dump "Session title"            # Capture current session
```

## Core Rules

1. **Search before asking** — Before asking the user to repeat information, search memory first
2. **Record decisions** — When architectural decisions are made, use `memory_add` to record them
3. **Context for agents** — Before spawning agents, call `context_for_agent` to give them relevant history
4. **Session capture** — When the user says `/dump`, run `mem dump "Descriptive Title"` to capture the session

## How Extraction Works

When a session ends, the `SessionExtract` hook:

1. Reads the conversation JSONL file
2. Sends it to Claude Haiku with an extraction prompt
3. Parses the response into structured sections (summary, ideas, decisions, errors, insights)
4. Appends to `~/.claude/MEMORY/DISTILLED.md` and updates `HOT_RECALL.md`
5. Updates `SESSION_INDEX.json` for searchable lookup
6. Tracks extraction state in `.extraction_tracker.json`

A cron job (`BatchExtract.ts`) runs every 30 minutes to catch any sessions that weren't extracted at end (crashes, interruptions, etc.).

## Database Location

The SQLite database is at `~/.claude/memory.db` (or wherever `MEM_DB_PATH` points). It uses:
- **WAL mode** for concurrent reads
- **FTS5** indexes on all text tables
- **Vector embeddings** (optional, requires Ollama) for semantic search
