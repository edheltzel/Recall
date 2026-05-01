---
description: Search Recall memory using FTS5 full-text search across all tables
---

Search across all Recall memory tables (messages, decisions, learnings, breadcrumbs) using SQLite FTS5 full-text search. Supports AND, OR, NOT operators, prefix matching, and exact phrases.

## Usage

```bash
mem search "$1"
```

**Arguments:**
- `$1` (required): Search query

**Options:**
- `-p <project>` — Filter by project name
- `-t <table>` — Search specific table: messages, decisions, learnings, breadcrumbs
- `-l <n>` — Max results (default: 20)

## Examples

```bash
# Search all memory
mem search "kubernetes deployment"

# Search decisions only
mem search "database choice" -t decisions

# Filter by project
mem search "auth middleware" -p my-api

# Exact phrase with limit
mem search '"rate limiting strategy"' -l 5

# FTS5 operators
mem search "webpack OR vite" -t learnings
```

$@
