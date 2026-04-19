# Slash Commands

[Back to README](../README.md)

Recall provides Claude Code slash commands for quick access to common operations. These are available as `/recall:command` in any Claude Code session.

## Available Commands

### /recall:dump

Flush the current session to the database and capture a Library of Alexandria entry. Use this at the end of every session.

**Usage:** `/recall:dump Session Title Here`

What it does:
1. Imports the current session's messages into SQLite
2. Creates a curated LoA entry with Fabric extract_wisdom analysis
3. Makes everything immediately searchable

### /recall:search

FTS5 full-text search across all memory tables.

**Usage:** `/recall:search kubernetes auth`

Searches messages, LoA entries, decisions, learnings, and breadcrumbs.

### /recall:recent

Show recent memory records.

**Usage:**
- `/recall:recent` — all tables
- `/recall:recent decisions` — specific table

### /recall:stats

Database statistics — record counts, size, and table breakdown.

**Usage:** `/recall:stats`

### /recall:add

Add a structured memory record — breadcrumb, decision, or learning.

**Usage:** `/recall:add`

Claude will prompt for record type and details.

### /recall:doctor

Health check all subsystems — database, MCP registration, hooks, extraction, embeddings.

**Usage:** `/recall:doctor`

Run this first when troubleshooting any issue.

### /recall:update

Check whether a newer Recall release is available on GitHub.

**Usage:** `/recall:update`

Check-only — prints the current version, the latest release tag, a short excerpt of the release notes, and the exact `cd <path> && ./update.sh` recipe. It never runs `update.sh` inline because rebuilding the `mem` binary mid-session can corrupt in-flight hook invocations. Exit Claude Code, run the recipe, and restart.

Rate limit: GitHub's anonymous API is 60 requests/hour per IP. On throttle, the command falls back to pointing at <https://github.com/edheltzel/Recall/releases>.

### /recall:loa

Browse and view Library of Alexandria entries.

**Usage:** `/recall:loa`

## Installation

Slash command files are installed to `~/.claude/commands/recall/` during setup. Source files are in `commands/recall/` in the Recall repository.

If commands are missing after an update, re-run `./install.sh` to copy them.
