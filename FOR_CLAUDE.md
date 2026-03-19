# For You, Claude Code Instance

This document explains the Recall memory system installed on this machine. Read this to understand how to use persistent memory effectively.

---

## What Is Recall?

Recall is a persistent memory framework. It gives you:

1. **Searchable history** of all past conversations via MCP tools and CLI
2. **Automatic extraction** — sessions are parsed into structured summaries when they end
3. **Structured records** — decisions, learnings, breadcrumbs you can create and search

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
```

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
| `/recall:dump <title>` | Flush session to DB + capture LoA entry. Run at end of every session. |
| `/recall:search <query>` | FTS5 search across all memory. Example: `/recall:search kubernetes auth` |
| `/recall:recent [table]` | Recent records. Example: `/recall:recent decisions` |
| `/recall:stats` | Database statistics at a glance |
| `/recall:add` | Add a record. Example: `/recall:add breadcrumb "Auth refactor in progress"` |
| `/recall:doctor` | Health check all subsystems |
| `/recall:loa` | Browse Library of Alexandria entries |

## The CLI

You can also use the `mem` CLI directly via Bash:

```bash
mem search "deployment pipeline"    # Search memory
mem stats                           # Database statistics
mem loa list                        # Browse curated knowledge
mem dump "Session title"            # Capture current session
```

## Core Rules

1. **Memory-first at session start** — A `SessionStart` hook automatically loads recent decisions, breadcrumbs, and learnings. Review that context before your first response. If you need more detail, call `memory_recall()` or `memory_hybrid_search()`.
2. **Search memory before git** — When you need context about past work, **always search Recall first** (`memory_search` or `memory_hybrid_search`) before falling back to `git log`, `git show`, or commit history. Recall contains structured decisions, learnings, and session summaries that are richer than commit messages.
3. **Search before asking** — Before asking the user to repeat information, search memory first
4. **Record decisions** — When architectural decisions are made, use `memory_add` to record them
5. **Context for agents** — Before spawning agents, call `context_for_agent` to give them relevant history
6. **Session capture** — When the user says `/dump` or `/recall:dump`, call `memory_dump({ title: "Descriptive Title" })` to capture the session into SQLite. This works mid-conversation — you don't need to wait for the session to end. The dumped messages are immediately searchable from any new session via `memory_search`.

### Context Resolution Order

When you need information about past work or project context, follow this priority:

1. **SessionStart hook output** — Already loaded, check it first
2. **`memory_hybrid_search`** — Search Recall for relevant history (keyword + semantic)
3. **`memory_recall`** — Get recent LoA entries, decisions, breadcrumbs
4. **Native Claude memory** — Check conversation context and compact summaries
5. **`git log` / `git show`** — Only as a last resort for commit-level detail

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
