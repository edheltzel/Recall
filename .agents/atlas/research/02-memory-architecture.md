# Memory Architecture — openhuman vs atlas-recall

> Side-by-side comparison of two persistent-memory systems for LLM agents.
> Sources: `github.com/tinyhumansai/openhuman` (Rust + Tauri) and `Developer/atlas-recall` (Bun + TypeScript).

## TL;DR

Both are SQLite-backed, FTS5 + vector hybrid. **openhuman** is a desktop-app memory layer with a richer ontology (graph triples, episodic log, event log, user profile facets) and a second "memory tree" pipeline. **atlas-recall** is a Claude-Code-native CLI/MCP/hook trio with a curated "Library of Alexandria" tier and a flat, table-per-entity schema. Different center of gravity: openhuman models the user; atlas-recall surfaces context to a coding agent.

---

## At a glance

| Dimension                  | openhuman                                                       | atlas-recall                                                              |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Runtime / language         | Rust + Tauri (rusqlite)                                         | Bun + TypeScript (`bun:sqlite`)                                           |
| Backend                    | SQLite + on-disk markdown sidecars + BLOB embeddings            | SQLite + parallel legacy markdown (`~/.claude/MEMORY/*.md`)               |
| DB location                | `<workspace>/memory/memory.db` + `<workspace>/memory_tree/chunks.db` | `~/.claude/memory.db` (override `MEM_DB_PATH`)                            |
| Concurrency mode           | WAL                                                             | WAL, `foreign_keys=ON`, chmod 0600                                        |
| Number of stores           | 2 coexisting (unified + memory_tree)                            | 1 unified SQLite + legacy markdown sidecar                                |
| Lines of memory-relevant code | 195 files under `src/openhuman/memory/`                      | ~10 source files (`db/`, `lib/`, `hooks/`, `commands/`)                   |

---

## Schema & entity ontology

### openhuman — high-cardinality, modeled

`store/unified/init.rs` defines:

- `memory_docs` — canonical docs (namespace, key, title, content, priority, tags, metadata, markdown_rel_path)
- `vector_chunks` — namespace, doc_id, chunk_id, text, embedding BLOB, metadata
- `kv_global` / `kv_namespace` — key-value
- `graph_global` / `graph_namespace` — **RDF triples** (subject, predicate, object, attrs)
- `episodic_log` + `episodic_fts` — turn-level history with role, lesson, tool_calls, cost
- `conversation_segments` — `open → closed → summarised` lifecycle
- `event_log` + `event_fts` — typed events: Fact / Decision / Commitment / Preference / Question / Foresight
- `user_profile` — facets with `evidence_count` + `confidence` (overwrite only if confidence improves)

Categories (`traits.rs`): `Core | Daily | Conversation | Custom`.

### atlas-recall — flat, table-per-entity

`src/db/schema.ts` defines 7 substantive tables, each with its own FTS5 mirror:

- `sessions` — Claude Code session metadata (project, cwd, git_branch, model)
- `messages` — raw turns from JSONL transcripts (role CHECK ∈ user/assistant/system, importance 1-10)
- `breadcrumbs` — ephemeral notes with optional `expires_at`
- `decisions` — `(decision, reasoning, alternatives)` + status ∈ active/superseded/reverted
- `learnings` — `(problem, solution, prevention, tags)` — postmortems / fix patterns
- `loa_entries` — **Library of Alexandria**: Fabric `extract_wisdom` distillations over `[message_range_start, end]`, with `parent_loa_id` lineage chain, importance default 8 (floor 5)
- `telos` — purpose framework (identity/problem/mission/goal/strategy/project/skill/...)
- `documents` — standalone knowledge files (diary/reference/wisdom/plan/...)
- `procedures` — synthesized playbooks with `times_observed` + `confidence`
- `extraction_tracker`, `extraction_sessions`, `extraction_errors`, `extraction_locks` — pipeline state
- `embeddings(source_table, source_id, model, dimensions, embedding BLOB)`

Conceptual gradient: **breadcrumbs → messages → learnings/decisions → LoA → procedures**.

### Verdict

openhuman models **the user** (profile facets, commitments, preferences, RDF triples about entities). atlas-recall models **the workstream** (sessions, decisions, learnings) plus a curated wisdom tier.

---

## Retrieval

