# Agent Skills

[Back to README](../README.md)

Recall ships its command surface as [Agent Skills](https://agentskills.io) — one canonical `SKILL.md` per skill under `agent-skills/`. Claude Code and omp receive per-file links in their skill homes; Pi discovers the canonicals directly through Recall's native package manifest. Codex receives generated native adapters in `plugins/recall/skills/`; byte-identical skill text is not treated as behavioral equivalence across hosts. In Claude Code, invoke skills as `/recall-<name>`; the model can also trigger most of them itself when the conversation calls for it.

> **Migrating from `/Recall:*` slash commands?** The old namespaced slash commands were retired in favor of these skills (issue #228) — same bodies, one namespace across all hosts. `install.sh` / `update.sh` remove the stale `~/.claude/commands/Recall/` symlinks automatically. See [Upgrading](upgrading.md).

## Available Skills

### recall-dump

Flush the current session to the database and capture a Library of Alexandria entry. Use this at the end of every session.

**Usage:** `/recall-dump Session Title Here`

What it does:
1. Imports the current session's messages into SQLite
2. Creates a curated LoA entry with Fabric extract_wisdom analysis
3. Makes everything immediately searchable

This skill is user-invoked only — dumping a session is always your call, never the model's. Claude uses `disable-model-invocation: true`; the generated Codex adapter uses `agents/openai.yaml` with `allow_implicit_invocation: false`.

### recall-search

FTS5 full-text search across all memory tables.

**Usage:** `/recall-search kubernetes auth`

Searches messages, LoA entries, decisions, learnings, and breadcrumbs. The skill wraps `recall search`, so human CLI flags work here too:

- `/recall-search database choice -t decisions` — hard-filter to decisions only
- `/recall-search database choice --bias-type decisions` — prefer decisions first, while still returning matching learnings/messages/LoA/breadcrumbs
- `/recall-search database choice --show-provenance` — show Record Provenance for every result (by default only unknown provenance is flagged)

Rule of thumb: use `-t` when you want only one table; use `--bias-type` when you want one table first without hiding other context.

### recall-recent

Show recent memory records.

**Usage:**
- `/recall-recent` — all tables
- `/recall-recent decisions` — specific table

### recall-scout

Memory-first orientation for an unfamiliar codebase. Searches Recall before touching git history or source, then produces a structured scout report in chat.

**Usage:**
- `/recall-scout` — scout the whole repo
- `/recall-scout auth` — narrow the scout to a subsystem, path, or question

The report covers: **memory summary** (what Recall already knew), **repo map**, **tech stack** (declared versions from manifests; lockfiles excluded), **key paths**, **decisions & learnings** (the memory tied to each key file), **conventions** (declared + observed + Recall-learned house style), **tests**, **risks**, and **next steps**. It enforces a strict sensitive-data boundary — no secrets, generated/vendored files, the live database, or cross-project memory — and is chat-only by default. Reports are persisted only when the repo endorses it, and then only to `.agents/atlas/artifacts/` (never `.agents/atlas/handoffs/`). Scout grounds its repo map, key paths, and risks in **CodeGraph (primary)** via the external `codegraph` CLI: a `codegraph status --json` probe, a cheap orientation bundle, and at most two narrow `explore` calls — on an unindexed repo scout **offers** `codegraph init` (runs it only if you say yes), with a grep/tree-walk backstop. CodeGraph is optional; scout works fully without one.

### recall-stats

Database statistics — record counts, size, and table breakdown.

**Usage:** `/recall-stats`

### recall-add

Add a structured memory record — breadcrumb, decision, or learning.

**Usage:** `/recall-add`

Claude will prompt for record type and details.

### recall-doctor

Health check all subsystems — database, MCP registration, hooks, extraction, embeddings.

**Usage:** `/recall-doctor`

Run this first when troubleshooting any issue.

### recall-update

Check whether a newer Recall release is available on GitHub.

**Usage:** `/recall-update`

Check-only — prints the current version, the latest release tag, a short excerpt of the release notes, and the exact `cd <path> && ./update.sh` recipe. It never runs `update.sh` inline because rebuilding the `recall` binary mid-session can corrupt in-flight hook invocations. Exit the coding agent, run the recipe, and restart.

Rate limit: GitHub's anonymous API is 60 requests/hour per IP. On throttle, the skill falls back to pointing at <https://github.com/edheltzel/Recall/releases>.

### recall-loa

Browse and view Library of Alexandria entries.

**Usage:** `/recall-loa`

## Installation

Skill canonicals live under `~/.agents/Recall/shared/skills/<name>/`; per-file symlinks are created in each host's skills directory during setup. Source files are in `agent-skills/` in the Recall repository.

The Codex plugin adapters are generated with `bun run build:codex-plugin` and packaged with the native plugin bundle documented in [Codex Integration](CODEX_INTEGRATION.md).

If skills are missing after an update, re-run `./install.sh` to relink them.
