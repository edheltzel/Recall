# Recall Benchmarks (Phase 2)

> Status: Suite B (token efficiency) and Suite C (precision under noise) implemented. Suites A / D / E are scaffolded in the runner but not yet built. See `.atlas/plans/2026-04-17-mempalace-research-borrow-list.md` for the full Phase 2 design.

## Why this exists

The MemPalace research surfaced a discipline gap: their headline numbers (96.6% R@5, 30x compression) blended retrieval-presence with answer-accuracy, and conflated the vector DB's contribution with the system's spatial metaphor. We do not want to make the same mistake.

This harness exists so every claim Recall makes about persistent memory is traceable to a specific number with a specific methodology.

## Usage

```bash
# Run all available suites
recall benchmark run

# Run a single suite
recall benchmark run B

# Scope to a specific project
recall benchmark run B --project atlas-recall

# List what's available
recall benchmark list
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
| C | Precision under noise | **Built** | P@5 / R@5 / MRR@5 + latency p50/p95 at corpus sizes 100 / 1k / 10k / 100k |
| D | Structured-knowledge fidelity | Planned | Supersession correctness, LoA elevation in mixed results |
| E | Real-world replay | Planned | Help-rate and wrong-direction-rate on anonymized session history |

## Suite C methodology — precision under noise

Suite C answers one question: **when the database is full of junk, does `search()` still surface the right record?**

- **Corpus.** For each size in the ladder (default 100 / 1,000 / 10,000 / 100,000 records), a synthetic corpus is built in a temporary DB using the real schema (`initDb()`) and the real write paths from `src/lib/memory.ts`, so FTS triggers populate exactly as in production. The user's real DB is never touched.
- **Determinism.** Fixture generation is seeded (mulberry32, default seed 47). The same seed and size produce byte-identical record content, so runs are comparable across machines and over time. Tests assert this.
- **Ground truth.** A fixed set of target records (constant across sizes) carries labels: table, project, and provenance. The rest of the corpus is noise in three roles: near-duplicates of targets (the precision trap), entity-name collisions, and low-signal filler. Noise spans all five searchable tables, including messages.
- **Queries.** Four labeled categories: exact project/name lookup, paraphrased decision lookup, learning/problem lookup, and noisy ambiguous queries. Ambiguous queries carry explicit collision labels (name / project / topic) so failures can be attributed to entity ambiguity vs generic ranking noise.
- **Metrics.** Precision@5, Recall@5, and MRR@5 per corpus size, plus breakdowns by query category, by ground-truth table (`r_at_5_table_*`), and by provenance (`r_at_5_prov_*`). No composite scores, per the methodology rules.
- **Latency.** One unmeasured warmup pass per corpus size, then 5 measured repeats per query on a warm connection; p50/p95 are computed across all measured calls at that size. The report caveats state the protocol and whether the embedding service was available — Suite C exercises the FTS5 keyword path only.
- **Baseline-first.** The first run records an honest baseline; there is no pass/fail threshold. Later regression gating can diff runs against the checked-in baseline JSONL in `benchmarks/results/`.
- **Overrides.** `RECALL_BENCH_C_SIZES` (comma-separated) and `RECALL_BENCH_C_REPEATS` override the corpus ladder and repeat count — used by tests to keep CI fast; leave unset for comparable real runs. `RECALL_BENCH_C_DEDUP=1` runs `recall dedup --execute` (exact + stored-embedding semantic, non-destructive marking) over each corpus between seeding and measurement, so a run can be diffed against the no-dedup baseline (issue #78); default off, so the baseline path is unchanged. `RECALL_BENCH_C_EMBED_BACKFILL=1` (issue #99) additionally backfills embeddings for every dedup-eligible record before that dedup pass — via the real embedding service — so the semantic pass actually runs instead of skipping; it requires `RECALL_BENCH_C_DEDUP=1` and a reachable embedding service (it throws rather than fabricating vectors), and is default off so both the baseline and the #78 exact-only paths are unchanged.

## Adding a new suite

1. Create `benchmarks/suites/suite-<id>-<name>.ts` exporting `runSuite<id>(): Promise<SuiteResult>`.
2. Add a case in `benchmarks/runner.ts:dispatchSuite`.
3. Add tests under `tests/benchmarks/`.
4. Update this README.
