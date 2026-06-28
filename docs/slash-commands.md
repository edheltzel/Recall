# Slash Commands

[Back to README](../README.md)

Recall provides Claude Code slash commands for quick access to common operations. These are available as `/Recall:command` in any Claude Code session.

## Available Commands

### /Recall:dump

Flush the current session to the database and capture a Library of Alexandria entry. Use this at the end of every session.

**Usage:** `/Recall:dump Session Title Here`

What it does:
1. Imports the current session's messages into SQLite
2. Creates a curated LoA entry with Fabric extract_wisdom analysis
3. Makes everything immediately searchable

### /Recall:search

FTS5 full-text search across all memory tables.

**Usage:** `/Recall:search kubernetes auth`

Searches messages, LoA entries, decisions, learnings, and breadcrumbs. The slash command wraps `recall search`, so human CLI flags work here too:

- `/Recall:search database choice -t decisions` — hard-filter to decisions only
- `/Recall:search database choice --bias-type decisions` — prefer decisions first, while still returning matching learnings/messages/LoA/breadcrumbs
- `/Recall:search database choice --show-provenance` — show Record Provenance for every result (by default only unknown provenance is flagged)

Rule of thumb: use `-t` when you want only one table; use `--bias-type` when you want one table first without hiding other context.

### /Recall:recent

Show recent memory records.

**Usage:**
- `/Recall:recent` — all tables
- `/Recall:recent decisions` — specific table

### /Recall:scout

Memory-first orientation for an unfamiliar codebase. Searches Recall before touching git history or source, then produces a structured scout report in chat.

**Usage:**
- `/Recall:scout` — scout the whole repo
- `/Recall:scout auth` — narrow the scout to a subsystem, path, or question

The report covers: **memory summary** (what Recall already knew), **repo map**, **key paths**, **decisions & learnings** (the memory tied to each key file), **tests**, **risks**, and **next steps**. It enforces a strict sensitive-data boundary — no secrets, generated/vendored files, the live database, or cross-project memory — and is chat-only by default. Reports are persisted only when the repo endorses it, and then only to `.agents/atlas/artifacts/` (never `.agents/atlas/handoffs/`). Scout grounds its repo map, key paths, and risks in a code graph **native-first** — Recall's own KG via `recall callers`/`callees`/`trace`/`code-context` (offering `recall index` if the graph is empty), falling back to an external codegraph index, then a grep/tree-walk backstop. The `recall code-context` join — decisions and learnings tied to a file's symbols — is the angle no external code-graph tool can reach. A code graph is optional; scout works fully without one.

### /Recall:stats

Database statistics — record counts, size, and table breakdown.

**Usage:** `/Recall:stats`

### /Recall:add

Add a structured memory record — breadcrumb, decision, or learning.

**Usage:** `/Recall:add`

Claude will prompt for record type and details.

### /Recall:doctor

Health check all subsystems — database, MCP registration, hooks, extraction, embeddings.

**Usage:** `/Recall:doctor`

Run this first when troubleshooting any issue.

### /Recall:update

Check whether a newer Recall release is available on GitHub.

**Usage:** `/Recall:update`

Check-only — prints the current version, the latest release tag, a short excerpt of the release notes, and the exact `cd <path> && ./update.sh` recipe. It never runs `update.sh` inline because rebuilding the `recall` binary mid-session can corrupt in-flight hook invocations. Exit Claude Code, run the recipe, and restart.

Rate limit: GitHub's anonymous API is 60 requests/hour per IP. On throttle, the command falls back to pointing at <https://github.com/edheltzel/Recall/releases>.

### /Recall:loa

Browse and view Library of Alexandria entries.

**Usage:** `/Recall:loa`

## Installation

Slash command files are installed to `~/.claude/commands/Recall/` during setup. Source files are in `commands/Recall/` in the Recall repository.

If commands are missing after an update, re-run `./install.sh` to copy them.
