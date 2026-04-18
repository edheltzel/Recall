# Changelog

All notable changes to Recall are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Recall is still pre-1.0. The public surface (CLI, MCP tools, DB schema) is
settling but may still shift in minor versions. Breaking changes in 0.x
releases are called out in the notes below.

## [Unreleased]

_No unreleased changes yet._

## [0.7.11] — 2026-04-18 — "initDb ordering hotfix"

Second surgical fix of the day. `install.sh` now succeeds end-to-end for
users upgrading from any 0.6.x release to the current 0.7 line. Version
jumps 0.7.1 → 0.7.11 (skipping 0.7.2–0.7.10) — the lifecycle release
originally scoped as 0.7.2 in the plan keeps its slot open.

### Fixed
- **`initDb()` ran `CREATE_INDEXES` before `applyMigrations()`**
  (`src/db/connection.ts`). Every index that references a post-migration
  column — `idx_messages_importance`, `idx_decisions_importance`,
  `idx_learnings_importance`, `idx_loa_importance` — failed on any DB still
  at `PRAGMA user_version = 7`, with `SQLiteError: no such column:
  importance`. The migration step never ran because the index creation
  aborted first. Effect: `install.sh` step 5 (`mem init`) crashed for every
  user upgrading from 0.6.x, which is why Ed's live install had to be
  hand-migrated via `sqlite3 ALTER TABLE` before step 5 could succeed.

  **Fix:** reorder `initDb()` so `applyMigrations` runs between
  `CREATE_TABLES` and `CREATE_INDEXES`. Documented inline as a runtime
  contract (do not reorder without reading this entry first).

### Added
- Regression test at `tests/db/connection.test.ts` — seeds a v7-schema DB
  with `messages` missing `importance`, calls `initDb()`, asserts no throw
  plus `user_version ≥ 8`, `importance` column present on all four
  migrated tables, and `idx_*_importance` indexes exist. Pre-0.7.11 this
  throws; post-fix it passes.

### Notes
- **Same root pathology as 0.7.1's hook bug:** a side-effect function
  running in an order that assumes something it hadn't verified. Both bite
  precisely on the upgrade path, never on fresh install. The upcoming
  lifecycle release should codify an explicit ordering discipline in the
  shared `install-lib.sh`.
- The version jump (0.7.1 → 0.7.11) skips 0.7.2 through 0.7.10 to keep the
  previously-planned 0.7.2 lifecycle release slot available. All standard
  semver tooling treats 0.7.11 as strictly greater than 0.7.2, so this is
  safe from an ordering perspective.

### Upgrading from 0.7.1
```bash
cd /path/to/Recall
git pull --ff-only origin main
bun install && bun run build
./install.sh
```
No manual DB intervention required — `initDb()` now migrates cleanly from
any pre-0.7.0 schema.

## [0.7.1] — 2026-04-18 — "hook re-registration hotfix"

Surgical fix release for two v0.7.0 regressions surfaced by live verification.

### Fixed
- **`install.sh configure_hooks()` silently skipped three hooks on re-install.**
  A blanket `grep -q SessionExtract … return` short-circuit fired after
  copying hook files but before registering `TelosSync`, `SessionRecall`, and
  `SessionPreCompact`. Any re-install where `SessionExtract` was already
  present left the other three unregistered — which meant v0.7.0's tiered
  SessionRecall and PreCompact flush were architecturally inactive for any
  user who had installed a prior Recall version. Fresh installs always hit
  the happy path, which is why the existing test suite did not catch it.
  Each per-hook `bun -e` block already has `.some(...includes(...))`
  idempotency guards, so removing the outer early-return is the whole fix.
- **`mem onboard --yes` default used deprecated `.atlas-plans/` path.** The
  Atlas namespace moved to `.atlas/plans/` + `.atlas/handoffs/` on
  2026-04-18; `src/commands/onboard.ts` still referenced the old path,
  baking the wrong convention into every non-interactive onboarding run.

### Added
- `tests/install/configure-hooks.test.ts` — regression suite covering fresh
  install + re-install (with the three other hooks manually wiped) +
  idempotent double-run. Drives the bash function via
  `eval "$(awk ...)"` because macOS bash 3.2's `source <(...)` has a
  process-substitution bug that fails to persist function definitions.

### Notes
- 306 tests pass (303 baseline + 3 new regression tests).
- The `.atlas-plans/` stale-reference sweep across remaining files
  (`benchmarks/README.md`, `.gitignore`, `tests/hooks/SessionRecall.test.ts`
  comment, root `CLAUDE.md`) is deferred to the upcoming 0.7.2 release.
- The broader install-lifecycle release originally scoped as 0.7.1 shifts
  to **0.7.2** — the hotfix claims the 0.7.1 slot to satisfy strict-semver
  guards. See `.atlas/plans/2026-04-18-recall-0.7.1-lifecycle.md`.

