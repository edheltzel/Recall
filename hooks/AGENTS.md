# hooks — lifecycle hooks & cron jobs

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `hooks/`.

## Purpose

Standalone scripts that hosts run across a session lifecycle, plus cron jobs that recover missed work and sync Telos.

## Ownership

- `RecallExtract.ts` — Stop hook (extracts sessions via Claude Haiku on exit)
- `RecallStart.ts` — SessionStart hook (tiered L0/L1 memory context injection)
- `RecallPreCompact.ts` — PreCompact hook (flush in-flight messages before compaction)
- `RecallInSession.ts` — PostToolUse + UserPromptSubmit hook. Two independent, default-OFF features on the same fire: the mid-session learning loop (#51, `RECALL_INSESSION_ENABLED=1`) and correction capture (#52, `RECALL_CORRECTIONS_ENABLED=1`). The fast-path proceeds if EITHER flag is on.
- `RecallBatchExtract.ts` — cron (batch-extract sessions missed during crashes)
- `RecallTelosSync.ts` — cron (sync Telos goals/projects into memory)
- `extract_prompt.md` — extraction prompt template (copied to `~/.claude/MEMORY/`)
- `lib/` — shared host-neutral hook helpers; `lib/hosts/` owns native lifecycle payloads, paths, commands, authentication, and extraction providers

Installed as per-file symlinks into `~/.claude/hooks/` from `~/.agents/Recall/shared/hooks/`.

## Local Contracts

- Hooks are SELF-CONTAINED: never import from `src/`. Shared hook logic lives in `lib/` here.
- Generic hook helpers depend on `lib/events.ts`, `lib/extraction-provider.ts`, and the native-provider registry in `lib/hosts/`; native payloads, path encoding, commands, auth, and recursion guards stay in a host adapter.
- Documented DRY exception: small utilities (e.g. bun-path resolution) are intentionally duplicated inside `RecallExtract.ts` / `RecallBatchExtract.ts` so they never reach into `src/`. Do not "DRY this up."
- DB-path resolution is centralized in `lib/db-path.ts` — the CLI and every hook agree through it.
- Shebang `#!/usr/bin/env bun`. No build step — editing the canonical file updates the live symlink.
- Hook registration (`Stop`, `SessionStart`, `PreCompact`, `PostToolUse`, `UserPromptSubmit`) lives in `~/.claude/settings.json`; the installer wires it.

## Work Guidance

- Add a hook helper: create `lib/<name>.ts` (standalone).
- Modify extraction: edit `RecallExtract.ts`; the quality gate is `lib/extraction-quality.ts` (requires SUMMARY + MAIN IDEAS).
- The host-neutral extraction cascade + topic/summary helpers live in `lib/extract-model.ts`; native providers register through `lib/hosts/index.ts`, with Claude-specific behavior in `lib/hosts/claude/extraction-provider.ts`. Reuse the provider interface; don't call a native model command from generic hook code.
- Mid-session learning loop logic is `lib/insession.ts` (pure/dbPath-injectable: config, cadence, window slice, lock-cooperative extraction). `RecallInSession.ts` is the thin hook wrapper.
- Correction capture (#52) is the pure `lib/correction-detector.ts` (two-pass strong/weak+directive/negative classifier) plus `handleCorrection`/`correctionAllowed`/`readCorrectionsConfig` in `lib/insession.ts`. It writes VERBATIM user text, so it `scrub()`s before `writeLearningsBatch` and rate-limits 1-per-3 prompts via the MONOTONIC `prompts_seen`/`last_correction_turn` columns (never the per-window `turns_seen`, which `resetWindow` zeroes).
- Reuse `lib/extraction-{lock,semaphore,tracker}.ts` for locking/concurrency/dedup state — don't reinvent it.
- Claude Code project-folder path encoding is `lib/hosts/claude/path-encoding.ts`.

## Verification

- `bun test` — hook tests in `tests/hooks/` (incl. `path-encoding.test.ts`).

## Child DOX Index

No child docs — `lib/` and `lib/hosts/` share these contracts.