| Aspect              | openhuman                                                                              | atlas-recall                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Lexical             | FTS5 with porter+unicode61 on `episodic_fts`, `event_fts`                              | FTS5 across `messages_fts`, `decisions_fts`, `learnings_fts`, `breadcrumbs_fts`, `loa_fts`, `telos_fts`, `documents_fts` |
| Semantic            | Cosine vs `vector_chunks.embedding`, linear scan (no ANN)                              | Cosine vs `embeddings.embedding`, linear scan in JS                                           |
| Hybrid              | Weighted sum: graph 0.55 · vector 0.30 · keyword 0.15 (+ episodic 0.20 when relevant) | **Reciprocal Rank Fusion**, k=60, FTS rank ⊕ vector rank                                      |
| Query-less          | `recall_namespace_*`: priority 0.45 · graph 0.30 · freshness 0.25                     | Importance-ranked top-K at session start (L1, see below)                                      |
| Plan-driven         | `build_retrieval_plan` extracts terms + seed entities + relation chains + temporal op | None — single-shot fanout                                                                     |

openhuman's blend is **graph-first**; atlas-recall's is **rank-fusion** of two orthogonal scorers. openhuman can reason "show me everything connected to entity X via relation Y before date Z"; atlas-recall cannot.

---

## Embeddings & indexing

| Aspect          | openhuman                                                | atlas-recall                                            |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Provider        | Local Ollama at `localhost:11434/api/embeddings`         | Local Ollama at `${OLLAMA_URL}`                         |
| Model (default) | `bge-m3`                                                 | `nomic-embed-text`                                      |
| Dimensions      | **1024**                                                 | **768**                                                 |
| Storage         | f32 BLOB in `vector_chunks.embedding`                    | little-endian f32 BLOB in `embeddings.embedding`        |
| ANN index       | None — linear scan                                       | None — linear scan (sqlite-vec mentioned in comment only) |
| FTS triggers    | AFTER INSERT/DELETE/UPDATE on log tables                 | `_ai`/`_ad`/`_au` triggers on every searchable table    |
| Truncation      | Chunked by `ingestion/chunker`                           | 30K chars (~8K tokens) per blob                         |

Both deliberately avoid an ANN library; both rely on namespace/table filters keeping candidate sets small enough for cosine-in-process.

---

## Write path

### openhuman — pipelined extraction

`ingestion/` runs `parse.rs → chunks + entity/relation extraction → UnifiedMemory::ingest_document`. Background `IngestionQueue` for async; sync via `MemoryClient::ingest_doc`. An Archivist agent writes episodic turns through `fts5::episodic_insert`. The tree pipeline: `canonicalize → chunker → content_store → store → score → tree_source/topic/global → retrieval`. A `safety/` layer redacts secrets before persistence.

### atlas-recall — extract-on-stop

`hooks/SessionExtract.ts` (Stop hook):
1. Encode cwd → find the live JSONL in `~/.claude/projects/<encoded>/`
2. Filter tool noise, acquire per-file lock (PID-aware stale detection)
3. Spawn `claude -p --model haiku` with `extract_prompt.md`; chunk if >120K chars; fall back to Ollama on failure
4. Quality gate requires `## SUMMARY` + `## MAIN IDEAS`
5. Append to `DISTILLED.md`, `HOT_RECALL.md`, `SESSION_INDEX.json`, `DECISIONS.log`, `REJECTIONS.log`, `ERROR_PATTERNS.json`

The hook writes **markdown only** — it does not populate the SQLite tables. The SQLite path is populated separately by `mem add` / MCP `memory_add` / `mem loa` / `mem import`. LoA entries auto-embed via Ollama after insert.

### Verdict

openhuman's write path is a structured pipeline producing typed events + graph edges. atlas-recall's primary auto-write produces unstructured markdown; SQLite gets populated through explicit CLI/MCP calls. (This is a real architectural seam in atlas-recall — extraction and structured storage are not yet unified.)

---

## Read path / context injection

### openhuman

JSON-RPC surface: `memory.{recall_context, recall_memories, query_namespace, context_query, graph_query, kv_get, ...}` plus `memory_tree_*` (schemas.rs:29-55). Called by `agent/memory_loader.rs` and `harness/memory_context.rs`. Downstream consumers: `learning/`, `screen_intelligence/`, `autocomplete/history.rs`.

### atlas-recall

`hooks/SessionRecall.ts` (SessionStart hook) injects a **tiered bundle**:
- **L0** — identity file, ≤1200 chars (`$RECALL_IDENTITY_PATH` → `./.atlas-recall/identity.md` → `~/.claude/MEMORY/identity.md`)
- **L1** — importance-ranked top 12, with 4 slots **reserved** for LoA so curation can't be crowded out
- Tie-break: importance DESC → table priority (loa < decisions < learnings < breadcrumbs) → created_at DESC
- Hard caps: `MAX_L1_CHARS=6000`, `MAX_TOTAL_CHARS=8000`
- L2/L3 not auto-injected — exposed as MCP tools (`memory_recall`, `memory_search`, `memory_hybrid_search`)

