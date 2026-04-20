# Changelog

All notable changes to Recall are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Recall is still pre-1.0. The public surface (CLI, MCP tools, DB schema) is
settling but may still shift in minor versions. Breaking changes in 0.x
releases are called out in the notes below.

## [Unreleased]

_No unreleased changes yet._

## [0.7.22] — 2026-04-20 — "display + link verification"

Two fixes. Minor, but both were real papercuts.

### Fixed

- **`mem --help` and `mem stats` showed "Recall 0.7"** instead of the
  actual patch version. `src/version.ts` was truncating `DISPLAY_NAME`
  to `major.minor`. With the 0.7.11 → 0.7.2 → 0.7.21 → 0.7.22
  patch-level cadence, truncation hid real state and made install
  triage harder. `DISPLAY_NAME` now contains the full `X.Y.Z` version.
  `tests/version.test.ts` updated to assert equality, not substring.
- **`bun link` silent no-op was undetectable.** Prior install/update
  ran `bun link 2>/dev/null` and trusted the exit code. In edge
  cases `bun link` can exit 0 while failing to refresh
  `~/.bun/bin/mem` / `mem-mcp` (e.g., race with an in-use file,
  a bin dir timing glitch, a bun quirk). The script would report
  "[OK] Re-linked" while the bin dir stayed stale — and MCP would
  silently break on the next Claude Code restart. Root cause of the
  "I ran `./update.sh` and then `mem` wasn't executable" class of
  issue.

### Added

- **`recall_verify_global_link`** in `lib/install-lib.sh`. Confirms
  both `~/.bun/bin/mem` and `~/.bun/bin/mem-mcp` exist, are symlinks,
  and resolve to readable dist files. Returns non-zero with a
  diagnostic `ls -la` dump of `~/.bun/bin/mem*` on failure.
- **`recall_link_global`** in `lib/install-lib.sh`. Shared hardened
  link flow used by both `install.sh` Step 4 and `update.sh`
  `step_link_global`. Path: bun link → verify → (on failure) npm
  link → verify → (on failure) exit 1 with a recovery recipe
  (`cd <path> && bun install && bun run build && bun link`).
  The verify step is what catches the silent-no-op.

### Changed

- `install.sh` Step 4 replaces its inline link block with a call to
  `recall_link_global`. Behavior is strictly additive — every case
  the old block handled is still handled, and the silent-no-op case
  now surfaces instead of being swallowed.
- `update.sh` `step_link_global` same — delegates to `recall_link_global`.
  `--dry-run` now narrates `would: bun link (+ verify ~/.bun/bin/mem, mem-mcp)`.

### Tests

- `tests/version.test.ts` — asserts `DISPLAY_NAME === \`Recall \${VERSION}\``.
- 317 tests pass. No new test files — the shell-level verification is
  exercised implicitly by every install/update flow.

### Note on 0.7.22 vs 0.7.21

`0.7.22 > 0.7.21` in semver. This release supersedes 0.7.21 and
should be marked Latest on GitHub. Users on 0.7.21 should update to
0.7.22 so future `./update.sh` runs benefit from the hardened link
verification.

## [0.7.21] — 2026-04-20 — "painless lifecycle"

Same-day follow-up to 0.7.2. Closes the last gap in the three-script
lifecycle goal — _install, update, uninstall should all be painless
and self-healing_. This is the newest stable release; `update.sh --check`
and `/recall:update` should treat it as latest.

### Fixed

- **`update.sh` now re-runs `bun link` after rebuild.** The 0.7.2
  `step_install_and_build` ran `bun install && bun run build` but
  never touched the global symlinks in `~/.bun/bin/`. If a previous
  `bun unlink`, `bun upgrade`, or homedir prune had removed the
  symlinks, rebuild did not restore them. Symptom: `mem` and
  `mem-mcp` vanished from PATH; the `mcpServers["recall-memory"]`
  entry in `settings.json` (which points at
  `/Users/$USER/.bun/bin/mem-mcp`) failed silently on the next Claude
  Code / OpenCode / Pi restart. A long-running MCP process could mask
  the failure because Unix keeps deleted-but-open inodes alive — the
  next restart dropped the inode and MCP broke with no diagnostic.

  `update.sh` now runs `step_link_global` between `step_install_and_build`
  and `step_migrate`, mirroring `install.sh` Step 4: `bun link`, with
  `npm link` (`sudo npm link` on Linux) as fallback. Aborts with a
  clear "re-run ./install.sh to repair" message if both fail.

### Coverage audit — all three scripts now handle link state

| Script | Link action | Location |
|---|---|---|
| `install.sh` | `bun link` → `npm link` fallback | Step 4 (unchanged) |
| `update.sh` | `bun link` → `npm link` fallback | NEW `step_link_global` |
| `uninstall.sh` | `bun unlink` → `npm unlink -g recall-memory` fallback | `run_bun_unlink` (unchanged) |

### Tests

- `tests/install/update.test.ts` — regression assertion on the
  `--dry-run` output (expects `would: bun link`).
- All 317 existing tests still pass.

### Note on version ordering

`0.7.21 > 0.7.2` in semver. This release **does** supersede 0.7.2 and
should be marked Latest on GitHub — every 0.7.2 install is one
missing-symlink away from silently losing MCP on restart. Users on
0.7.11 should upgrade to 0.7.21 directly (0.7.11 → 0.7.21 via
`./update.sh` works end-to-end with this release).

