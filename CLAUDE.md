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
    benchmark.ts       #   mem benchmark run (wake-up context efficiency)
    cluster.ts         #   mem cluster (semantic clustering over embeddings)
    decision.ts        #   mem decision supersede/revert/list
    doctor.ts          #   mem doctor (health checks)
    dump.ts             #   mem dump (session import + LoA capture)
    embed.ts           #   mem embed backfill/stats, mem semantic, mem hybrid
    import.ts          #   mem import (session JSONL import)
    import-docs.ts     #   mem docs import/list/search/show
    import-legacy.ts   #   mem import-legacy (DISTILLED.md → LoA)
    import-telos.ts    #   mem telos import/list/show/search
    importance.ts      #   mem pin / unpin / importance backfill
    init.ts            #   mem init (database setup)
    loa.ts             #   mem loa write/show/quote/list
    onboard.ts         #   mem onboard (7-question L0 identity interview)
    prune.ts           #   mem prune (table lifecycle cleanup)
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
    project.ts         # Project path utilities (with validateDirPath injection guard)
  types/
    index.ts           # Shared TypeScript types
commands/
  Recall/              # Slash commands (installed to ~/.claude/commands/Recall/)
    add.md             #   /Recall:add — add breadcrumb/decision/learning
    doctor.md          #   /Recall:doctor — health checks
    dump.md            #   /Recall:dump — session flush + LoA capture
    loa.md             #   /Recall:loa — Library of Alexandria browser
    recent.md          #   /Recall:recent — recent records
    scout.md           #   /Recall:scout — memory-first codebase scout report
    search.md          #   /Recall:search — FTS5 search
    stats.md           #   /Recall:stats — database statistics
    update.md          #   /Recall:update — version check + update instructions
hooks/
  RecallExtract.ts     # Stop hook — extracts sessions via Claude Haiku on exit
  RecallStart.ts      # SessionStart hook — tiered L0/L1 memory context injection
  RecallPreCompact.ts  # PreCompact hook — flush in-flight messages before compaction
  RecallBatchExtract.ts       # Cron job — batch extracts sessions missed during crashes
  RecallTelosSync.ts          # Cron job — sync Telos goals/projects into memory
  extract_prompt.md     # Extraction prompt template (copied to ~/.claude/MEMORY/)
  lib/                 # Shared hook libraries
    extraction-lock.ts      # Per-session extraction lock
    extraction-migration.ts # Migrate legacy extraction state
    extraction-quality.ts   # Quality gate (requires SUMMARY + MAIN IDEAS)
    extraction-semaphore.ts # Global extraction concurrency limiter
    extraction-tracker.ts   # .extraction_tracker dedup state
    path-encoding.ts        # Claude Code project-folder path encoding (v0.7.23)
    pid-utils.ts            # PID-based stale-lock detection
tests/
  benchmarks/          # Benchmark runner/suite tests
  commands/            # CLI command tests
  db/                  # Database tests (connection, schema)
  fixtures/            # Static test fixtures (incl. extraction samples)
  helpers/setup.ts     # Test harness
  hooks/               # Hook tests (incl. path-encoding.test.ts)
  install/             # install.sh / update.sh / uninstall.sh lifecycle tests
  integration/         # End-to-end integration tests
  lib/                 # Library tests (memory, embeddings, project)
  mcp-server.test.ts   # MCP server tests
  version.test.ts      # Version tests
benchmarks/
  runner.ts            # Benchmark entry point (mem benchmark run)
  types.ts             # Shared benchmark types
  suites/              # Benchmark suite definitions (e.g. Suite B wake-up)
  baselines/           # Locked baseline runs for regression comparison
  results/             # JSONL + Markdown results from benchmark runs
  README.md            # Benchmark methodology and caveats
docs/
  architecture.md      # File layout, database tables, search, extraction pipeline
  cli-reference.md     # Full CLI reference organized by category
  installation.md      # Prerequisites, install, verify, session extraction, env vars
  mcp-tools.md         # MCP tool reference with parameters and examples
  OPENCODE_INTEGRATION.md  # OpenCode integration guide
  PI_INTEGRATION.md    # Pi integration guide
  releasing.md         # Release process (tagging, GitHub release, version bump)
  slash-commands.md    # /Recall:* command reference
  troubleshooting.md   # Common issues and fixes (start with mem doctor)
  upgrading.md         # Update, backup/restore, migration system
lib/
  install-lib.sh       # Shared bash functions for install.sh / update.sh / uninstall.sh
assets/
  banner.png           # README banner image
  demo-search.gif      # VHS recording: mem search
  demo-stats.gif       # VHS recording: mem stats
  demo-doctor.gif      # VHS recording: mem doctor
  demo-recent.gif      # VHS recording: mem recent
  demo-*.tape          # VHS tape scripts for re-recording demos
