# tests — automated test suite

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `tests/`.

## Purpose

Automated coverage for the CLI, MCP server, hooks, data layer, libraries, install lifecycle, and benchmarks.

## Ownership

`tests/**` mirroring the source areas — `commands/`, `db/`, `hooks/`, `hosts/`, `lib/`, `plugins/`, `integration/`, `benchmarks/`, `install/` — plus `fixtures/` (static fixtures, incl. extraction samples) and the shared harness `helpers/setup.ts`. Also `mcp-server.test.ts`, `version.test.ts`.

## Local Contracts

- Runner is `bun:test` — NOT vitest, despite the devDependency. Import from `bun:test`.
- Test files are `tests/**/*.test.ts`.
- Reuse `fixtures/` rather than inlining large fixtures; use `helpers/setup.ts` for harness setup.
- `install/` tests exercise `install.sh` / `update.sh` / `uninstall.sh` — keep them current when those scripts change.
- Any end-to-end test that can open SQLite must set its own disposable `RECALL_DB_PATH` and `RECALL_HOME`, state those paths before writes, and prove the production database was not changed.
- **A test that claims to exercise concurrency must contend across PROCESSES.** The SQLite writers are synchronous, so `Promise.all` over two of them just runs them back to back and passes on code that loses records. Model contention on `peerHoldingWriteLock` in `hooks/sqlite-writers-concurrency.test.ts`, and prove the new test fails against the unfixed code before trusting it.
- Assert ordering, not elapsed wall-clock. A `toBeGreaterThan(<ms>)` floor is a flake on a loaded runner; have the peer stamp a timestamp while it still holds the resource and assert a happens-before against that.

## Work Guidance

- Mirror the source layout: a test for `src/commands/foo.ts` goes in `tests/commands/`; a hook test in `tests/hooks/`.
- `scripts/e2e-codex-plugin.ts` owns the isolated current-CLI verification for the native Codex marketplace, plugin install, and all nine MCP tools.
- `scripts/e2e-claude-plugin.ts` does the same for Claude, and additionally seeds a legacy lifecycle install to prove the migration removes the duplicate skill symlinks and MCP registration idempotently. It must isolate the Claude home too (`HOME` + `CLAUDE_DIR`), not just the database, and assert both were left unchanged.
- `scripts/e2e-pi-integration.ts` owns the isolated current-CLI verification for Pi's separate package, MCP adapter/config, lifecycle capture, and all nine skills/tools.
- OpenCode is split across two scripts on purpose. `scripts/e2e-opencode.ts` owns the pipeline (export → drop → `RecallBatchExtract` → search, plus retry, concurrent writers, installer/uninstall JSONC); it imports the adapter and supplies its own `$` and event payload, so it can never prove what the host actually does. `scripts/e2e-opencode-runtime.ts` owns the live-server contract — plugin discovery from the installed path, zero plugin load errors, OpenCode's own `session.idle` emission and frequency, and multi-turn drop completeness. Put host-behaviour claims in the runtime script; a claim the pipeline script cannot support does not belong in it.

## Verification

- `bun test` runs the whole suite; `bun run lint` for types.

## Child DOX Index

No child docs — subfolders mirror source areas and share these contracts.