## [0.7.2] — 2026-04-19 — "install lifecycle"

The lifecycle release originally scoped against 0.7.1. Slot kept open
through 0.7.11 (see the 0.7.11 note below); shipping here as 0.7.2 to
honor the plan. Note: `0.7.2 < 0.7.11` in semver ordering — this is a
deliberate back-fill of the gap, not a downgrade. Users already on
0.7.11 already have the Bug 1 and Bug 2 fixes; this release is
purely additive scaffolding (uninstall/update/shared-lib/docs) and
does not touch runtime behavior.

### Added

- **`uninstall.sh`** — surgical removal with preserve-default. Strips
  Recall's hook entries and `mcpServers["recall-memory"]` out of
  `settings.json` (other hooks/servers untouched), removes the six
  Recall-owned files in `~/.claude/hooks/lib/` (never `rm -rf` on the
  shared directory), AST-aware removal of the `## MEMORY` section from
  `~/.claude/CLAUDE.md`, diff-checked removal of `extract_prompt.md`
  (preserves user edits), `bun unlink`, and an optional `--purge` flag
  (double-confirmed) that destroys `memory.db` and the backup tree.
  `--dry-run` narrates without touching. `MEMORY/` is preserved even
  on `--purge`. Covers OpenCode + Pi by default; `--skip-opencode` /
  `--skip-pi` available.
- **`update.sh`** — automated update flow. Version check against GitHub
  Releases API, timestamped backup with `PRE_SHA` recorded in the
  manifest, `git pull --ff-only`, `bun install && bun run build`,
  `mem init` migrations, refresh of hooks + slash commands + guide,
  forced re-registration of all four hooks (permanently prevents the
  Bug 1 class), verification via `mem stats`. On failure, writes a
  `ROLLBACK.txt` recipe to the backup dir with the exact
  `git reset --hard <PRE_SHA>` + rebuild + `install.sh restore`
  commands. Flags: `--check`, `--dry-run`, `--force`, `--no-migrate`,
  `--no-confirm`.
- **`/recall:update` slash command** — check-only. Resolves the Recall
  source via `readlink -f "$(which mem)"`, delegates to
  `./update.sh --check`, prints the exact `cd <path> && ./update.sh`
  recipe. Never runs `update.sh` inline — rebuilding the `mem` binary
  mid-session can corrupt `bun link`'s process tree.
- **`lib/install-lib.sh`** — shared library sourced by `install.sh`,
  `update.sh`, and `uninstall.sh`. Contains backup/log helpers, OS and
  platform detection, MCP registration, `recall_register_hook` (single
  generic idempotent hook writer), `recall_register_all_hooks`, and
  `recall_copy_runtime_files`. Globals use `: "${VAR:=default}"` so
  callers can override before sourcing.
- **`docs/releasing.md`** — maintainer-facing release recipe. Reads
  notes from this CHANGELOG (no drift between release and file).
- **`## Uninstalling` section** in `docs/installation.md` covering the
  preserve-default behavior and flag matrix.
- **`### Onboard` subsection** in `docs/cli-reference.md` documenting
  `mem onboard`, the `|` (pipe) separator rule, and L0-tier rationale.

### Changed

- **`install.sh`** reorganized from 1078 lines to 225 lines. All shared
  logic moved to `lib/install-lib.sh`. External behavior is identical;
  the installer still produces the same `settings.json` and the same
  filesystem layout.
- **`docs/upgrading.md`** restructured into "Check for a new release"
  → "Using update.sh (recommended)" → "Rollback" → "Manual update".
  The previous `./install.sh`-based update path is preserved as the
  manual fallback.
- **`README.md`** — new "First run: set your identity", "Updating",
  and "Uninstalling" subsections under Quick Start.
- **`FOR_CLAUDE.md`** — new Core Rule 7 (suggest `mem onboard` once
  per session if the L0 tier is empty); added `/recall:update` to the
  slash-commands table.

### Fixed

- **Stale `.atlas-plans/` references** swept to `.atlas/` in `CLAUDE.md`
  (project), `.gitignore`, `benchmarks/README.md`, and
  `tests/hooks/SessionRecall.test.ts`. CHANGELOG history untouched.

### Notes for developers

- Top-level `return` statements inside `bun -e` inline scripts are a
  `SyntaxError`. Use `process.exit(0)` instead. All `catch { return; }`
  patterns in the new scripts use `catch { process.exit(0); }`.
- New test files:
  - `tests/install/uninstall.test.ts` (5 tests)
  - `tests/install/update.test.ts` (5 tests)
  - `tests/install/configure-hooks.test.ts` updated to source
    `lib/install-lib.sh` directly instead of `awk`-extracting from
    `install.sh`
- 317 tests pass on this branch (up from 307 pre-M2).

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

### Acknowledgments
The L0/L1 tiered SessionRecall, PreCompact hook, and importance
scoring features shipped in this release were inspired by — and
heavily reshaped from — [MemPalace](https://github.com/MemPalace/mempalace)
(MIT). No MemPalace code is used; see
[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for the full what-we-took,
what-we-rejected (PALACE_PROTOCOL behavioral injection, KG triples),
and credits to the independent critics (lhl, roman-rr, danilchenko,
tentenco) whose analyses shaped our reshape decisions.

## [0.6.2] and earlier

See git history and GitHub releases for earlier changelog entries. The
0.6.x line introduced decision confidence and lifecycle management,
`mem prune`, and the `decision_update` MCP tool.
