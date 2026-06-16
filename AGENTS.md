# Recall — Persistent Memory for AI Coding Agents

> **Canonical agent guide.** This is the single source of truth for developing Recall, written to the cross-agent [`AGENTS.md`](https://agents.md) standard. `CLAUDE.md` is a thin shim that `@`-imports this file so Claude Code loads it automatically — do not duplicate content there. See **Agent Context Files** at the bottom.

## Project Overview

Recall gives AI coding agents persistent memory across sessions. It's a CLI (`recall`), MCP server (`recall-mcp`), and extraction hook system that stores conversations, decisions, learnings, and breadcrumbs in SQLite with FTS5 search. It targets Claude Code first, with OpenCode and Pi as additional supported hosts.

**If you're an AI agent that needs to _use_ Recall** (MCP tools, CLI commands, core rules), read [`FOR_CLAUDE.md`](FOR_CLAUDE.md) — it's the guide written specifically for you. This file (`AGENTS.md`) is for _developing_ the Recall codebase.

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
    add.ts             #   recall add breadcrumb/decision/learning
    benchmark.ts       #   recall benchmark run (wake-up context efficiency)
    cluster.ts         #   recall cluster (semantic clustering over embeddings)
    decision.ts        #   recall decision supersede/revert/list
    doctor.ts          #   recall doctor (health checks)
    dump.ts             #   recall dump (session import + LoA capture)
    embed.ts           #   recall embed backfill/stats, recall semantic, recall hybrid
    import.ts          #   recall import (session JSONL import)
    import-docs.ts     #   recall docs import/list/search/show
    import-legacy.ts   #   recall import-legacy (DISTILLED.md → LoA)
    import-telos.ts    #   recall telos import/list/show/search
    importance.ts      #   recall pin / unpin / importance backfill
    init.ts            #   recall init (database setup)
    loa.ts             #   recall loa write/show/quote/list
    onboard.ts         #   recall onboard (7-question L0 identity interview)
    prune.ts           #   recall prune (table lifecycle cleanup)
    recent.ts          #   recall recent [table]
    search.ts          #   recall search (FTS5)
    show.ts            #   recall show <table> <id>
    stats.ts           #   recall stats
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
    db-path.ts              # Shared DB-path resolver (CLI + hooks agree)
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
  runner.ts            # Benchmark entry point (recall benchmark run)
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
  troubleshooting.md   # Common issues and fixes (start with recall doctor)
  upgrading.md         # Update, backup/restore, migration system
lib/
  install-lib.sh       # Shared bash functions for install.sh / update.sh / uninstall.sh
assets/
  banner.png           # README banner image
  demo-search.gif      # VHS recording: recall search
  demo-stats.gif       # VHS recording: recall stats
  demo-doctor.gif      # VHS recording: recall doctor
  demo-recent.gif      # VHS recording: recall recent
  demo-*.tape          # VHS tape scripts for re-recording demos
ACKNOWLEDGMENTS.md     # Credits to MemPalace (ideas reshaped) + independent critics
AGENTS.md              # Canonical agent dev guide (this file)
CLAUDE.md              # Shim — @-imports AGENTS.md so Claude Code auto-loads it
CHANGELOG.md           # Release notes and breaking changes
FOR_CLAUDE.md          # Guide for Claude Code instances (copied to ~/.claude/Recall_GUIDE.md)
FOR_OPENCODE.md        # Guide for OpenCode instances
FOR_PI.md              # Guide for Pi instances
install.sh             # Installer with backup/restore, OS detection, MCP + hook registration
update.sh              # Updater: pull, rebuild, migrate, re-register hooks (--check for dry-run)
uninstall.sh           # Surgical remove (preserves ~/.agents/Recall/); --purge for full wipe
tsconfig.json          # TypeScript config
```

## Check GitHub Issues Before Planning (MANDATORY)

**Before producing any plan, design, or proposal — and before opening a new issue — search this repo's GitHub issues to confirm the work isn't already tracked.** A bug, enhancement, or feature is often already documented; planning or filing without checking duplicates effort and fragments the record.

- Search open **and** closed issues — a closed issue may carry a prior decision, a rejected approach, or context that reshapes the plan.
- Use `gh` (never the web UI or raw API): `gh issue list --search "<keywords>" --state all`, then `gh issue view <n>` for any near-match.
- If a matching issue exists: extend or reference it rather than starting fresh. Link it in the plan and surface it to the user before proceeding.
- If none exists: proceed, and reference the new issue number once filed.

This applies to every agent and every planning surface (`EnterPlanMode`, design docs, proposals) — no exceptions.

## Plans Directory (MANDATORY)

**All plans, specs, and design documents MUST be stored in `.agents/atlas/` at the project root.** This applies to every agent, skill, plugin, and extension — no exceptions.

- Plan-mode / design plans (e.g. Claude Code `EnterPlanMode`) → `.agents/atlas/plans/`
- Superpowers plugin plans and specs → `.atlas/plans/` and `.agents/atlas/specs/`
- Any skill or extension that generates planning artifacts → `.agents/atlas/plans/`
- Handoff documents → `.agents/atlas/handoffs/`
- Completed plans → `.agents/atlas/plans/archive/`

**Never store plans in `docs/`.** The `docs/` directory is exclusively for user-facing published documentation.

## Scout Artifacts Directory (MANDATORY)

Codebase scout reports (`/Recall:scout`, see `commands/Recall/scout.md`) are **chat-only by default — write nothing to disk.** When a scout report (or any generated agent artifact) is persisted, it MUST be written to `.agents/atlas/artifacts/` — and only there.

- Generated scout reports and agent artifacts → `.agents/atlas/artifacts/`
- This directory is **opt-in**: write to it only when it already exists or the user explicitly asks for a saved report
- File naming: `YYYY-MM-DD-scout-<focus>.md` (kebab-case)
- `.agents/atlas/handoffs/` stays **reserved for session handoff documents** — never write scout artifacts there

**Codebase map:** an interactive visual map of this codebase (topology diagram + module cards, built from the codegraph index) lives at `.agents/atlas/artifacts/2026-06-10-recall-codebase-map.html`. It is a local artifact (`.agents/` is gitignored) — open it in a browser for orientation, and regenerate it after major structural changes rather than hand-editing it.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `edheltzel/Recall`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: use root `CONTEXT.md` when present and root `docs/adr/` for architectural decisions. See `docs/agents/domain.md`.

## DRY — Single Source of Truth (MANDATORY)

**Don't Repeat Yourself.** Every piece of knowledge — logic, configuration, prompt/workflow text, user-facing copy — must have exactly one authoritative definition. Duplication is treated as a defect, not a style preference.

- **Code**: extract shared logic into one function/module and call it; never copy-paste a block to a second location. If you are about to duplicate more than ~3 lines, factor it out first.
- **Lifecycle scripts**: shared behavior lives in `lib/install-lib.sh` only — never re-implemented across `install.sh` / `update.sh` / `uninstall.sh`.
- **Prompt / guide / workflow text**: when the same workflow must reach multiple guides (`FOR_CLAUDE.md`, `FOR_PI.md`, `FOR_OPENCODE.md`, `opencode/recall-memory.md`), author the workflow body **once** as a canonical block; each platform guide carries only its platform-specific tool-name mapping plus a reference to that canonical block. Do not hand-copy a full workflow into four files and hope they stay aligned.
- **Agent context files**: this `AGENTS.md` is canonical; `CLAUDE.md` is a shim that imports it. Never copy content into `CLAUDE.md`.
- **Tests / docs**: assert or document a fact in one place; cross-reference rather than restate it.

Before adding code or content, search for an existing definition and extend it. Code review **must** reject diffs that introduce copy-paste duplication.

**Documented exception:** the self-contained hooks (`RecallExtract.ts`, `RecallBatchExtract.ts`) intentionally duplicate small utilities (e.g. bun-path resolution) so they never import from `src/` — see the Key Conventions note below. That carve-out is deliberate; do not "DRY it up."

## Key Conventions

- **Runtime**: Bun (not Node). Uses `bun:sqlite` directly. Shebangs are `#!/usr/bin/env bun`.
- **Build**: tsup produces ESM. Build script replaces node shebang with bun shebang.
- **Database**: SQLite at `~/.agents/Recall/recall.db` (override via `RECALL_DB_PATH`; legacy `MEM_DB_PATH` still accepted). WAL mode. FTS5 full-text search with sync triggers.
- **Install layout**: Canonical files live under `~/.agents/Recall/` (`shared/hooks/`, `claude/commands/Recall/`, `opencode/plugins/`, `pi/extensions/`, `MEMORY/`, `backups/`). Platform homes (`~/.claude/hooks/`, `~/.config/pencode/plugins/`, `~/.pi/agent/extensions/`) receive **per-file symlinks** back to canonicals. The collision rule in `lib/install-lib.sh:recall_link` backs up any existing user file before replacing it with a symlink.
- **MCP registration**: User scope in `~/.claude/settings.json` (or `~/.claude.json` if managed by `claude mcp add`) under `mcpServers`. The `env.RECALL_DB_PATH` block is populated by the installer.
- **Hook registration**: `Stop`, `SessionStart`, `PreCompact` events in `~/.claude/settings.json` under `hooks.*`.
- **Hooks are self-contained**: `RecallExtract.ts`, `RecallStart.ts`, etc. are standalone scripts symlinked into `~/.claude/hooks/` from `~/.agents/Recall/shared/hooks/`. They don't import from `src/`. The shared resolver `hooks/lib/db-path.ts` centralizes DB-path resolution so the CLI and every hook agree.
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

## Agent Context Files

`AGENTS.md` (this file) is the **single source of truth** for agent guidance. To load it, each host points at it its own way:

- **Claude Code** does not read `AGENTS.md` natively — it auto-loads `CLAUDE.md`. So `CLAUDE.md` is a one-line shim containing `@AGENTS.md`, which Claude Code expands into context at launch (the same way an inlined CLAUDE.md would load). All real content lives here.
- Other hosts that honor the `AGENTS.md` standard read this file directly.

**Do not run `/init` in this repo.** Claude Code's `/init` regenerates `CLAUDE.md` from scratch, which would overwrite the `@AGENTS.md` shim with a full duplicate copy and silently reintroduce the drift this layout exists to prevent. If `CLAUDE.md` ever ends up with content other than the import line, restore it to the shim and move any new guidance into this file.


# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

## Child DOX Index

Child AGENTS.md files own domain-specific local rules. Read the applicable one before editing inside its subtree.

- [`src/AGENTS.md`](src/AGENTS.md) — `recall` CLI (Commander), `recall-mcp` MCP server, SQLite data layer, core memory ops
- [`hooks/AGENTS.md`](hooks/AGENTS.md) — self-contained lifecycle hooks + cron jobs (never import from `src/`)
- [`tests/AGENTS.md`](tests/AGENTS.md) — `bun:test` suite mirroring source areas, plus install-lifecycle tests
- [`benchmarks/AGENTS.md`](benchmarks/AGENTS.md) — wake-up context-efficiency benchmark harness
- [`docs/AGENTS.md`](docs/AGENTS.md) — user-facing published docs, ADRs, agent skill docs (never plans/specs)
- [`commands/AGENTS.md`](commands/AGENTS.md) — `/Recall:*` slash-command definitions

Owned at root (no child doc): lifecycle scripts (`install.sh`, `update.sh`, `uninstall.sh`) + their shared `lib/install-lib.sh`; platform guides (`FOR_CLAUDE.md`, `FOR_OPENCODE.md`, `FOR_PI.md`); `CONTEXT.md`; and `assets/` (banner + VHS demo tapes/gifs).