**After upgrading from 0.7.0:** re-run `./install.sh` to register the
three hooks that the earlier installer skipped. Verify with
`jq '.hooks' ~/.claude/settings.json` — all four of `SessionExtract`,
`SessionRecall`, `TelosSync`, and `SessionPreCompact` should appear.

## [0.7.0] — 2026-04-18 — "v2 foundation"

A large release. Recall's session-context loading is rewritten as a tiered
system (L0 identity + L1 importance-ranked top records), importance scoring
lands as a first-class concept, and a new benchmark harness makes context
efficiency measurable. An interactive onboarding command closes the UX gap
for the new L0 tier.

### Added
- **Tiered SessionRecall** (L0 + L1). `hooks/SessionRecall.ts` now loads
  two distinct tiers at session start:
  - **L0 — Identity** — small user-authored markdown file
    (`~/.claude/MEMORY/identity.md` or project-local
    `./.atlas-recall/identity.md`). Always on, always first. Capped at
    1200 chars (truncated silently on read if exceeded).
  - **L1 — Importance-ranked** — top 12 records across messages,
    decisions, learnings, and LoA entries, ranked by the new `importance`
    column, with 4 slots reserved for LoA entries.
- **Importance scoring** — new `importance INTEGER (1-10)` column on the
  `messages`, `decisions`, `learnings`, and `loa_entries` tables.
  LoA entries have a write-time floor of 5 (enforced by `createLoaEntry`)
  and are never demoted by backfill.
- **PreCompact hook** — `hooks/SessionPreCompact.ts` flushes in-flight
  messages to SQLite before Claude Code compacts its own context, using a
  byte-offset watermark to avoid re-reading. Cooperates with the Stop
  hook's extraction lock so the two don't race.
- **Benchmark harness** — `benchmarks/runner.ts` with Suite B (token
  efficiency). Produces JSONL result files plus human-readable reports.
- **`mem onboard`** — interactive 7-question interview that creates the L0
  identity file. Flags: `--project` (write project-local), `--print`
  (preview without writing), `--yes` (accept all defaults for CI),
  `--out <path>` (override destination). Backs up existing file to `.bak`
  before overwrite; atomic write via `.tmp + renameSync`.
- **`mem importance backfill`** — heuristic backfill for the new importance
  column using confidence signals. Dry-run by default; pass `--execute`.
  Scopes: `decisions`, `learnings`, `loa_entries`, or `all`.
- **`mem pin <table> <id> [importance]`** / **`mem unpin <table> <id>`** —
  manually pin a record to a high importance (default 10) or reset to
  table default. LoA floor of 5 is enforced.
- **`mem benchmark run/list/report`** — run benchmark suites, list
  available suites, show the latest report.
- **MCP `memory_add` `importance` param** — accepts 1-10 on insert.
- **`RECALL_IDENTITY_PATH` environment variable** — override the L0
  identity file location. Honored by both `hooks/SessionRecall.ts` (read)
  and `mem onboard` (write). Precedence order in `mem onboard`:
  `--out > RECALL_IDENTITY_PATH > --project > global default`.
- **`install.sh` post-install recommendation** — installer now prints a
  step recommending `mem onboard` so the L0 tier is populated on first
  run.

### Changed
- Onboarding uses the canonical `detectProject` helper from `src/lib/project.ts`
  (inherits its path-injection guard) instead of reimplementing git-remote
  parsing locally.
- **Schema migration 7→8** — adds the `importance` column to four tables.
  Additive, non-destructive; existing rows receive the default value. Runs
  automatically on first `mem init` (including via `./install.sh`).
- **Wake-up context size** — measured at 5,961 chars / ~1,491 tokens for
  the v2 default bundle, down from 8,020 chars for the v1 baseline
  (34.5% smaller) and 8,760 chars for the CLAUDE.md baseline (47% smaller).
  Numbers are project-dependent; run `mem benchmark run B` locally to see
  your own.

### Infrastructure
- New `benchmarks/` directory with methodology doc (`benchmarks/README.md`)
  and result storage (`benchmarks/results/`).
- 5 methodology rules locked in for benchmark reproducibility (documented
  in `benchmarks/README.md`).

### Migration notes
No user action is required to upgrade — schema migrations apply
automatically. **Recommended post-upgrade:** run `mem onboard` once to
seed the L0 identity tier (otherwise `v2_l0_chars` stays at 0 in
benchmarks and the L0 section of session context is empty).

## [0.6.2] and earlier

See git history and GitHub releases for earlier changelog entries. The
0.6.x line introduced decision confidence and lifecycle management,
`mem prune`, and the `decision_update` MCP tool.
