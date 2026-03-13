# For You, Pi Agent

This document explains the Recall memory system installed on this machine. Read this to understand how to use persistent memory effectively.

---

## What Is Recall?

Recall is a persistent memory framework. It gives you:

1. **Searchable history** of all past conversations via MCP tools and CLI
2. **Automatic extraction** — sessions are exported and parsed into structured summaries
3. **Structured records** — decisions, learnings, breadcrumbs you can create and search

## Your MCP Tools

These tools are available via the `recall-memory` MCP server. In Pi, tool names are prefixed with the server name using `recall-memory_`:

### recall-memory_memory_search

Search all memory with FTS5 full-text search. **Use this BEFORE asking the user to repeat anything.**

```
recall-memory_memory_search({ query: "kubernetes auth", project: "my-app" })
```

### recall-memory_memory_hybrid_search

Combines keyword (FTS5) and semantic (embedding) search. Best for natural language queries.

```
recall-memory_memory_hybrid_search({ query: "how did we handle rate limiting" })
```

### recall-memory_memory_recall

Get recent context — LoA entries, decisions, breadcrumbs. Good for session start.

```
recall-memory_memory_recall({ limit: 5, project: "my-app" })
```

### recall-memory_memory_add

Record structured information during sessions:

```
recall-memory_memory_add({ type: "decision", content: "Use PostgreSQL over MySQL", detail: "Better JSON support and extensions" })
recall-memory_memory_add({ type: "learning", content: "bun:sqlite uses $param syntax", detail: "Not :param like better-sqlite3" })
recall-memory_memory_add({ type: "breadcrumb", content: "Auth refactor in progress, do not touch middleware yet" })
```

### recall-memory_memory_stats

Get database statistics (record counts, database size).

### recall-memory_loa_show

Show a full Library of Alexandria entry with its extracted wisdom.

### recall-memory_context_for_agent

Get context to pass to a subagent before delegating tasks:

```
recall-memory_context_for_agent({ task_description: "implement the auth middleware" })
```

## The CLI

You can also use the `mem` CLI directly via shell commands:

```bash
mem search "deployment pipeline"    # Search memory
mem stats                           # Database statistics
mem loa list                        # Browse curated knowledge
```

## Core Rules

1. **Search before asking** — Before asking the user to repeat information, search memory first
2. **Record decisions** — When architectural decisions are made, use `recall-memory_memory_add` to record them
3. **Delegate with context** — Before spawning subagents, call `recall-memory_context_for_agent` to give them relevant history
4. **Capture sessions** — At the end of a session, run `mem dump "Descriptive Title"` via a slash command to persist the conversation

## How Extraction Works

A Recall extension (`recall-compaction.ts` + `recall-extract.ts`) runs inside Pi:

1. `recall-compaction.ts` hooks into `before_agent_start` and injects relevant memory into the system prompt before each agent turn
2. `recall-extract.ts` hooks into `session_shutdown` (fires on exit — Ctrl+C, Ctrl+D, SIGTERM)
3. Pi sessions use tree-structured JSONL (each entry has `id` and `parentId`) rather than a linear format — the extension linearizes the active branch into flat markdown
4. The markdown is dropped into `~/.claude/MEMORY/pi-sessions/`
5. A batch extraction cron job (`BatchExtract`) processes these files into structured memory

## Database Location

The SQLite database is at `~/.claude/memory.db` (or wherever `MEM_DB_PATH` points). It uses:

- **WAL mode** for concurrent reads
- **FTS5** indexes on all text tables
- **Vector embeddings** (optional, requires Ollama) for semantic search

The same database is shared with Claude Code and OpenCode if both are installed — your memory is unified across platforms.
