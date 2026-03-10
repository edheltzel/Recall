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
hooks/
  SessionExtract.ts    # Stop hook — extracts sessions via Claude Haiku on exit
  BatchExtract.ts      # Cron job — batch extracts missed sessions
  extract_prompt.md    # Extraction prompt template (copied to ~/.claude/MEMORY/)
tests/
  db/                  # Database tests (connection, schema)
  lib/                 # Library tests (memory, embeddings, project)
  helpers/setup.ts     # Test harness
  mcp-server.test.ts   # MCP server tests
  version.test.ts      # Version tests
FOR_CLAUDE.md          # Guide for Claude Code instances (copied to ~/.claude/Recall_GUIDE.md)
install.sh             # Installer with backup/restore, OS detection, MCP + hook registration
tsconfig.json          # TypeScript config
```

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
