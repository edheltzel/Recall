# Recall OpenCode Phase 4 Handoff

Status: Complete — implementation branch ready for PR

Phase: OpenCode integration — Testing + Polish

Source plan: `.agents/atlas/plans/2026-07-22-opencode-phase4-testing-polish.md`

## Current state

OpenCode MCP registration, extraction, compaction context injection, and batch markdown discovery are already present in `opencode/`, `hooks/RecallBatchExtract.ts`, and `lib/install-lib.sh`.

The remaining phase work is real disposable runtime validation, failure/retry observability, concurrent shared-WAL coverage, and installer JSON/JSONC rollback/preservation coverage.

## Delivered

- `d5ca134` adds the current OpenCode event/export adapter contract, unit tests,
  disposable runtime e2e, concurrent WAL coverage, and package entry point.
- `a6e18a4` makes OpenCode uninstall JSONC-safe and adds valid/malformed config
  rollback tests.
- `b4e3abd` updates OpenCode integration, installation, upgrade, troubleshooting,
  and changelog documentation.

## Completion evidence required

- Actual OpenCode 1.18.4 runtime/export evidence from the disposable e2e.
- Passing focused e2e, concurrency, installer, lint, and shell syntax validation;
  full-suite and package/integration validation remain the final ship gate.
- Updated OpenCode documentation and focused Unreleased changelog entry.
- Direct PR to `main` with #243 and #165 linked accurately.

## Holds

No unresolved captain product decision is recorded for this phase.
