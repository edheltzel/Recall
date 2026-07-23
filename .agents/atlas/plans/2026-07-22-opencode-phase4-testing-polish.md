# Recall OpenCode Phase 4: Testing + Polish

Status: In Progress

Authority: `docs/OPENCODE_INTEGRATION.md:412-464`, promoted scout report, and captain ship instructions.

## Goal

Prove and harden the existing OpenCode adapter without changing Recall core, MCP semantics, host scope, or database ownership.

## Scope

- Add a disposable OpenCode export/drop/extract/search e2e validator with an isolated HOME, RECALL_HOME, RECALL_DB_PATH, and OpenCode configuration.
- Cover export failure and retry, tracker behavior, concurrent OpenCode/Claude writes, and installer JSON/JSONC rollback/preservation behavior.
- Resolve only the #243/#165 worktree/test-environment overlap required for deterministic honest validation.
- Update OpenCode-facing documentation and the focused Unreleased changelog entry.

## Non-goals

Do not implement semantic #240/#241/#226 work, Codex lifecycle capture, a broad installer cleanup, a release/version bump, or production/local Recall installation reconciliation.

## Acceptance

- The validator proves session event to markdown export to drop directory to `RecallBatchExtract` to searchable record.
- Failure/retry and concurrent shared-WAL behavior are asserted in isolated fixtures.
- OpenCode JSON/JSONC config preservation, malformed-config failure, rollback, update, and uninstall behavior are asserted.
- Worker-worktree tests, full Bun tests, lint, shell syntax checks, and package/integration checks pass.
- The verified runtime contract and limitations are documented.

## Delivery slices

1. Add deterministic adapter seams and unit tests for export/retry and runtime evidence.
2. Add the isolated e2e validator and relevant package/CI entry point.
3. Add concurrency and installer rollback coverage, fixing only exposed OpenCode seams.
4. Update docs/changelog, run all checks, commit focused slices, and open a direct PR to `main`.

## Dependencies and references

- #243: worktree lifecycle/config failures and failed-write status contract.
- #165: fresh worktree dependency provisioning.
- #124: existing atomic config-write overlap; do not duplicate it without a test-proven need.
- #236, #237, #238, and #174 remain separate follow-ups.

