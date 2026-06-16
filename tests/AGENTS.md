# tests — automated test suite

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `tests/`.

## Purpose

Automated coverage for the CLI, MCP server, hooks, data layer, libraries, install lifecycle, and benchmarks.

## Ownership

`tests/**` mirroring the source areas — `commands/`, `db/`, `hooks/`, `lib/`, `integration/`, `benchmarks/`, `install/` — plus `fixtures/` (static fixtures, incl. extraction samples) and the shared harness `helpers/setup.ts`. Also `mcp-server.test.ts`, `version.test.ts`.

## Local Contracts

- Runner is `bun:test` — NOT vitest, despite the devDependency. Import from `bun:test`.
- Test files are `tests/**/*.test.ts`.
- Reuse `fixtures/` rather than inlining large fixtures; use `helpers/setup.ts` for harness setup.
- `install/` tests exercise `install.sh` / `update.sh` / `uninstall.sh` — keep them current when those scripts change.

## Work Guidance

- Mirror the source layout: a test for `src/commands/foo.ts` goes in `tests/commands/`; a hook test in `tests/hooks/`.

## Verification

- `bun test` runs the whole suite; `bun run lint` for types.

## Child DOX Index

No child docs — subfolders mirror source areas and share these contracts.
