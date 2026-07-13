---
name: "recall-search"
description: "Search Recall memory using FTS5 full-text search across all tables"
---

Search across all Recall memory tables (messages, LoA entries, decisions, learnings, breadcrumbs) using SQLite FTS5 full-text search. Supports AND, OR, NOT operators, prefix matching, exact phrases, hard table filtering, and soft table biasing.

## Usage

```bash
recall search "<query>"
```

**Arguments:**
- `<query>` (required): Search query — use the user's argument text

**Options:**
- `-p <project>` — Filter by project name
- `-t <table>` — Hard-filter to one table: messages, loa, decisions, learnings, breadcrumbs
- `--bias-type <table>` — Softly boost one table without filtering other matches. Same values as `-t`.
- `-l <n>` — Max results (default: 20)
- `--show-provenance` — Show Record Provenance for every result (by default only unknown provenance is flagged)

## Examples

```bash
# Search all memory
recall search "kubernetes deployment"

# Search decisions only (hard filter)
recall search "database choice" -t decisions

# Prefer decisions first, but still show matching learnings/messages/etc.
recall search "database choice" --bias-type decisions

# Filter by project
recall search "auth middleware" -p my-api

# Exact phrase with limit
recall search '"rate limiting strategy"' -l 5

# FTS5 operators
recall search "webpack OR vite" -t learnings

# Rule of thumb: use -t when you want ONLY that table; use --bias-type when you want that table first.
```
