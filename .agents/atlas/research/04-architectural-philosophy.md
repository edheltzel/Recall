# 04 — Architectural Philosophy: openhuman vs. atlas-recall

Two systems that both call themselves "memory for AI" but place the load-bearing bet in different places. This doc is a substrate-level comparison — what each project actually *is*, what it makes easy, what it pushes back onto the user, and where their world-views diverge.

---

## openhuman, in its own terms

openhuman is **a desktop AI being**, not a memory library. The Rust crate name (`openhuman_core`) and its top-level modules — `agent/`, `memory/`, `channels/`, `providers/`, `tools/`, `subconscious/`, `tree_summarizer/`, `mascot/`, `meet_agent/` — describe a daemon, not an SDK. There is no `pip install openhuman` or `npm i`. Shipping artefacts are `.deb`, Homebrew, Tauri bundles. The unit of the system is **an Agent session running against a MemoryTree inside an Obsidian-shaped workspace**.

The memory substrate is a **deterministic, bucket-sealed Markdown tree on your laptop**. Source data — Gmail, Slack, Notion, hand-written notes — is canonicalised to Markdown with provenance frontmatter, deterministically chunked into ≤3k-token segments with stable IDs, written atomically as `.md` files in the workspace `wiki/` vault, and persisted to `memory_tree/chunks.db` (SQLite + FTS5 + vector tables + graph triples). Background workers then **seal** chunks into hierarchical summary trees: L0 buffer → L1 → L2 …, across three concentric scopes — source / topic / global. Retrieval (`memory.tree.*` RPC) targets a scope: search, drill_down, topic, global, fetch.

The memory-tree document states the bet explicitly: *"It is not a vector database with a thin 'memory' wrapper. It is a deterministic, bucket-sealed pipeline … Vector stores answer 'what is similar to this query?' Memory needs to answer more than that."* Embeddings live **inside** the tree as one signal among many. The load-bearing primitive is the human-readable Markdown chunk; the agent and the human read the same artefacts. Karpathy's obsidian-wiki tweet is cited verbatim as inspiration.

Extensibility is **TOML config + Rust trait impls + a workspace folder convention**. New memory backend → implement the `Memory` async trait in `traits.rs` and register via `store/factories.rs`. New agent archetype → drop an `AgentDefinition` TOML or extend the built-ins (orchestrator, planner, researcher, code_executor, summariser, archivist, trigger_triage, trigger_reactor). New tool → implement in `src/openhuman/tools/impl/`. New integration → one of 118+ OAuth connectors. Most users never extend; they configure and connect.

What's easy: one-click install, OAuth a connector, watch auto-fetch every 20 min, talk to the agent, browse memory as Markdown in Obsidian, voice I/O, mascot, model routing, "one subscription". What's hard: building from source (Rust 1.93 + Node 24 + pnpm 10.10 + CMake + Ninja + Tauri + CEF submodules), deviating from the bundled trees, writing tools in anything but Rust, running fully off their backend (Ollama works but is positioned as a downgrade path), migrating off `UnifiedMemory`.

The product positions itself against terminal-first, BYO-models, plugin-reliant agents; against vector-DB-wrappers; against chat-scoped memory; against black-box memory ("you can't trust a memory you can't read"). The closest plain-English self-description: *"Your personal AI super-intelligence — local-first, Markdown-native, and already knows you by lunch."*

---

## atlas-recall, in its own terms

atlas-recall is **plumbing for an agent it does not own**. The agent is Claude Code (or Pi, or OpenCode). atlas-recall ships a CLI (`mem`), an MCP server (`mem-mcp`), and two hook scripts (`SessionExtract.ts` on Stop, `SessionRecall.ts` on SessionStart). Everything lands as TypeScript on Bun running locally; the durable layer is one SQLite file at `~/.claude/memory.db` (WAL mode, 0600 perms).

The core abstractions are **typed record types with lifecycle**, not a flat blob. `Session` (`src/types/index.ts`) anchors a thread; `decisions` carry status (`active|superseded|reverted`) and confidence scores; `learnings`, `breadcrumbs`, and curated `loa_entries` (Library of Alexandria, default importance 8, floor 5) each have a purpose and a query path. Decisions can be superseded and reverted in-place — memory has an editorial layer, not just an append-only log.

Data flow runs in two directions across the agent boundary. WRITE: at session end the Stop hook reads the JSONL transcript, filters messages, runs a Claude Haiku extraction with a quality gate (must contain SUMMARY + MAIN IDEAS), and inserts rows into the typed tables — plus appends to `DISTILLED.md` and `HOT_RECALL.md` as side files. READ: at session start a tiered recall block (`assembleL1()`) injects L0 identity + top-12 importance-ranked records, with reserved LoA slots so curated knowledge is never crowded out. SEARCH: FTS5 always, optional Ollama embeddings on top, reciprocal rank fusion (k=60). Lose Ollama, the keyword path keeps working.

Extensibility is **edit-a-TypeScript-file**. New memory type → clone the Decision pattern across `types/`, `db/schema.ts`, `lib/memory.ts`. New extraction prompt → edit `hooks/extract_prompt.md`. New MCP tool → add a zod schema and handler in `src/mcp-server.ts`. New hook → drop a `.ts` file in `hooks/` and register in `.claude/hooks.json`. There is no plugin API because the codebase itself is the plugin surface.