ACKNOWLEDGMENTS.md     # Credits to MemPalace (ideas reshaped) + independent critics
CHANGELOG.md           # Release notes and breaking changes
FOR_CLAUDE.md          # Guide for Claude Code instances (copied to ~/.claude/Recall_GUIDE.md)
FOR_OPENCODE.md        # Guide for OpenCode instances
FOR_PI.md              # Guide for Pi instances
install.sh             # Installer with backup/restore, OS detection, MCP + hook registration
update.sh              # Updater: pull, rebuild, migrate, re-register hooks (--check for dry-run)
uninstall.sh           # Surgical remove (preserves ~/.agents/Recall/); --purge for full wipe
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

## Scout Artifacts Directory (MANDATORY)

Codebase scout reports (`/Recall:scout`, see `commands/Recall/scout.md`) are **chat-only by default — write nothing to disk.** When a scout report (or any generated agent artifact) is persisted, it MUST be written to `.agents/atlas/artifacts/` — and only there.

- Generated scout reports and agent artifacts → `.agents/atlas/artifacts/`
- This directory is **opt-in**: write to it only when it already exists or the user explicitly asks for a saved report
- File naming: `YYYY-MM-DD-scout-<focus>.md` (kebab-case)
- `.agents/atlas/handoffs/` stays **reserved for session handoff documents** — never write scout artifacts there

## DRY — Single Source of Truth (MANDATORY)

**Don't Repeat Yourself.** Every piece of knowledge — logic, configuration, prompt/workflow text, user-facing copy — must have exactly one authoritative definition. Duplication is treated as a defect, not a style preference.

- **Code**: extract shared logic into one function/module and call it; never copy-paste a block to a second location. If you are about to duplicate more than ~3 lines, factor it out first.
- **Lifecycle scripts**: shared behavior lives in `lib/install-lib.sh` only — never re-implemented across `install.sh` / `update.sh` / `uninstall.sh`.
- **Prompt / guide / workflow text**: when the same workflow must reach multiple guides (`FOR_CLAUDE.md`, `FOR_PI.md`, `FOR_OPENCODE.md`, `opencode/recall-memory.md`), author the workflow body **once** as a canonical block; each platform guide carries only its platform-specific tool-name mapping plus a reference to that canonical block. Do not hand-copy a full workflow into four files and hope they stay aligned.
- **Tests / docs**: assert or document a fact in one place; cross-reference rather than restate it.

Before adding code or content, search for an existing definition and extend it. Code review **must** reject diffs that introduce copy-paste duplication.

**Documented exception:** the self-contained hooks (`RecallExtract.ts`, `RecallBatchExtract.ts`) intentionally duplicate small utilities (e.g. bun-path resolution) so they never import from `src/` — see the Key Conventions note below. That carve-out is deliberate; do not "DRY it up."

## Key Conventions

- **Runtime**: Bun (not Node). Uses `bun:sqlite` directly. Shebangs are `#!/usr/bin/env bun`.
- **Build**: tsup produces ESM. Build script replaces node shebang with bun shebang.
- **Database**: SQLite at `~/.agents/Recall/recall.db` (override via `RECALL_DB_PATH`; legacy `MEM_DB_PATH` still accepted). WAL mode. FTS5 full-text search with sync triggers.
- **Install layout**: Canonical files live under `~/.agents/Recall/` (`shared/hooks/`, `claude/commands/Recall/`, `opencode/plugins/`, `pi/extensions/`, `MEMORY/`, `backups/`). Platform homes (`~/.claude/hooks/`, `~/.config/opencode/plugins/`, `~/.pi/agent/extensions/`) receive **per-file symlinks** back to canonicals. Existing user files at symlink targets get backed up before replacement (collision rule in `lib/install-lib.sh:recall_link`).
- **MCP registration**: User scope in `~/.claude/settings.json` under `mcpServers` (not `.mcp.json`).
- **Hook registration**: `Stop` event in `~/.claude/settings.json` under `hooks.Stop`.
- **Hooks are self-contained**: `RecallExtract.ts` and `RecallBatchExtract.ts` are standalone scripts copied to `~/.claude/hooks/`. They don't import from `src/`. Duplication of utilities (like bun path resolution) is intentional.
- **Shell-to-JS safety**: `install.sh` passes variables to `bun -e` via environment variables, never shell interpolation in JS strings.
- **Tests**: `bun:test` (not vitest, despite devDependency). Test files at `tests/**/*.test.ts`.
- **No Fabric dependency**: Fabric is optional. Core functionality works without it.

## Common Tasks

- **Add a CLI command**: Create `src/commands/foo.ts`, wire it in `src/index.ts`
- **Add an MCP tool**: Add handler in `src/mcp-server.ts`
- **Modify extraction**: Edit `hooks/RecallExtract.ts` (self-contained, no build step)
- **Add a hook helper**: Create `hooks/lib/foo.ts` — kept standalone so hooks don't import from `src/`
- **Edit lifecycle scripts**: `install.sh`, `update.sh`, and `uninstall.sh` share `lib/install-lib.sh` — put shared bash functions there, not duplicated across scripts. Validate each with `bash -n`.
- **Update the Claude guide**: Edit `FOR_CLAUDE.md` (installer copies it to `~/.claude/Recall_GUIDE.md`). Keep `FOR_OPENCODE.md` and `FOR_PI.md` in sync if lifecycle commands change.
- **Cut a release**: See `docs/releasing.md` for the tag → GitHub release flow.
