# Recall OpenCode Phase 4 Handoff

Status: In Progress

Phase: OpenCode integration — Testing + Polish

Source plan: `.agents/atlas/plans/2026-07-22-opencode-phase4-testing-polish.md`

## Current state

OpenCode MCP registration, extraction, compaction context injection, and batch markdown discovery are already present in `opencode/`, `hooks/RecallBatchExtract.ts`, and `lib/install-lib.sh`.

The remaining phase work is real disposable runtime validation, failure/retry observability, concurrent shared-WAL coverage, and installer JSON/JSONC rollback/preservation coverage.

## Next action

Create the isolated OpenCode e2e validator and adapter test seams before changing production behavior.

## Completion evidence required

- Actual runtime/export evidence or an explicit CI-provisioned runtime contract.
- Passing e2e, concurrency, installer, full test, lint, shell syntax, and package/integration validation in a worker worktree.
- Updated OpenCode documentation and focused Unreleased changelog entry.
- Direct PR to `main` with #243 and #165 linked accurately.

## Holds

No unresolved captain product decision is recorded for this phase.

