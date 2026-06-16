# hooks — lifecycle hooks & cron jobs

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `hooks/`.

## Purpose

Standalone scripts that hosts run across a session lifecycle, plus cron jobs that recover missed work and sync Telos.

## Ownership

- `RecallExtract.ts` — Stop hook (extracts sessions via Claude Haiku on exit)
- `RecallStart.ts` — SessionStart hook (tiered L0/L1 memory context injection)
- `RecallPreCompact.ts` — PreCompact hook (flush in-flight messages before compaction)
- `RecallBatchExtract.ts` — cron (batch-extract sessions missed during crashes)
- `RecallTelosSync.ts` — cron (sync Telos goals/projects into memory)
- `extract_prompt.md` — extraction prompt template (copied to `~/.claude/MEMORY/`)
- `lib/` — shared hook helpers

Installed as per-file symlinks into `~/.claude/hooks/` from `~/.agents/Recall/shared/hooks/`.

## Local Contracts

- Hooks are SELF-CONTAINED: never import from `src/`. Shared hook logic lives in `lib/` here.
- Documented DRY exception: small utilities (e.g. bun-path resolution) are intentionally duplicated inside `RecallExtract.ts` / `RecallBatchExtract.ts` so they never reach into `src/`. Do not "DRY this up."
- DB-path resolution is centralized in `lib/db-path.ts` — the CLI and every hook agree through it.
- Shebang `#!/usr/bin/env bun`. No build step — editing the canonical file updates the live symlink.
- Hook registration (`Stop`, `SessionStart`, `PreCompact`) lives in `~/.claude/settings.json`; the installer wires it.

## Work Guidance

- Add a hook helper: create `lib/<name>.ts` (standalone).
- Modify extraction: edit `RecallExtract.ts`; the quality gate is `lib/extraction-quality.ts` (requires SUMMARY + MAIN IDEAS).
- Reuse `lib/extraction-{lock,semaphore,tracker}.ts` for locking/concurrency/dedup state — don't reinvent it.
- Claude Code project-folder path encoding is `lib/path-encoding.ts`.

## Verification

- `bun test` — hook tests in `tests/hooks/` (incl. `path-encoding.test.ts`).

## Child DOX Index

No child docs — `lib/` (db-path, extraction-*, path-encoding, pid-utils) shares these contracts.
