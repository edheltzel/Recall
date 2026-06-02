---
title: MemPalace Research → Recall Borrow List
status: In Progress
percent_complete: 70
last_updated: 2026-06-01
phase: Phase 3 (Postgres/Turso backend) + Phase 4 (non-coding agents) — DRAFT, awaiting decision
blockers: Awaiting Ed's go/no-go on Phase 3 (Turso/libSQL multi-device) and Phase 4 (Slack bot, etc.)
next_action: Review/merge #7 bias_type + --bias-type implementation; then decide Phase 3 priority vs. CLI rename + npm publish
---

# MemPalace Research → Recall Borrow List

**Date:** 2026-04-17
**Status:** Research complete, awaiting Ed's go/no-go on each item
**Source project:** [MemPalace](https://github.com/MemPalace/mempalace) (mempalaceofficial.com)
**Method:** 3 parallel research agents (Perplexity / Codex / Grok) → red-team attack → architect feasibility

---

## Executive Summary

MemPalace is a Python wrapper around ChromaDB with a wings/rooms/drawers spatial metaphor and a separate SQLite knowledge graph. Authored by Milla Jovovich + Ben Sigman, MIT-licensed, ~47k stars in 8 days.

**Independent technical analyses agree on three things:**

1. The headline 96.6% LongMemEval R@5 measures ChromaDB's default embeddings on raw uncompressed text — the spatial hierarchy contributes nothing to that number.
2. AAAK "lossless 30x compression" is provably lossy (12.4 percentage-point retrieval drop in independent tests).
3. The README advertises features (e.g., "contradiction detection") that do not exist in the source.

The roman-rr Gist documents metronomic star-acquisition timing consistent with bot farming. None of this means the project is worthless — it means the marketing is heavily ahead of the engineering, and we should evaluate ideas on architectural merit, not stars.

**Two ideas in MemPalace are genuinely worth learning from for Recall.** Several others are over-fit to MemPalace's specific architecture or solve problems Recall does not have. One is an active security smell.

---

## Verdict Table

| # | Idea from MemPalace | Red Team | Architect cost | Final verdict |
|---|---|---|---|---|
| 1 | Tiered loading L0–L3 in SessionRecall | RESHAPE | S | **BUILD** (reshape: derive from Recall's data, not MemPalace's numbers) |
| 2 | PreCompact hook | RESHAPE | S–M | **BUILD** (reshape: SQLite flush only, no Haiku, delta-only) |
| 3 | Knowledge-graph triples + validity windows | KILL | L (high risk) | **DEFER** (revisit after #1, #4 ship and we have density) |
| 4 | Importance scoring on records | RESHAPE | M | **BUILD** (reshape: integer 1–10 matching existing breadcrumbs, backfill-only) |
| 5 | Behavioral instruction injected into MCP tool responses | KILL | S | **KILL** (prompt-injection attack surface — see analysis) |
| 6 | Multi-format conversation import | RESHAPE | M | **BUILD** (reshape: must pass through Haiku extraction; never bypass the filter) |
| 7 | Type-weighted FTS5 ranking | KILL | S | **IMPLEMENTED** (opt-in `bias_type` param; defaults unchanged) |

---

## Per-Item Detail

### #1 Tiered loading L0–L3 — **BUILD**

**What MemPalace does.** `wake_up()` returns a ~170-token bundle: L0 = identity file always loaded, L1 = top-N important records, L2 = scoped recall on demand, L3 = full semantic search.

**What Recall does today.** `hooks/SessionRecall.ts` returns a flat context blob bounded by `MAX_OUTPUT_CHARS = 8000`. No tiering, no identity file.

**Why this survives the red team.** The objection ("token target is cargo-culted from MemPalace's corpus") is correct, and we will not copy the 170-token figure. The underlying discipline — pre-load identity + a small curated set, leave deep search on demand via existing MCP tools — is independently sound for any agent context.

**Reshape:**
- L0 = `~/.claude/MEMORY/identity.md` (user-edited; if absent, omit silently).
- L1 = top-N records ranked by importance (depends on #4 to be meaningful) — start N = 10 and tune from logs, not from MemPalace's numbers.
- L2/L3 = no new tooling. Document existing `memory_search` and `memory_recall` MCP tools as the on-demand surface in the SessionRecall preamble.

**Files touched.** `hooks/SessionRecall.ts` only. No schema change.

---

### #2 PreCompact hook — **BUILD (reshaped)**

**What MemPalace does.** `mempal_precompact_hook.sh` fires before Claude Code compacts context, dumping memories so they survive the compaction boundary.

**Why this matters for Recall.** Long sessions that never `Stop` lose their pre-compaction state under Recall today. SessionExtract only fires on Stop.

**Why naïvely copying it is dangerous.** The red-team failure mode is real: firing full Haiku extraction on every compaction creates duplicate, fragmented records. Recall has no dedup logic.

**Reshape (architect's recommendation):** PreCompact runs a *flush-to-SQLite* of the current conversation tail — no Haiku call, no LoA generation. Stop continues to do full extraction. PreCompact's job is "don't let in-flight messages die in the compaction."

**Files touched.** New `hooks/SessionPreCompact.ts` (self-contained, like the other hooks). `install.sh` adds the registration block.

**Coordination concern flagged by architect.** `saveExtractionTracker` is a non-atomic `writeFileSync`. If we add a second hook that touches it, the existing `tryAcquireExtractLock` mechanism must cover both paths or be extended.

---

### #3 Knowledge graph triples — **DEFER**

**Why both reviewers were skeptical.** Recall's queries are 95% "find records about X," not "what is the relationship between X and Y." Triples extracted by an LLM without a controlled predicate vocabulary degenerate into a bag of disconnected facts. Architect rated it L complexity with high risk; red team killed it as a navigation feature for a problem we do not have.

**Decision.** Do not build now. Revisit after #1 and #4 ship — at that point we will know whether the importance-ranked, tiered context surfaces relational gaps that triples could fill. If it doesn't, this stays buried.

---

### #4 Importance scoring — **BUILD (reshaped)**

**What MemPalace does.** Float `importance` set during ingestion, used to rank L1 candidates.

**Red-team objection (valid).** Haiku does not know what matters to Ed. A float score is false precision; the L1 tier could fill with verbose, emotionally-loaded messages while one-line architectural decisions get under-weighted.

**Architect note (valid).** `breadcrumbs` already has `importance INTEGER` (1–10). Adding a `REAL` (0.0–1.0) column on other tables would create a dual-type problem.

**Reshape.**
- Use `INTEGER 1–10` everywhere (match existing `breadcrumbs`).
- Default to `5`. Haiku may *suggest* a value during extraction, but the extraction prompt is updated to prefer the extremes (8–10 for explicit user decisions/preferences, 2–3 for routine context, 5 default).
- Backfill-only first cut — no live extraction changes. Run as a batch job (`mem importance backfill`) so we can iterate on scoring without coupling to the hook.
- Add a `mem pin <id>` CLI command for explicit user override (force importance = 10). This is the "pinned" flag the red team asked for, layered on the same column.

**Schema migration.** Additive `ALTER TABLE … ADD COLUMN importance INTEGER DEFAULT 5` on `messages`, `loa`, `decisions`, `learnings`. Update `src/db/schema.ts` and `src/db/migrations.ts`.

---

### #5 PALACE_PROTOCOL injection — **KILL**

**What MemPalace does.** Every `mempalace_status` response embeds a behavioral instruction telling the model to verify before guessing.

**Why this is a kill, not a reshape.** Recall's MCP server runs across multiple hosts (Claude Code, OpenCode, Pi). Embedding model-directed instructions in tool responses is *exactly* the prompt-injection pattern our own `injection_defense_layer` rules tell the model to defend against. A poisoned record could become an attacker-controlled instruction smuggled into the host's context via `mem stats`. The architect rated this S complexity and low-risk; the red team identified the security smell. **Red team is correct here** — the failure mode is real and the alternative (put guidance in `FOR_CLAUDE.md` / system prompt, where it belongs) costs nothing.

**Decision.** Do not ship. If we want to reinforce verification-first behavior, update `FOR_CLAUDE.md` (which the installer copies to `~/.claude/Recall_GUIDE.md`).

---

### #6 Multi-format conversation import — **BUILD (reshaped)**

**What MemPalace does.** `normalize.py` ingests Claude Code JSONL, Claude.ai JSON, ChatGPT JSON, Slack JSON.

**Red-team objection (valid).** Bulk-importing two years of ChatGPT history pollutes FTS5 with low-signal records and collapses search precision.

**Reshape.** `mem import-conversations <path> [--format auto]` with adapters for Claude.ai, ChatGPT, and Slack JSON.
- Default behavior: import → run through Haiku extraction → produce loa/decisions/learnings. Raw messages go in `messages` table for FTS, but they are filtered from default search results (already the model in Recall — `messages` is searchable but lower-priority than curated tables).
- Add `--no-extract` flag for users who explicitly want raw import only, with a console warning about precision impact.

**Schema.** No migration needed — `sessions.source` already exists, `messages` schema accommodates the role mappings (Slack usernames need a `role IN ('user','assistant','system')` mapping; treat all human Slack senders as `user`).

---

### #7 Type-weighted FTS5 ranking — **IMPLEMENTED (opt-in)**

**Architect:** S complexity, low risk, additive `bias_type` parameter on `memory_search`. **Red team:** redundant with the existing `--type` filter, adds opacity to ranking.

Both are right. **Compromise shipped 2026-06-01:** add `bias_type` as an *opt-in* MCP parameter (no default change, no CLI surface yet). Matching table types receive a soft FTS rank boost; other matching types can still appear. Hard filtering via `table` remains the recommended path when the caller needs only one type. If usage proves out, promote it; otherwise deprecate.

---

## Negative Lessons (worth more than the borrow list)

These are things MemPalace did that Recall must NOT do:

1. **Don't ship features in the README that aren't in the code.** MemPalace advertises contradiction detection that doesn't exist. This is a credibility cliff. Recall's `FOR_CLAUDE.md` and `README.md` should be audited for parity with shipped code.
2. **Don't claim lossless when it's lossy.** AAAK's "30x lossless" claim collapsed under independent benchmarking. Any compression / summarization / extraction Recall ships should be characterized in fidelity terms, not just compression ratios.
3. **Don't conflate retrieval-presence with answer accuracy.** MemPalace's 96.6% measures whether the right chunk is in the top-5 — not whether the LLM gives a correct answer. If Recall ever publishes benchmarks, separate the two.
4. **Don't treat star count as validation.** 47k stars in 8 days for a project with no institutional backing is not a quality signal.

---

## Recommended Build Order

If Ed greenlights any of this, the architect's value/cost ranking (after the red-team adjustments above):

1. **#1 Tiered SessionRecall** — pure rewrite of one self-contained file, no schema. (~half-day)
2. **#4 Importance scoring (backfill-only)** — additive migration + batch job. Enables #1's L1 to be meaningful. (~1 day)
3. **#2 PreCompact hook (flush-only)** — new self-contained hook + installer block. (~half-day)
4. **#6 Multi-format import** — new CLI command, format adapters, reuses extraction pipeline. (~1–2 days)
5. **#7 `bias_type` MCP param** — optional, ~1 hour if/when desired.
6. **#3 KG triples** — deferred indefinitely; revisit only if usage of the above reveals a relational query gap.
7. **#5 PALACE injection** — never. Update `FOR_CLAUDE.md` instead.

#1 + #4 form a coherent "context quality" mini-sprint and should ship together.

---

## How the #1 + #4 Sprint Affects the LoA (Ed's question, 2026-04-17)

Short answer: it **elevates** LoA's role, it doesn't dilute it. But only if we wire it correctly. The risk if we wire it carelessly is that Haiku-assigned importance scores override the curation gate that LoA records already passed — that would be a demotion of human/curated judgment to inference.

### Rules to keep LoA's role intact

1. **LoA records get a write-time importance floor (default 8, never below).** LoA is the curated tier — by definition it has already passed quality review. Importance is set at write time (`mem loa write` / extraction-promoted-to-LoA), not by re-scoring later.
2. **Haiku never rescoreS LoA records.** The backfill job in #4 explicitly skips the `loa` table. Importance on LoA is human-authored or extraction-promoted; once written, it's stable.
3. **L1 assembly prefers LoA over other tables when ties exist.** Concretely: when pulling top-N for L1, sort by `(importance DESC, source_table_priority, recency DESC)` where `loa > decisions > learnings > breadcrumbs > messages`. LoA wins ties.
4. **LoA gets reserved slots in L1.** Of the L1 budget, reserve ~30% for the most recent LoA entries unconditionally. This ensures curated knowledge is always in the wake-up bundle even if a flood of high-importance breadcrumbs arrives.
5. **L0 stays identity-only.** LoA is L1, not L0. L0 is the user-edited identity file — small, stable, hand-curated by Ed directly.

### Net effect on LoA

| Property | Today | After #1 + #4 |
|---|---|---|
| Visibility at session start | Mixed in with everything else, capped by 8000-char blob | Reserved L1 slots, always present |
| Importance signal | None on the LoA row itself | Default 8, manual override available |
| Risk of being downgraded by Haiku | N/A | Explicitly excluded from rescoring |
| Curation cost | Same | Same |

So the sprint *promotes* LoA from "one of several tables FTS searches" to "always pre-loaded curated tier." The only schema change for LoA itself is the additive `importance INTEGER DEFAULT 8` column — purely additive, no migration risk.

---

## Phase 2 — Benchmark Validation (Milestone)

**Goal.** Validate Recall's persistent-memory claims with reproducible benchmarks. Honest numbers, published methodology, both retrieval-presence AND answer-accuracy reported separately. Lesson learned from MemPalace: never publish one metric and let readers assume it implies the other.

### What we are measuring against

Three baselines, not one:

1. **Bare Claude Code** — no Recall, no CLAUDE.md beyond minimal. Establishes the "no memory" floor.
2. **Claude Code + CLAUDE.md** — the standard out-of-the-box static memory model. Hand-written project + global instructions, no DB. This is the realistic baseline most users have today.
3. **Claude Code + Recall** — full stack with extraction hooks, MCP tools, FTS5 + embeddings. The system under test.

The Claude Code "memory" comparison is important context for users: CLAUDE.md is *static, manually edited, single-context* memory; Recall is *dynamic, automatically captured, cross-session* memory. They are not competitors — they are complementary layers — and the benchmark should make that visible, not hide it.

### Benchmark suites

**Suite A — Cross-session recall (Recall's core claim).**
Synthetic dataset: 50 multi-session scenarios where session N depends on a fact established in session 1–(N−1). Examples: "you decided in session 3 to use Bun, not Node — does the model remember that in session 12 when adding a new dependency?" Generate scenarios programmatically; vary gap (1 session, 5 sessions, 20 sessions, 100 sessions).
- **Metric A1 — Retrieval-presence (Recall@5):** is the relevant record in the top-5 returned by `memory_search`?
- **Metric A2 — Answer accuracy (Acc):** does the model, given retrieved context, produce the correct answer? Graded by a separate model (Sonnet) against a known-good answer.
- **Report A1 and A2 as separate numbers, never blended.**

**Suite B — Token efficiency.**
For each scenario, measure tokens consumed at session start (SessionRecall payload) and tokens consumed by `memory_search` calls during the session.
- **Metric B1 — Wake-up token cost:** size of L0+L1 bundle (target: derive from observed corpora, not copy MemPalace's 170).
- **Metric B2 — Total memory tokens per task:** sum across the session.
- Compare to CLAUDE.md baseline (which has zero query overhead but a fixed wake-up cost).

**Suite C — Precision under noise.**
Inject N records of irrelevant noise into the database, then run Suite A. Measures whether precision degrades as the corpus grows.
- **Metric C1 — Precision@5 at corpus sizes:** 100, 1k, 10k, 100k records.
- **Metric C2 — Latency at the same sizes.**

**Suite D — Structured-knowledge fidelity.**
Established decisions (with supersession), learnings (with tags), breadcrumbs. Test whether superseded decisions are correctly *not* surfaced as current state, whether tag filters work, whether the LoA layer is preferentially surfaced.
- **Metric D1 — Supersession correctness:** % of queries that return only the active decision when an old one was superseded.
- **Metric D2 — LoA elevation:** in queries where both LoA and breadcrumb records match, does LoA appear first?

**Suite E — Real-world replay (not synthetic).**
Replay Ed's actual session history (last 30 days, anonymized) through Recall and measure how often the agent in session N would have benefited from a record produced by session N−k. This is the "did Recall actually help" measurement, not the "could it in theory."
- **Metric E1 — Help rate:** % of agent decisions where retrieved memory changed the agent's response.
- **Metric E2 — Wrong-direction rate:** % of agent decisions where retrieved memory led to a worse response (yes, this can happen — outdated context can mislead).

### What we will NOT do

- **No LongMemEval as a headline metric.** It measures retrieval over short prepared corpora, not persistent cross-session memory. Useful for sanity-checking embeddings, not for validating the full system.
- **No single composite "Recall score."** Composite metrics hide the trade-offs. Always report per-suite.
- **No comparison-only-against-MemPalace marketing exercise.** The interesting comparison is against CLAUDE.md, the realistic baseline.

### Deliverables

1. `benchmarks/` directory in repo with:
   - Suite generators (TypeScript scripts that produce scenario JSONL)
   - Runner (`bun run benchmarks/run.ts <suite>`)
   - Grader (model-graded answer accuracy with rubric)
   - Results format (JSONL per run, summary markdown)
2. CI integration — at minimum, run Suite A and Suite C on PRs that touch `src/lib/memory.ts`, `src/lib/embeddings.ts`, or hooks. Detect regressions.
3. Public results page in `docs/benchmarks.md` — methodology, raw numbers, interpretation, change log. Honest about weaknesses.
4. **README claim audit** — every persistent-memory claim in `README.md` and `FOR_CLAUDE.md` traceable to a benchmark number, or removed.

### Build order for Phase 2

1. Suite A (synthetic cross-session) — defines the methodology, smallest scope
2. Suite B (token cost) — instrumentation only, no new test data
3. Suite C (precision under noise) — extends Suite A with a noise generator
4. Suite D (structured-knowledge) — independent, can run in parallel
5. Suite E (real-world replay) — last; depends on tooling for anonymized session import

Estimate: Suite A + B + grader = ~3–4 days. Full Phase 2 = ~1.5 weeks. Could be sequenced after the #1+#4 sprint or run in parallel by a different agent — they don't conflict.

### Why this milestone matters independently of MemPalace

Even if we never borrowed anything from MemPalace, Recall needs benchmarks to defend its own claims. The MemPalace research surfaced this need; it is not a borrow item — it is a maturity step Recall needs to take on its own merits.

---

## Sprint #1 + #4 — Status: **SHIPPED 2026-04-17** (commit `61526ce`)
## Sprint #2 — Status: **SHIPPED 2026-04-17** (commit `3cebec0`)
## Phase 2 Suite B — Status: **SHIPPED 2026-04-17** (benchmark harness + Suite B token efficiency)

**First real numbers (run scoped to project=atlas-recall on `~/.claude/memory.db`):**
- v2 tiered SessionRecall: **5,961 chars (~1,491 tokens est)**
- v1 flat blob baseline: 8,020 chars (v2 is **34.5% smaller**)
- CLAUDE.md combined (global + project): 8,760 chars (v2 is **47% smaller**)
- L1 holds 12 records, **5 of which are LoA** (one above the 4-slot reservation floor — curated knowledge is being elevated by importance ranking exactly as designed)

The full report and machine-readable JSONL live in `benchmarks/results/`. Future runs are diffable; future suites (A/C/D/E) plug into the same harness.

Worktree: `.claude/worktrees/mempalace-sprint-14`
Branch: `worktree-mempalace-sprint-14`
Tests: 267 pass, 0 fail. Build: clean.

**Sprint #2 (PreCompact hook) implementation locked-in:**
- `hooks/SessionPreCompact.ts` — flush-only to SQLite; no Haiku, no LoA.
- Per-conversation byte-offset watermark in `~/.claude/MEMORY/.precompact_tracker.json` (separate from Stop's `.extraction_tracker.json`).
- Cooperates with Stop's extract lock — if Stop is in flight, PreCompact skips.
- Call-time path resolution (paths are computed inside functions, not at module load) so tests can rebind `$HOME` between cases.
- Registered under `hooks.PreCompact` in `install.sh` with a 10s timeout.

**Decisions made during build (locked-in defaults):**
- Identity file precedence: `$RECALL_IDENTITY_PATH` → `./.atlas-recall/identity.md` → `~/.claude/MEMORY/identity.md`. Silently omitted if all three are absent.
- Importance is `INTEGER 1-10` everywhere. LoA defaults to 8; `createLoaEntry` floors at 5 (curated tier protection enforced in code, since SQLite ALTER TABLE can't add a CHECK to existing rows).
- Backfill is heuristic-only for the first cut: confidence=high → 7, low → 3, else 5. Haiku suggestion path deferred until benchmark feedback.
- L1 budget: 12 slots, 4 reserved for LoA (~33%). Tie-break: `(importance DESC, table_priority [loa>dec>learn>bread], created_at DESC)`.
- Removed in v2 (with rationale captured in commit message): HOT_RECALL.md integration (legacy pre-SQLite store), `**Recall is active.**` behavioral footer (prompt-injection surface per red team).

## Sprint #7 — Status: **IMPLEMENTED 2026-06-01** (branch `feat/type-weighted-fts5-ranking`)

- `memory_search` MCP schema now accepts optional `bias_type` with the same allowed values as `table`.
- Human CLI usage ships as `mem search "query" --bias-type decisions` (soft boost) alongside existing `-t/--table` hard filtering; default command supports `mem "query" -k --bias-type decisions` for keyword-only mode.
- Agent and human docs now explain `bias_type`/`--bias-type`: use it when a type should come first without hiding other matching context.
- `src/lib/memory.ts` keeps default ranking unchanged unless `biasType` is supplied.
- Added regression coverage that biased search prefers the requested type while still returning other matching types.
- Validation: `bun test tests/lib/memory.test.ts`, full `bun test`, `bun run lint`, `bun run build`, CLI help smoke checks, and `git diff --check` all pass.

---

## Phase 3 — Backend Portability (Postgres / Turso) — DRAFT

Drafted from research agent findings on 2026-04-17. **Status:** investigation only — no code action proposed yet. Awaiting Ed's go/no-go.

### Why this is on the radar

Recall today is single-user, single-machine, file-based SQLite. Several of the non-coding-agent use cases (Phase 4 below) need *some* of: multi-device sync, multi-tenant isolation, larger corpora, collaborative access. The question is what the cheapest seam is to add backend optionality without forking the codebase.

### Key findings (verbatim from research)

1. **Recall already uses sqlite-vec HNSW for vector search**, not pure brute-force. This raises the bar for what Postgres adds on the vector side. **pgvector only clearly wins past ~20,000 embedded rows**; below that, the current stack is competitive.
2. **`tsvector` + GIN ≠ FTS5 BM25.** Postgres stock ranking is `ts_rank` / `ts_rank_cd` (coverage-based). True BM25 requires the third-party `pg_bm25` extension (ParadeDB) — not available on Neon free tier. For Recall's short-to-medium personal records, `ts_rank` is a *practical* equivalent, just not identical math.
3. **Generated `tsvector` columns + GIN replace the 21-trigger setup** Recall uses today. Postgres 12+ updates the column automatically on every write — simpler than the current FTS5 trigger approach.
4. **Turso (libSQL) is the sweet spot for multi-device.** It's SQLite-compatible at the wire level; the migration is essentially `bun:sqlite` → `@libsql/client`. Embedded-replica mode gives offline-first + sync without a real Postgres port. Free tier covers personal use.
5. **`PGlite`** (Postgres compiled to WASM, in-process, no server) is the right tool for prototyping the Postgres backend without standing up infra.
6. **Schema-per-user multi-tenancy** is the correct first model — simpler and safer than RLS for tens-to-hundreds of users. RLS becomes necessary at SaaS scale.
7. **Kysely** as the CRUD-layer abstraction. FTS and vector queries stay backend-specific; Kysely abstracts only the boring parts where SQL dialects diverge.

### Proposed architecture (if greenlit)

```
RecallBackend (interface)
  ├── SQLiteBackend   — current behavior, default, zero change for existing users
  ├── LibSQLBackend   — Turso / libSQL with embedded-replica sync (multi-device)
  └── PostgresBackend — Neon / Supabase / self-hosted (multi-tenant, SaaS path)
```

Selection via `MEM_BACKEND=sqlite|libsql|postgres`. CLI, MCP server, and hooks call only the interface.

### Build estimate

- Backend interface + SQLite implementation refactor: ~1 week (pure mechanical extraction).
- LibSQL backend: ~3 days (mostly client swap).
- Postgres backend: ~2 weeks (FTS rewrite, pgvector wiring, migration story for existing SQLite users).

### Open question for Ed

Phase 3 only matters if we are committing to the Phase 4 use cases below. If Recall stays a personal coding-agent memory, the SQLite story is sufficient and Phase 3 is wasted effort. Decide Phase 4 first.

---

## Phase 4 — Recall Beyond Coding Agents — DRAFT

Drafted from research agent findings on 2026-04-17. **Status:** strategic, not yet a build. Awaiting Ed's prioritization.

### The framing the research agent surfaced

> "Recall has the extraction intelligence (Claude Haiku integration) that raw SQLite-MCP tools lack, and the privacy/local-first posture that cloud tools sacrifice. The gap to close is **capture breadth** — more surfaces feeding the same pipeline."

The 2025–2026 open-source convergence (sqlite-memory, agentmem, AIngram, engram) independently arrived at SQLite + FTS5 + vector embeddings + MCP. Recall has the same architecture *plus* the Haiku-driven extraction layer most don't have. That's the moat.

### Use cases ranked by architectural fit

**Tier 1 — Least architectural change (months, not quarters):**

1. **AI-agent orchestration for non-coding agents.** Writing, research, customer support agents using Recall as their memory layer via MCP. The only schema delta needed is a `memory_type` enum (episodic / semantic / procedural) so agents can filter by memory mode. Everything else is additive.
2. **Knowledge worker memory** (researcher, writer, consultant). Already covered by the existing CLI + FTS5 + Ollama stack at zero marginal cost. The gap is **document import** — `mem import-doc` for PDFs, markdown, web URLs, with Haiku extraction. This is the highest-leverage near-term feature.
3. **Personal life OS** — Telos planning, journals, decision logs. Recall already has Telos as a first-class primitive. The main ask is richer time-range query syntax (`mem search --since Q1-2026`).

**Tier 2 — Significant re-architecture (quarters):**

4. **Team knowledge sharing.** Multi-tenancy + sync + Slack/email ingestion. Requires Phase 3 (Postgres backend) and an auth layer. Notion AI ($20/user/mo) is entrenched; differentiation needs to be the local-first / extraction-quality story.
5. **Mobile capture for personal life OS.** Voice memos and on-the-go notes need a native or PWA client. Without it, life-OS is desktop-only — small fraction of the addressable market.

**Tier 3 — Out of scope unless pivoted to:**

6. **Domain verticals (therapist, doctor).** HIPAA BAA, SOC 2 Type II, EHR formats. Crowded market (Mentalyc, Upheal, AutoNotes) at $15–50/clinician/month. Engineering + legal investment is months. Skip.

### Recommended near-term move (if any)

If Ed wants to expand beyond coding agents, the cheapest first step is **document import** (`mem import-doc`). It's:
- Additive (no schema migration)
- Reuses the existing extraction pipeline (Haiku Stop-hook logic refactored into a reusable function)
- Unlocks Tier 1 use cases #2 and #3 immediately
- Doesn't commit Recall to multi-tenant or mobile

Estimated cost: 2–3 days for PDF + markdown + web-URL adapters with Haiku extraction.

### Open question for Ed

Is Recall expanding beyond the coding-agent niche? If yes, Phase 4 + parts of Phase 3 (probably Turso for sync). If no, focus on Phase 2 (benchmarking) and stop here.

---

## Open Questions for Ed

1. **Phase 2 (benchmarking) — when?** Run in parallel with #2/#6 of the original borrow list, or do Phase 2 first to validate the #1+#4 work that just shipped?
2. **Phase 3 (backend portability) — interest?** Only worth investing if Phase 4 is a "yes." If staying coding-agent-only, kill Phase 3.
3. **Phase 4 (non-coding expansion) — direction?** If yes, what's the first use case? (Document import is the cheapest unlock.)
4. **Suite E (real-world replay)** — comfortable with anonymized session-history replay, or keep it synthetic-only?
5. **Public benchmarks?** `docs/benchmarks.md` shipped with the repo (transparency) or internal until results are clean?
6. **Next sprint from the original borrow list:** #2 PreCompact hook (small, contained) or #6 multi-format conversation import (medium, also unlocks Phase 4 doc import as a sibling)?

---

## Sources

- MemPalace repo — https://github.com/MemPalace/mempalace
- Independent technical analysis — https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-mempalace.md
- Star-pattern analysis — https://gist.github.com/roman-rr/0569fc487cc620f54a70c90ab50d32e3
- Critical review — https://www.danilchenko.dev/posts/2026-04-10-mempalace-review-ai-memory-system-milla-jovovich/
- Benchmark interpretation — https://medium.com/@tentenco/mempalace-milla-jovovichs-ai-memory-system-what-the-benchmarks-actually-mean-1a3abe4490d8
