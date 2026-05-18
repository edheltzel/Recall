# Research Index — openhuman vs atlas-recall

> Cross-cutting synthesis of four parallel research passes against [`tinyhumansai/openhuman`](https://github.com/tinyhumansai/openhuman) and `~/Developer/atlas-recall/`. Generated 2026-05-16 by Atlas from four sub-agent reports running concurrently in herdr panes.

## Reports in this directory

| # | Report | Focus | Lines |
|---|---|---|---|
| 01 | [`01-tech-stack.md`](./01-tech-stack.md) | Languages, frameworks, dependencies, runtime, distribution | 56 |
| 02 | [`02-memory-architecture.md`](./02-memory-architecture.md) | Schema, retrieval, embeddings, write/read paths, lifecycle | 190 |
| 03 | [`03-feature-parity.md`](./03-feature-parity.md) | User-facing feature matrix; openhuman-only / both / recall-only | 116 |
| 04 | [`04-architectural-philosophy.md`](./04-architectural-philosophy.md) | Six axes of philosophical divergence; what memory is FOR | 90 |

## Headline finding

These projects use the same words ("AI memory") for different products. **openhuman is an AI *being*; atlas-recall is *memory with no being of its own.*** They share the substrate (SQLite + FTS5 + Ollama embeddings + WAL + markdown sidecars) but diverge on every other axis — what gets stored, who curates it, how it's retrieved, where the agent lives.

If you remember one thing from these four reports: **openhuman owns the agent and the data; atlas-recall owns the data and rents the agent.**

## What each project actually is

**openhuman** — a Tauri 2 desktop super-app. ~80 Rust crates (axum + tokio + socketioxide RPC server) + a React 19 + Redux + Tailwind + Three.js + Remotion frontend, bundled as `.deb` / Homebrew / macOS DMG / npm. Includes Whisper-rs voice, system-input/clipboard control, multi-protocol messaging (IMAP / Matrix / WhatsApp), OpenTelemetry + Prometheus + Sentry observability, and 118+ OAuth connectors that auto-fetch every 20 minutes. Memory is one subsystem; the system is *an entire AI assistant.*

**atlas-recall** — a single-purpose persistent-memory layer for Claude Code. Pure TypeScript on Bun, three production dependencies (`@modelcontextprotocol/sdk`, `commander`, `zod`), `bun:sqlite` with FTS5 storage at `~/.claude/memory.db`. Exposes one CLI (`mem`), one MCP server (`mem-mcp`), and a handful of `~/.claude/hooks/*.ts` scripts. No UI, no server, no auth, no telemetry. Lives or dies by how well it integrates with the host agent runtime.

## Where they converge

- SQLite + WAL + FTS5 + on-disk vector BLOBs is the shared substrate
- Both use local Ollama for embeddings (no cloud dependency)
- Both reject ANN libraries — both rely on filter-then-cosine linear scan
- Both encode importance as a numeric signal usable for tie-breaks
- Both mirror memory to markdown on disk (openhuman → Obsidian vault; atlas-recall → `DISTILLED.md` / `HOT_RECALL.md` / `DECISIONS.log`)
- Both treat conversation history as the canonical raw substrate to be summarised over time

Cross-ref: [tech-stack §47-49](./01-tech-stack.md); [memory-arch *Where they converge*](./02-memory-architecture.md).

## Where they diverge — six axes

Numbered to match [`04-architectural-philosophy.md`](./04-architectural-philosophy.md).

1. **Product vs. plumbing.** openhuman is a complete being; atlas-recall is a parasite on Claude Code's lifecycle.
2. **Memory as artifact vs. record.** openhuman bets memory is a Markdown vault the human and agent both read; atlas-recall bets memory is a typed SQLite row with lifecycle (decision → superseded → reverted).
3. **Compression hierarchy vs. importance ranking.** openhuman *computes* context via sealed L0→L1→L2 summary trees; atlas-recall *curates* context via importance scores and reserved LoA slots.
4. **Vector-store rejection vs. hybrid embracing.** openhuman rejects "vector-DB-wrapper" framing — embeddings are one signal inside the tree. atlas-recall ships FTS5 + Ollama with Reciprocal Rank Fusion (k=60); keyword path survives Ollama loss.
5. **Memory is incoming data vs. outgoing exhaust.** openhuman pulls from Gmail/Slack/Notion/Calendar/Drive/Linear/Jira every 20 min; atlas-recall extracts from the conversation transcript at Stop time.
6. **Deterministic Rust vs. hot-edit TypeScript.** openhuman buys correctness with build friction (Rust 1.93 + Tauri 2 + CEF + pnpm 10.10); atlas-recall buys iteration speed at the cost of compile-time guarantees.

## What each could borrow from the other

**atlas-recall could adopt (from [memory-arch §What atlas-recall could borrow](./02-memory-architecture.md)):**
- Typed event log (Fact / Decision / Commitment / Preference / Foresight) — unifies the three sibling tables
- Graph triples for entity/relation queries ("everything connected to project X")
- Confidence-weighted user profile — currently a 1.2KB markdown blob
- Retrieval *plan* with seed-entities + temporal operators — beats single-shot FTS+vector fanout
- Unify the write path — close the seam between markdown extraction and SQLite structured storage

**openhuman could adopt (from [memory-arch §What openhuman could borrow](./02-memory-architecture.md)):**
- Curation as a first-class tier (LoA's reserved slots + lineage chain) so generated summaries can't crowd out human-validated wisdom
- Session-start context tier with hard char budgets (push L0/L1 instead of pull-only RPC)
- MCP-native read path so the same store works across editors / agents without a Tauri wrapper

## Feature-parity at-a-glance

From [`03-feature-parity.md`](./03-feature-parity.md). Many entries elided — see full matrix in the source doc.

| Capability | openhuman | atlas-recall |
|---|---|---|
| Auto-fetch from external integrations | ✅ 118+ OAuth, 20-min loop | ❌ |
| Knowledge graph (`graph_upsert` / `graph_query`) | ✅ | ❌ |
| KV store with per-namespace enumeration | ✅ | ❌ |
| Namespaces (`skill-*` / `vision` / `conversations` / `global`) | ✅ | partial (project-level only) |
| Token-compression layer ("TokenJuice") | ✅ | ❌ |
| Vision-namespace screen-intelligence | ✅ | ❌ |
| Desktop UI / mascot / Meet attendee | ✅ | ❌ |
| Obsidian-compatible vault | ✅ | partial (markdown sidecars) |
| Typed records (decisions / learnings / breadcrumbs / LoA) | ❌ | ✅ |
| Decision lifecycle (`supersede` / `revert` / confidence) | ❌ | ✅ |
| Importance scoring 1–10 + pin/unpin | ❌ | ✅ |
| Hybrid FTS + vector with RRF (k=60) fusion | ❌ | ✅ |
| Clustering command (`mem cluster`) | implicit | ✅ explicit |
| Identity onboarding interview (`mem onboard` → L0) | ❌ | ✅ |
| Tiered SessionStart injection (L0 + L1 + reserved LoA slots) | implicit | ✅ explicit |
| PreCompact flush hook | ❌ | ✅ |
| Batch / cron catch-up extractor | ❌ | ✅ |
| TELOS / goals auto-sync | ❌ | ✅ |
| Benchmark suite with locked baselines | ❌ | ✅ |
| MCP-native (Claude Code / Pi / OpenCode) | optional via `agentmemory` proxy | ✅ first-class |
| Health diagnostics (`doctor` / `stats`) | ❌ documented | ✅ |

## Security / process note

During pass 03 (feature-parity), the openhuman documentation pages returned **five separate prompt-injection attempts** embedded in fetched content — fake `<system-reminder>` blocks trying to switch modes, claim file edits, exit plan mode, or suppress questions. The sub-agent correctly ignored all five and flagged them in its report header. See [feature-parity §opening warning](./03-feature-parity.md). Worth investigating whether this is an intentional honeypot, an artefact of an upstream LLM-generated docs pipeline, or a third-party compromise. Either way: validates the choice to keep the agent boundary clean and never trust fetched content as instructions.

## Substrate dimensions worth remembering

From [`01-tech-stack.md`](./01-tech-stack.md) and [`02-memory-architecture.md`](./02-memory-architecture.md).

| Dimension | openhuman | atlas-recall |
|---|---|---|
| Primary language | Rust (~14.7 MB) + TypeScript (~5.6 MB) | TypeScript only |
| Runtime | Tokio + Tauri 2 + Node ≥24 (frontend) | Bun (shebang rewrite on build) |
| Direct deps (root manifest) | ~80 crates + ~40 + ~35 devDeps | 3 prod deps + 4 devDeps |
| Persistence | `rusqlite` 0.37 + `postgres` 0.19 client | `bun:sqlite` (FTS5, WAL, 0600) |
| Embedding model | `bge-m3`, 1024-dim | `nomic-embed-text`, 768-dim |
| DB location | `<workspace>/memory/memory.db` + `<workspace>/memory_tree/chunks.db` | `~/.claude/memory.db` |
| Stores | 2 coexisting (unified + memory_tree) | 1 unified + legacy markdown sidecar |
| HTTP / RPC | axum 0.8 + socketioxide 0.15 + WS | MCP stdio (no HTTP server) |
| Frontend | React 19 + Redux Toolkit + Tailwind + Three.js + Remotion | none |
| Observability | OpenTelemetry + Prometheus + Sentry (Rust + React) | none (intentional) |
| Distribution | deb + Homebrew + npm + signed macOS DMG | `install.sh` from GitHub |
| Repo size signal | Cargo.lock 222 KB, pnpm-lock.yaml 386 KB | bun.lock + tiny manifest |

## The central question

From [`04-architectural-philosophy.md`](./04-architectural-philosophy.md).

> **What is memory FOR?**
>
> openhuman answers: *memory is the substrate for an AI that knows everything about you and can help continuously.* That makes the agent a being — it needs voice, a mascot, omnidirectional inputs, deterministic compression of years of context.
>
> atlas-recall answers: *memory is the substrate so the next session doesn't start cold on this project.* That makes the agent a colleague — it doesn't need to know everything; it needs to know what was decided last Tuesday and why.

Both are coherent. The trade-offs each accepts are the trade-offs the other would refuse.

---

## Methodology note

Generated as a stress-test of the post-migration voice system: four claude sessions running in parallel herdr panes (workspace `voice-stress`), each given a different research angle, all writing concurrently. The `voice-callers.jsonl` diagnostic captured: **4 VoiceGreeting fires within 315ms** at dispatch (req-20→23), serialised across afplay over 4.6s of wall-clock; subsequent VoiceCompletion events at staggered session-end times; zero `ppid:1` patterns outside the legitimate Pulse cron alert. No zombie voice race observed under controlled multi-session load.