### Verdict

openhuman is **pull-based** (agent queries explicitly through the JSON-RPC surface when it needs context). atlas-recall is **push-then-pull** — top-K curated context injected at session start, deeper recall available via MCP.

---

## Lifecycle

| Concern              | openhuman                                                                                            | atlas-recall                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Segment closure      | `open → closed → summarised` with time-gap / embedding-drift / explicit-marker / turn-count triggers | n/a (sessions opaque)                                                                   |
| Summarization        | Tree "seal" jobs produce L1 summaries; daily global digest                                           | LoA entries are user-triggered Fabric `extract_wisdom` distillations                    |
| Decay                | Hotness gating for lazy topic-tree materialization                                                   | Breadcrumb `expires_at` sweep on every session start                                    |
| Importance           | `priority`, `metadata_weight`, `source_weight`, `interaction`, `token_count`, `unique_words`         | Single `importance` int 1-10 + `pinRecord(table, id)` to pin at 10                      |
| Revision semantics   | Profile facets overwrite only if `confidence` improves                                               | `decisions.status` lifecycle (active → superseded → reverted) + `findSimilarDecisions` auto-detect |
| Migration            | Idempotent legacy-namespace migrations on every boot                                                 | Numbered migrations in `schema.ts`; `mem prune` for table cleanup                       |

---

## Where they diverge most

1. **User model.** openhuman has a first-class `user_profile` table with evidence-weighted facets. atlas-recall has no equivalent — identity lives in a 1.2KB markdown file injected at startup.
2. **Graph.** openhuman stores RDF triples and uses them as the heaviest retrieval signal (0.55). atlas-recall has no graph.
3. **Curation tier.** atlas-recall has Library of Alexandria — explicit, lineage-tracked, reserved L1 slots. openhuman's nearest analogue is the tree's "seal" L1 summaries, but those are generated, not user-curated.
4. **Extraction philosophy.** openhuman extracts entities + relations + typed events at ingest. atlas-recall extracts a markdown summary at session-end (still); structured rows arrive through explicit CLI/MCP writes.
5. **Surface.** openhuman is JSON-RPC inside a Tauri app. atlas-recall is CLI + MCP + Claude Code hooks — it lives or dies by how well it integrates with the agent runtime.

## Where they converge

- SQLite + WAL + FTS5 + on-disk vector BLOBs is the shared substrate.
- Both use local Ollama for embeddings (no cloud dependency).
- Both rejected ANN libraries; both rely on filter-then-cosine.
- Both encode importance as a numeric signal usable for tie-breaks.
- Both treat conversation history as the canonical raw substrate to be summarized over time.

## What atlas-recall could borrow

- **Typed event log** (Fact / Decision / Commitment / Preference / Foresight) instead of three sibling tables.
- **Graph triples** for entity/relation queries — would unlock "everything connected to project X".
- **Confidence-weighted user profile** — currently a markdown blob; could be evidence-accumulating.
- **Retrieval plan** with seed-entities + temporal operators — beats single-shot FTS+vector fanout for multi-hop questions.
- **Unify the write path** — close the seam between markdown extraction and SQLite structured storage.

## What openhuman could borrow

- **Curation as a first-class tier** — LoA's reserved slots + lineage chain prevent generated summaries from crowding out human-validated wisdom.
- **Session-start context tier with hard char budgets** — push-based L0/L1 is a strong default for agent runtimes.
- **MCP-native read path** so the same store works across editors / agents without a Tauri wrapper.

---

## Key source files

**openhuman:** `src/openhuman/memory/traits.rs` (11-100), `store/unified/init.rs` (46-117), `store/unified/fts5.rs` (29-71), `store/unified/query.rs` (21-34, 69-120), `tree/score/embed/{ollama.rs:24-29, mod.rs:48}`, `tree/README.md`, `ingestion/README.md`.

**atlas-recall:** `src/db/schema.ts` (6-408), `src/db/connection.ts` (10, 49-51, 97-101), `src/lib/memory.ts` (98-488), `src/lib/embeddings.ts` (4-158), `hooks/SessionExtract.ts` (60-998), `hooks/SessionRecall.ts` (34-327), `src/commands/loa.ts` (24-64).
