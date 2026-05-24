# Recall Benchmarks (Phase 2)

> Status: Suite B (token efficiency) implemented. Suites A / C / D / E are scaffolded in the runner but not yet built. See `.atlas/plans/2026-04-17-mempalace-research-borrow-list.md` for the full Phase 2 design.

## Why this exists

The MemPalace research surfaced a discipline gap: their headline numbers (96.6% R@5, 30x compression) blended retrieval-presence with answer-accuracy, and conflated the vector DB's contribution with the system's spatial metaphor. We do not want to make the same mistake.

This harness exists so every claim Recall makes about persistent memory is traceable to a specific number with a specific methodology.

## Usage

```bash
# Run all available suites
mem benchmark run

# Run a single suite
mem benchmark run B

# Scope to a specific project
mem benchmark run B --project atlas-recall

# List what's available
mem benchmark list
```

Direct invocation also works:

```bash
bun run benchmarks/runner.ts B atlas-recall
```

## Output

Each run writes two files to `benchmarks/results/`:

- `<timestamp>-<suite>.jsonl` — machine-readable result, one JSON object per line. **Source of truth.** Diffable across runs.
- `<timestamp>-<suite>.md` — rendered markdown report for humans.

## Methodology rules (non-negotiable)

1. **No composite scores.** Each suite reports per-metric numbers with explicit units. The reader interprets.
2. **Retrieval-presence and answer-accuracy are reported separately.** They are different things. We don't blend them.
3. **Caveats are part of the result.** Every suite emits a `caveats` array that is rendered alongside the metrics. No "this number means X is good" — let the reader decide.
4. **Baselines are real, not strawmen.** v1 (flat-blob RecallStart) and CLAUDE.md are the relevant comparisons. We don't compare against "no memory at all" to make ourselves look good.
5. **Token estimates are estimates.** We use chars/4 as a proxy. We do NOT call it a token count; we call it a token *estimate*.

## Suites

| ID | Name | Status | What it measures |
|---|---|---|---|
| A | Cross-session recall | Planned | Retrieval@5 + answer accuracy across N-session synthetic gaps |
| B | Token efficiency | **Built** | Wake-up bundle char/token cost vs v1 baseline and CLAUDE.md |
| C | Precision under noise | Planned | Precision@5 and latency at corpus sizes 100 / 1k / 10k / 100k |
| D | Structured-knowledge fidelity | Planned | Supersession correctness, LoA elevation in mixed results |
| E | Real-world replay | Planned | Help-rate and wrong-direction-rate on anonymized session history |

## Adding a new suite

1. Create `benchmarks/suites/suite-<id>-<name>.ts` exporting `runSuite<id>(): Promise<SuiteResult>`.
2. Add a case in `benchmarks/runner.ts:dispatchSuite`.
3. Add tests under `tests/benchmarks/`.
4. Update this README.
