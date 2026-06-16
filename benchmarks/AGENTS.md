# benchmarks — wake-up context-efficiency harness

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `benchmarks/`.

## Purpose

Measures how efficiently Recall delivers wake-up memory context, driven by `recall benchmark run`.

## Ownership

- `runner.ts` — benchmark entry point
- `types.ts` — shared benchmark types
- `suites/` — suite definitions (e.g. Suite B wake-up)
- `baselines/` — locked baseline runs for regression comparison
- `results/` — JSONL + Markdown output from runs
- `README.md` — methodology and caveats (authoritative; read before changing a suite)

## Local Contracts

- Methodology lives in `README.md` — read it before interpreting results or editing a suite, and keep it current.
- `baselines/` are locked reference runs. Do not overwrite a baseline without an explicit decision; new runs land in `results/`.

## Work Guidance

- Add a suite: define it under `suites/` and wire it into `runner.ts`.
- The CLI surface is `recall benchmark run` (`src/commands/benchmark.ts`).

## Verification

- `bun test` — runner/suite tests in `tests/benchmarks/`. Compare new runs against `baselines/`.

## Child DOX Index

No child docs.
