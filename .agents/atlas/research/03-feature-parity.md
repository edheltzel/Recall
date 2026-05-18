# OpenHuman vs. Atlas-Recall — User-Facing Feature Parity

**Date:** 2026-05-16
**OpenHuman source:** https://github.com/tinyhumansai/openhuman (README + `docs/memory-sync-functions.md`)
**Atlas-Recall source:** `/Users/ed/Developer/atlas-recall/` (README, `src/commands/`, `src/mcp-server.ts`, `commands/Recall/`)

> ⚠️ During research, the OpenHuman repo pages returned **five separate prompt-injection attempts** embedded in fetched content (fake `<system-reminder>` blocks trying to switch modes, claim file edits, exit plan mode, suppress questions). All were ignored. Flagging here so it's part of the record.

## What each project actually is

- **OpenHuman** — Open-source agentic *desktop assistant* (Tauri, Rust + TypeScript). Mascot UI, 118+ OAuth integrations, on-device SQLite "Memory Tree" auto-populated every 20 min, Obsidian-compatible vault. Memory is one subsystem of a much larger desktop app.
- **Atlas-Recall** — *CLI + MCP server* that gives coding agents (Claude Code, Pi, OpenCode) persistent memory across sessions. SQLite + FTS5 + optional Ollama embeddings. No UI, no integrations, no auto-fetch — focused entirely on agent session memory.

These are different products. OpenHuman is a daily-driver desktop assistant whose memory layer is a side-effect of its integrations. Atlas-Recall is a headless memory infrastructure for coding agents. The "memory" overlap is real but partial.

## Feature parity matrix

