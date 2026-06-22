# Suite F — #151 controlled A/B (read-path PRAGMA tuning + cached statements)

Controlled before/after for PR #172. Both runs are on the **same machine,
back-to-back**, identical harness parameters. The only difference is the two
source lines of #151 — so the deltas are attributable to the change, not to
machine drift. (Single-run Suite F is noisy across separate sessions; this A/B
removes that by reverting only the change-under-test between two adjacent runs.)

## Method

- **baseline** = the #151 source changes reverted (`git checkout HEAD~1 -- src/db/connection.ts src/lib/memory.ts`) — i.e. main's `getDb`/`initDb` PRAGMAs + `search()` using `db.prepare`.
- **after** = the PR as committed — `applyConnectionPragmas()` (adds `cache_size=-65536`, `mmap_size=256MB`, `temp_store=MEMORY`) + `search()` using `db.query`.
- Harness: `RECALL_BENCH_F_SIZES=1000,10000,100000 RECALL_BENCH_F_REPEATS=12 recall benchmark run F`.
- Raw artifacts (this directory): `2026-06-22-suite-F-151-baseline.{md,jsonl}` and `2026-06-22-suite-F-151-after.{md,jsonl}`.
  - Note: the `description` field *inside* those files is the harness's generic Suite-F text (shared by every run); the **file name** and this doc are authoritative for which run is which.

## Results (p50 ms unless noted)

| metric | baseline | after | Δ |
|---|---:|---:|---:|
| fts 1k | 0.540 | 0.452 | −16% |
| fts 10k | 1.283 | 0.995 | −22% |
| fts 100k | 4.981 | 2.325 | −53% |
| fts 100k (p95) | 26.157 | 21.076 | −19% |
| vec_index 1k | 2.300 | 1.368 | −41% |
| vec_index 10k | 17.872 | 11.361 | −36% |
| vec_index 100k | 174.453 | 171.308 | −2% |
| hybrid 1k | 9.515 | 8.593 | −10% |
| hybrid 10k | 85.886 | 78.269 | −9% |
| hybrid 100k | 918.548 | 870.807 | −5% |
| vec (brute) 1k / 10k / 100k | 8.283 / 83.787 / 901.589 | 7.868 / 76.305 / 866.835 | −5 / −9 / −4% |

## Reading it

- **FTS path (the #151 target):** consistent win at every size; the big −53% at 100k is the `mmap_size` effect (large index pages mapped instead of `read()` per page). p50 stays well under the issue's **<10 ms** target everywhere (0.45–2.33 ms).
- **Attribution:** measured in stages during development — the PRAGMAs drive most of the win; the `db.prepare`→`db.query` conversion adds a further consistent ~6–15% on the FTS path on top of PRAGMA (confirmed stable across repeat runs), so it cleared the keep-bar.
- **Brute-force `vec` 100k barely moves (~4%)** — it is CPU-bound on the JS cosine loop, not I/O, so PRAGMAs can't help it (that path is #148's KNN territory). `vec_index` at 100k is also flat (already index-bound); the PRAGMA win there shows at the smaller, page-cache-sensitive sizes.
- No durability change (`synchronous` untouched); `search()` output byte-identical (full test suite green).
