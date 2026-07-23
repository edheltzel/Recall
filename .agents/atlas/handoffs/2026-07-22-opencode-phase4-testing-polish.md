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
- `a28d544` makes hook SQLite writers wait on short WAL peer transactions and
  proves concurrent record preservation in the isolated e2e.
- `b4e3abd` updates OpenCode integration, installation, upgrade, troubleshooting,
  and changelog documentation.

## Completion evidence required

- Actual OpenCode 1.18.4 runtime/export evidence from the disposable e2e.
- Passing focused e2e, concurrency, installer, lint, shell syntax, and package/
  integration validation. The full suite reached 1,266 pass / 1 fail: the
  unchanged `tests/hooks/RecallExtract-archive-scrub.test.ts` Claude JSONL case
  expects a missing LoA transcript and reproduces in isolation on this base;
  it is outside OpenCode Phase 4 scope and is called out in the PR.
- Updated OpenCode documentation and focused Unreleased changelog entry.
- Direct PR to `main` with #243 and #165 linked accurately.

## Holds

No unresolved captain product decision is recorded for this phase.