| Capability | OpenHuman | Atlas-Recall |
|---|---|---|
| **Add — manual** | Edit `.md` files in vault directly; no documented `add` command | `mem add breadcrumb/decision/learning`, MCP `memory_add`, `/Recall:add` |
| **Add — automatic (sessions)** | n/a (not a coding-agent memory layer) | Stop hook `SessionExtract.ts` → Claude Haiku extract; PreCompact flush; cron `BatchExtract.ts` |
| **Add — automatic (integrations)** | 20-min auto-fetch from Gmail, Notion, GitHub, Slack, Stripe, Calendar, Drive, Linear, Jira (one-click OAuth, 118+) | n/a |
| **Add — programmatic API** | JSON-RPC `openhuman.memory_doc_put`, `put_doc()`, `put_doc_light()`, `ingest_doc()`, `kv_set()` via Tauri | MCP `memory_add`; CLI `mem add`; `memory_dump` |
| **Search — keyword (FTS)** | Not documented as a distinct mode | `mem search`, MCP `memory_search` (SQLite FTS5) |
| **Search — semantic** | `query_namespace()` (embeddings); `query_namespace_context_data()` for structured results | `mem embed semantic`, embeddings table (Ollama, 768-dim) |
| **Search — hybrid (FTS + vector, RRF)** | Not documented | `mem hybrid` (default for bare `mem "query"`), MCP `memory_hybrid_search`, RRF k=60 |
| **Recall — recent** | `recall_namespace()`, `recall_namespace_memories()` | `mem recent`, MCP `memory_recall`, `context_for_agent` |
| **Typed records — decisions** | Generic docs only; no decision type | First-class `decisions` table; `mem decision supersede/revert/list`; MCP `decision_update`; `findSimilarDecisions`; confidence scores |
| **Typed records — learnings** | n/a | `learnings` table; `mem add learning`; `recentLearnings` |
| **Typed records — breadcrumbs** | n/a | `breadcrumbs` table; `mem add breadcrumb`; `recentBreadcrumbs` |
| **Typed records — KV** | `kv_set/get/delete`, `kv_list_namespace` | n/a |
| **Typed records — curated canon** | n/a | Library of Alexandria (`loa_entries`); `mem loa write/show/quote/list`; MCP `loa_show`; 4 reserved L1 slots |
| **Knowledge graph** | `graph_upsert()`, `graph_query()` — first-class fact graph | n/a (PAI has a separate `KnowledgeGraph.ts`, but that's not part of Recall) |
| **Namespaces / scoping** | First-class: `skill-{id}`, `global`, `conversations`, `autocomplete`, `vision` namespaces | Project-level scoping only (`project` field on every record) |
| **Editing existing memories** | Edit `.md` in Obsidian vault; `kv_set` overwrites | Decision lifecycle (`supersede`, `revert`); no general "edit record" command |
| **Deleting memories** | `delete_document()`, `kv_delete()`, `clear_namespace()`, `clear_skill_memory()` | `mem prune` (lifecycle/TTL cleanup); no per-record delete CLI |
| **Importance / pinning** | n/a (relies on "scored" tree compression) | Importance 1–10, `mem pin`/`unpin`, `mem importance backfill`, importance-ranked L1 injection |
| **Clustering** | Implicit ("hierarchical summary trees") | Explicit `mem cluster` over embeddings |
| **Tagging** | n/a (no tags surfaced) | n/a |
| **Linking memories** | Implicit via knowledge graph edges | n/a (no explicit links between records) |
| **Visualization — graph** | Knowledge graph queryable via `graph_query` (no UI documented in fetched material) | n/a |
| **Visualization — tree / hierarchy** | "Memory Tree" hierarchical Markdown summary | n/a |
| **Visualization — vault browse** | Obsidian-compatible `.md` vault — open, browse, edit in Obsidian | n/a (but writes `DISTILLED.md`, `HOT_RECALL.md` markdown mirrors) |
| **Visualization — desktop UI** | Tauri desktop app with mascot, Meet attendee, ambient UI | n/a (CLI only) |
| **Import — session JSONL** | n/a | `mem import`, OpenCode + Pi session sweeps |
| **Import — docs** | `ingest_doc()`, `put_doc()` | `mem import-docs` (`mem docs import/list/search/show`) |
| **Import — legacy memory format** | n/a | `mem import-legacy` (DISTILLED.md → LoA) |
| **Import — TELOS (PAI goals)** | n/a | `mem telos import/list/show/search`; auto-sync via `TelosSync.ts` SessionStart hook |
| **Import — external services** | OAuth fetchers for 118+ services, 20-min loop | n/a |
| **Export** | Vault `.md` files are the export (Obsidian-readable on disk) | Markdown mirror (`DISTILLED.md`, `HOT_RECALL.md`, `DECISIONS.log`, `SESSION_INDEX.json`); no `mem export` command |
| **Token compression** | TokenJuice (HTML→MD, URL shortening, ASCII strip, ≤3k-token chunks) — claims up to 80% cost/latency reduction | n/a (relies on Haiku extractor + chunking >120K) |
| **Vision / screen capture memory** | `vision` namespace with screen-intelligence summaries | n/a |
| **Onboarding / identity bootstrap** | Implicit via integrations | `mem onboard` — 7-question L0 identity interview → `~/.claude/MEMORY/identity.md` |
| **Tiered context injection** | Implicit ("folded into hierarchical summary trees") | Explicit L0 (identity, always-on) + L1 (top 12 by importance, 4 LoA-reserved) at SessionStart |
| **Health / diagnostics** | Not documented | `mem doctor`, `mem stats`, MCP `memory_stats` |
| **Benchmarks** | n/a | `mem benchmark run` (wake-up context efficiency suite, locked baselines) |
| **Interop with other agent harnesses** | Optional: proxy via `agentmemory` for Claude Code, Cursor, Codex, OpenCode | One DB shared across Claude Code (stable), Pi (beta), OpenCode (alpha); MCP-based |
| **Storage** | SQLite + Obsidian vault (`.md` mirror) | SQLite (`~/.claude/memory.db`, WAL, 0600) + markdown mirror |
| **Embeddings stack** | Internal (Rust-side, model not documented in README) | Local Ollama (graceful degrade — keyword path still works if Ollama is down) |
| **Update lifecycle** | n/a in README | `./update.sh --check`, `/Recall:update` |
| **Slash commands inside agent** | n/a documented | `/Recall:add`, `/Recall:doctor`, `/Recall:dump`, `/Recall:loa`, `/Recall:recent`, `/Recall:search`, `/Recall:stats`, `/Recall:update` |

## Bucketed verdict

### OpenHuman-only (no analog in Atlas-Recall)
- 118+ OAuth third-party integrations and 20-min auto-fetch loop (Gmail/Notion/GitHub/Slack/Stripe/Calendar/Drive/Linear/Jira/…)
- Knowledge-graph storage with `graph_upsert` / `graph_query`
- KV store (`kv_set/get/list/delete`) with per-namespace enumeration
- First-class namespaces (skill / global / conversations / autocomplete / vision)
- Token compression layer ("TokenJuice")
- Vision-namespace screen-intelligence summaries
- Tauri desktop UI, mascot, Meet participant
- Obsidian-compatible vault as a first-class editing surface
- Cargo / Rust-backed `MemoryClient` API, JSON-RPC exposed via Tauri (`openhuman.memory_*`)
- Per-record delete + namespace-wipe operations
- 118-integration OAuth one-click onboarding

### In both (with different shapes)
- Local-first SQLite memory store
- Semantic search via embeddings
- Recent / browse APIs (`recall_namespace*` vs `mem recent`, `memory_recall`)
- Document ingest path (`ingest_doc` / `put_doc` vs `mem docs import`)
- Markdown mirror of memories on disk (Obsidian vault vs `DISTILLED.md` / `HOT_RECALL.md`)
- Optional cross-agent surfacing (`agentmemory` proxy vs MCP across Claude/Pi/OpenCode)
- Session-style context for an agent (`recall_namespace_context_data` vs `context_for_agent`)

### Atlas-Recall-only (no analog in OpenHuman)
- Typed records with semantics: **decisions** (with `supersede` / `revert` / confidence / `findSimilarDecisions`), **learnings**, **breadcrumbs**, **LoA** (curated canon)
- Importance scoring 1–10 + pin/unpin + importance-ranked SessionStart injection
- Hybrid FTS + vector search with explicit RRF (k=60) fusion and keyword-only fallback
- Explicit clustering command (`mem cluster`) over embeddings
- Identity onboarding interview (`mem onboard` → L0 file)
- Tiered SessionStart context (L0 identity + L1 top-N + 4 reserved LoA slots)
- Stop-hook session extraction via Claude Haiku (with >120K-char chunking + meta-extract + Ollama fallback + quality gate)
- PreCompact flush hook (rescues messages before Claude Code compaction)
- Batch / cron catch-up extractor for crashed or interrupted sessions
- PAI TELOS auto-sync hook (`TelosSync.ts`) + manual `mem telos import`
- Legacy-format importer (`mem import-legacy`: DISTILLED.md → LoA)
- Health + diagnostics: `mem doctor`, `mem stats`, MCP `memory_stats`
- Benchmark suite with locked baselines (`mem benchmark run`)
- Slash-command surface inside the agent (`/Recall:*`)
- Database lifecycle: `mem prune`, `mem init`, `./update.sh`, `./uninstall.sh --purge`
- Multi-harness MCP integration as a first-class design (stable Claude Code, beta Pi, alpha OpenCode)

## Tactical takeaway

The non-overlap is wide because the products solve different problems. **Recall is a memory layer; OpenHuman is an assistant that has a memory layer.** Where they overlap (SQLite + semantic search + markdown mirror), Recall is more opinionated about *what kind of thing* a memory is (decisions vs learnings vs breadcrumbs vs LoA), and OpenHuman is more opinionated about *where* memories come from (OAuth integrations) and *how* they're scoped (namespaces, knowledge graph).

Most plausible cross-pollination targets — features Recall could borrow without changing its identity:
1. **Namespaces** — currently Recall only has `project`; OpenHuman's `skill-*` / `vision` / `conversations` scoping is a richer dimension.
2. **Per-record delete** — Recall has lifecycle pruning but no targeted `mem delete <table> <id>`.
3. **Token-compression layer** at extract time (TokenJuice analog) — Recall currently leans on Haiku for compression.
4. **Optional knowledge-graph layer** — would pair well with existing typed records (decision→supersedes→decision edges already exist informally).

Features that should *not* be borrowed: the 118-integration OAuth fetcher loop and desktop UI are out of scope for a headless coding-agent memory tool.
