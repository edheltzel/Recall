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

Top-level directories, by purpose (one line each — not a file enumeration):

- `src/` — the `recall` CLI (Commander) + `recall-mcp` MCP server + SQLite data layer + core memory ops
- `hooks/` — self-contained lifecycle hooks + cron jobs (never import from `src/`)
- `tests/` — `bun:test` suite mirroring source areas, plus install-lifecycle tests
- `benchmarks/` — wake-up context-efficiency benchmark harness
- `commands/` — `/Recall:*` slash-command definitions
- `docs/` — user-facing published docs + ADRs (`docs/adr/`) + agent skill docs (`docs/agents/`)
- `lib/` — shared bash for the install / update / uninstall lifecycle scripts
- `opencode/` — OpenCode host integration (plugins / hooks / guide)
- `pi/` — Pi host integration (extensions / hooks)
- `scripts/` — dev / CI helper scripts (version check, e2e)
- `templates/` — install templates (`CLAUDE.md.template`, `mcp.json.template`)
- `assets/` — README banner + VHS demo tapes / gifs

Key root files: `AGENTS.md` (canonical guide), `CLAUDE.md` (shim that `@`-imports it), `CHANGELOG.md`, `FOR_CLAUDE.md` / `FOR_OPENCODE.md` / `FOR_PI.md` (host usage guides), `CONTEXT.md`, `install.sh` / `update.sh` / `uninstall.sh`, `package.json`, `tsconfig.json`.

For the **live source tree** (every file, current symbols, callers), use the **codegraph** index (`codegraph_*` MCP tools / `codegraph_explore`) or `fd` — never an enumerated tree that drifts. `docs/architecture.md` is complementary: it documents the installed/runtime layout under `~/.agents/Recall/`, not the source tree.

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

The tracker uses colon-namespaced labels — `type:*` (kind), `agent:*` (`ready` / `blocked` / `complete`), `risk:*` (judgement required), `needs:human`, plus `needs-triage` / `needs-info` for intake. Labels carry signal the board `Status` field can't; they never mirror a board column. See `docs/agents/triage-labels.md`.

### Board status

Work is tracked across **per-phase GitHub Project boards** (one board per phase: #15 Phase 0 complete, #16 Phase 1, #17 Phase 2, #18 Phase 3, #19 Phase 4). Each board's `Status` field is the single source of truth for position-in-flow. When a PR opens for an item (or a reviewer is dispatched) move its Status to `In Review`; move to `Done` **only after the PR merges** (Done auto-closes the issue). No labels mirror Status. As of 2026-06-18 every board (#15–#19) carries the full `Todo / In Progress / In Review / Done` lifecycle. Canonical rule, per-board field IDs, and the auto-close caveat: `docs/agents/board-status.md`.

### Domain docs

This is a single-context repo: use root `CONTEXT.md` when present and root `docs/adr/` for architectural decisions. See `docs/agents/domain.md`.

### Worker flow

Workers run in an isolated worktree (`/ce-worktree`): verify `pwd` is the worktree root and use worktree-relative paths before the first edit, so changes never leak into the main checkout. See `docs/agents/worker-flow.md`.

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
- **Input-scaled SQL bind lists**: any `IN (...)` or multi-row `VALUES` whose placeholder count grows with input MUST chunk through `src/lib/chunk.ts`'s `chunked()` (conservative 500, under SQLite's bind-variable limit) — never bind the whole list at once. Because hooks can't import `src/` (see above), a hook with an input-scaled list inlines a local equivalent. Enforced by `tests/lib/chunk-audit.test.ts`, which fails when a new input-scaled placeholder list appears outside the allowlist of sites that already chunk.
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

For the full editing procedure (read-before-editing, update-after-editing, hierarchy, child-doc shape, style, closeout), see [`docs/agents/dox-framework.md`](docs/agents/dox-framework.md).

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
