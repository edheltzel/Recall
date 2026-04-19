# Recall — Persistent Memory for Claude Code

## Project Overview

Recall gives Claude Code persistent memory across sessions. It's a CLI (`mem`), MCP server (`mem-mcp`), and extraction hook system that stores conversations, decisions, learnings, and breadcrumbs in SQLite with FTS5 search.

**If you're an AI agent that needs to _use_ Recall** (MCP tools, CLI commands, core rules), read [`FOR_CLAUDE.md`](FOR_CLAUDE.md) — it's the guide written specifically for you. This file (`CLAUDE.md`) is for _developing_ the Recall codebase.

## Build & Test

```bash
bun install          # Install dependencies
bun run build        # Build with tsup (ESM, replaces node shebang with bun)
bun test             # Run all tests (bun:test)
bun run lint         # TypeScript type checking (tsc --noEmit)
```

## Project Structure

```
src/
  index.ts             # CLI entry point (Commander)
  mcp-server.ts        # MCP server entry point (@modelcontextprotocol/sdk)
  version.ts           # Version from package.json
  commands/            # CLI subcommands
    add.ts             #   mem add breadcrumb/decision/learning
    doctor.ts          #   mem doctor (health checks)
    dump.ts            #   mem dump (session import + LoA capture)
    embed.ts           #   mem embed backfill/stats, mem semantic, mem hybrid
    import.ts          #   mem import (session JSONL import)
    import-docs.ts     #   mem docs import/list/search/show
    import-legacy.ts   #   mem import-legacy (DISTILLED.md → LoA)
    import-telos.ts    #   mem telos import/list/show/search
    init.ts            #   mem init (database setup)
    loa.ts             #   mem loa write/show/quote/list
    recent.ts          #   mem recent [table]
    search.ts          #   mem search (FTS5)
    show.ts            #   mem show <table> <id>
    stats.ts           #   mem stats
    decision.ts        #   mem decision supersede/revert/list
    prune.ts           #   mem prune (table lifecycle cleanup)
  db/
    connection.ts      # SQLite connection (bun:sqlite, WAL mode)
    schema.ts          # Table definitions and FTS5 indexes
  lib/
    memory.ts          # Core memory operations (search, add, import)
    embeddings.ts      # Ollama vector embeddings for semantic search
    import.ts          # Session JSONL import logic
    project.ts         # Project path utilities
  types/
    index.ts           # Shared TypeScript types
commands/
  recall/              # Slash commands (installed to ~/.claude/commands/recall/)
    dump.md            #   /recall:dump — session flush + LoA capture
    search.md          #   /recall:search — FTS5 search
    recent.md          #   /recall:recent — recent records
    stats.md           #   /recall:stats — database statistics
    add.md             #   /recall:add — add breadcrumb/decision/learning
    doctor.md          #   /recall:doctor — health checks
    loa.md             #   /recall:loa — Library of Alexandria browser
hooks/
  SessionExtract.ts    # Stop hook — extracts sessions via Claude Haiku on exit
  SessionRecall.ts     # SessionStart hook — loads memory context at session start
  lib/                 # Shared hook libraries (extraction-quality.ts, etc.)
  BatchExtract.ts      # Cron job — batch extracts missed sessions
  extract_prompt.md    # Extraction prompt template (copied to ~/.claude/MEMORY/)
tests/
  db/                  # Database tests (connection, schema)
  lib/                 # Library tests (memory, embeddings, project)
  helpers/setup.ts     # Test harness
  mcp-server.test.ts   # MCP server tests
  version.test.ts      # Version tests
docs/
  installation.md      # Prerequisites, install, verify, session extraction, env vars
  cli-reference.md     # Full CLI reference organized by category
  mcp-tools.md         # MCP tool reference with parameters and examples
  architecture.md      # File layout, database tables, search, extraction pipeline
  slash-commands.md     # /recall:* command reference
  troubleshooting.md   # Common issues and fixes (start with mem doctor)
  upgrading.md         # Update, backup/restore, migration system
  OPENCODE_INTEGRATION.md  # OpenCode integration guide
  PI_INTEGRATION.md    # Pi integration guide
assets/
  banner.png           # README banner image
  demo-search.gif      # VHS recording: mem search
  demo-stats.gif       # VHS recording: mem stats
  demo-doctor.gif      # VHS recording: mem doctor
  demo-recent.gif      # VHS recording: mem recent
  demo-*.tape          # VHS tape scripts for re-recording demos
FOR_CLAUDE.md          # Guide for Claude Code instances (copied to ~/.claude/Recall_GUIDE.md)
install.sh             # Installer with backup/restore, OS detection, MCP + hook registration
tsconfig.json          # TypeScript config
```

## Plans Directory (MANDATORY)

**All plans, specs, and design documents MUST be stored in `.atlas/` at the project root.** This applies to every agent, skill, plugin, and extension — no exceptions.

- Claude Code `EnterPlanMode` plans → `.atlas/plans/`
- Superpowers plugin plans and specs → `.atlas/plans/` and `.atlas/specs/`
- Any skill or extension that generates planning artifacts → `.atlas/plans/`
- Handoff documents → `.atlas/handoffs/`
- Completed plans → `.atlas/plans/archive/`

**Never store plans in `docs/`.** The `docs/` directory is exclusively for user-facing published documentation.

## Key Conventions

- **Runtime**: Bun (not Node). Uses `bun:sqlite` directly. Shebangs are `#!/usr/bin/env bun`.
- **Build**: tsup produces ESM. Build script replaces node shebang with bun shebang.
- **Database**: SQLite at `~/.claude/memory.db`. WAL mode. FTS5 full-text search with sync triggers.
- **MCP registration**: User scope in `~/.claude/settings.json` under `mcpServers` (not `.mcp.json`).
- **Hook registration**: `Stop` event in `~/.claude/settings.json` under `hooks.Stop`.
- **Hooks are self-contained**: `SessionExtract.ts` and `BatchExtract.ts` are standalone scripts copied to `~/.claude/hooks/`. They don't import from `src/`. Duplication of utilities (like bun path resolution) is intentional.
- **Shell-to-JS safety**: `install.sh` passes variables to `bun -e` via environment variables, never shell interpolation in JS strings.
- **Tests**: `bun:test` (not vitest, despite devDependency). Test files at `tests/**/*.test.ts`.
- **No Fabric dependency**: Fabric is optional. Core functionality works without it.

## Common Tasks

- **Add a CLI command**: Create `src/commands/foo.ts`, wire it in `src/index.ts`
- **Add an MCP tool**: Add handler in `src/mcp-server.ts`
- **Modify extraction**: Edit `hooks/SessionExtract.ts` (self-contained, no build step)
- **Update installer**: Edit `install.sh` — validate syntax with `bash -n install.sh`
- **Update the Claude guide**: Edit `FOR_CLAUDE.md` (installer copies it to `~/.claude/Recall_GUIDE.md`)