What's easy: FTS5 search, importance ranking, tiered injection, transactions, LoA curation, dedup/locking, extraction quality gates. What's hard: writing the extraction prompt, tuning importance scores (`mem pin`), deciding when to supersede vs revert a decision, maintaining the L0 identity via `mem onboard`, choosing extraction strategy for long sessions.

The README positions explicitly against several stances: cloud-hosted memory ("Nothing leaves your machine"), vendor-lock-in ("Works across Claude Code, Pi, OpenCode"), flat-blob memory ("each type has a purpose and a query path"), and embedding-required retrieval ("Lose Ollama, lose nothing"). `ACKNOWLEDGMENTS.md` names MemPalace (tiered recall, importance scoring) and PAI (TELOS integration) as direct lineage. The closest self-description: *"SQLite-backed persistent memory that injects only what matters at session start, stays local and queryable, and never loses curated knowledge to noise."*

---

## Where they diverge

Six axes. On each, both projects make a defensible choice; the choices are not parallel.

### 1. Product vs. plumbing

openhuman is a complete desktop being: agent, mascot, voice, OAuth to 118 services, model routing, its own runtime. It's the universe. atlas-recall is a parasite on Claude Code's session lifecycle — it owns the storage layer and a thin extraction/injection bracket around it; the cognition is supplied by whatever model the host agent runs.

Trade-off: openhuman gives you "ready in five minutes" and the agent is bundled. atlas-recall presupposes you already use Claude Code (or a compatible host) and gives you nothing if you don't. openhuman owns the full stack and its decisions stick to your laptop forever; atlas-recall owns one file and is replaceable in a weekend.

### 2. Memory as artifact vs. memory as record

openhuman bets memory is a **Markdown vault** — chunks the human and the agent read in the same Obsidian view, frontmatter for provenance, files on disk you can edit by hand. Auditability is the product. atlas-recall bets memory is a **structured database row** — decisions have states, confidences, supersede chains; learnings and breadcrumbs have separate tables and query paths.

Trade-off: openhuman pays in query precision (Markdown chunks have to be re-grepped, re-embedded, re-summarised) to gain transparency. atlas-recall pays in opacity (a SQLite blob isn't browse-able in Obsidian) to gain typed lifecycle — *this decision was superseded by that one* is a first-class fact, not a markdown convention.

### 3. Compression hierarchy vs. importance ranking

openhuman computes context. Three concentric summary trees (source/topic/global) are sealed by background LLM passes; at retrieval time the agent drills into the right scope. The bet: an LLM that summarises diligently produces the right context for the next session. atlas-recall curates context. Importance scores, reserved LoA tiers, manual `mem pin`. The bet: a human who has done the work knows which 12 records matter when the next session opens.

Trade-off: openhuman scales to data the user has never seen (118 connectors auto-fetching every 20 min) but inherits every summarisation mistake forever. atlas-recall scales to data the user has touched but degrades when the user stops curating.

### 4. Vector-store rejection vs. hybrid embracing

openhuman explicitly rejects "vector-DB-with-a-wrapper". Embeddings exist inside the tree, but the load-bearing retrieval primitive is the tree structure plus deterministic scoring. atlas-recall ships FTS5 + optional embeddings via Ollama with reciprocal rank fusion — both signals are first-class, and the keyword path is the hard floor that survives without Ollama.

Trade-off: openhuman's bet is that *similarity search is the wrong primitive* and structure beats it. atlas-recall's bet is that both signals contribute orthogonal information and fusion wins.

### 5. Memory is incoming data vs. memory is outgoing exhaust

openhuman pulls memory from the world. Gmail, Slack, Notion, calendar, custom connectors — the agent's memory is everything you do, comprehended on a 20-minute cadence. atlas-recall extracts memory from the conversation. The Stop hook turns Claude Code sessions into rows; memory is the *exhaust of the work*, not its inputs.

Trade-off: openhuman bets the agent should comprehend everything about you; atlas-recall bets the agent should remember what was decided. The first model is *omniscient companion*; the second is *colleague who took good notes*.

### 6. Deterministic Rust pipeline vs. hot-edit TypeScript hooks

openhuman is Rust traits + CMake + Tauri + a 20-minute build chain. The pipeline is deterministic by virtue of being compiled and tested as a unit. atlas-recall is TypeScript on Bun, self-contained hook scripts (`SessionExtract.ts` doesn't even import from `src/` — duplication is intentional), edit-and-rerun.

Trade-off: openhuman buys correctness and performance with build friction; atlas-recall buys iteration speed with the cost of having no compile-time guarantees about hook behaviour. Different bets about where the developer's pain should land.

---

## The central question that separates them

**What is memory FOR?**

openhuman answers: *memory is the substrate for an AI that knows everything about you and can help continuously*. This makes the agent a being — it needs voice, a mascot, omnidirectional inputs, deterministic compression of years of context. The Markdown vault is the body of that being; the obsidian-wiki framing is the philosophical centre.

atlas-recall answers: *memory is the substrate so the next session doesn't start cold on this project*. This makes the agent a colleague — it doesn't need to know everything; it needs to know what was decided last Tuesday and why. The typed record schema is the editorial layer; the tiered L0/L1 injection is the act of handing the colleague their notebook back.

These aren't two implementations of the same idea. openhuman is **a being with a memory**; atlas-recall is **a memory with no being of its own**. One is trying to build an AI that has continuity; the other is trying to give an AI that already exists a way to not forget. Both are coherent, and the trade-offs each accepts are the trade-offs the other would refuse.
