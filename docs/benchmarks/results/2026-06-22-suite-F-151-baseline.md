# Recall Benchmark Run

- **Started:** 2026-06-22T22:17:45.279Z
- **Finished:** 2026-06-22T22:24:58.285Z
- **Recall version:** 1.0.0
- **Host:** darwin-arm64 (Bun 1.3.14)

## Suite F — Search latency

Measures search latency (p50/p95) for the FTS5 keyword, brute-force vector, and hybrid (RRF) paths against seeded synthetic corpora (sizes: 1000, 10000, 100000; seed: 47). Establishes the A0 baseline (#147) for the Search-Performance epic (#146) so the sqlite-vec index (#148) and A1–A4 caches can be verified before/after.

_Ran in 433006 ms at 2026-06-22T22:24:58.285Z._

| Metric | Value | Unit | Scope | vs Baseline |
|---|---:|---|---|---|
| corpus_records | 1000 | count | corpus=1000 | — |
| embeddings_indexed | 1000 | count | corpus=1000 | — |
| fts_latency_p50_ms | 0.54 | ms | corpus=1000 | — |
| fts_latency_p95_ms | 0.792 | ms | corpus=1000 | — |
| vec_latency_p50_ms | 8.283 | ms | corpus=1000 | — |
| vec_latency_p95_ms | 10.169 | ms | corpus=1000 | — |
| vec_index_latency_p50_ms | 2.3 | ms | corpus=1000 | — |
| vec_index_latency_p95_ms | 2.422 | ms | corpus=1000 | — |
| hybrid_latency_p50_ms | 9.515 | ms | corpus=1000 | — |
| hybrid_latency_p95_ms | 11.551 | ms | corpus=1000 | — |
| corpus_records | 10000 | count | corpus=10000 | — |
| embeddings_indexed | 10000 | count | corpus=10000 | — |
| fts_latency_p50_ms | 1.283 | ms | corpus=10000 | — |
| fts_latency_p95_ms | 2.66 | ms | corpus=10000 | — |
| vec_latency_p50_ms | 83.787 | ms | corpus=10000 | — |
| vec_latency_p95_ms | 88.647 | ms | corpus=10000 | — |
| vec_index_latency_p50_ms | 17.872 | ms | corpus=10000 | — |
| vec_index_latency_p95_ms | 19.157 | ms | corpus=10000 | — |
| hybrid_latency_p50_ms | 85.886 | ms | corpus=10000 | — |
| hybrid_latency_p95_ms | 91.555 | ms | corpus=10000 | — |
| corpus_records | 100000 | count | corpus=100000 | — |
| embeddings_indexed | 100000 | count | corpus=100000 | — |
| fts_latency_p50_ms | 4.981 | ms | corpus=100000 | — |
| fts_latency_p95_ms | 26.157 | ms | corpus=100000 | — |
| vec_latency_p50_ms | 901.589 | ms | corpus=100000 | — |
| vec_latency_p95_ms | 976.96 | ms | corpus=100000 | — |
| vec_index_latency_p50_ms | 174.453 | ms | corpus=100000 | — |
| vec_index_latency_p95_ms | 184.298 | ms | corpus=100000 | — |
| hybrid_latency_p50_ms | 918.548 | ms | corpus=100000 | — |
| hybrid_latency_p95_ms | 976.306 | ms | corpus=100000 | — |

### Caveats

- Latency only — NOT relevance. The vector/hybrid paths use DETERMINISTIC synthetic 1024-dim seeded random embeddings (seed 47), not real model embeddings, so their ranking is meaningless. Precision lives in Suite C.
- Latency protocol: 1 unmeasured warmup pass per corpus size, then 12 measured repeats per query on a warm connection; p50/p95 are computed across all measured calls at that size.
- Vector path measures the brute-force O(n) scan inside hybridSearch (SELECT all embeddings + JS cosine loop) — the confirmed bottleneck #148 (sqlite-vec) replaces. It scans every embedding in the corpus per query, so vec/hybrid p50/p95 grow with DB size by design; that growth is the number the epic must flatten.
- vec_index_latency_* is the sqlite-vec native KNN path (#148) — the "after" compared to the brute-force vec_latency "before". It is emitted ONLY when the extension loaded on this host (isVecAvailable); absent on a host without an extension-capable libsqlite3, where production also falls back to the brute-force path.
- The Ollama embed(query) network call is intentionally EXCLUDED — production hybrid latency additionally pays it per query. This suite isolates the in-process scan/fusion cost so before/after deltas reflect the index change, not embedding-service variance.
- Absolute milliseconds are machine- and load-dependent and do NOT transfer across hosts; the harness (corpus, query set, sizes, synthetic vectors) is deterministic, so compare distributions only against runs of this same suite on the same machine.
- Epic SLO (for reference, not gated here): ≤10 ms ideal / ≤50 ms acceptable per query. No pass/fail threshold — baseline-first; re-run post-fix to confirm.
- Default sizes are kept small so the run finishes fast; set RECALL_BENCH_F_SIZES=1000,10000,100000 for the full growth curve.

---
_All metrics are unblended. We do not publish composite scores. See the per-suite caveats before drawing conclusions._