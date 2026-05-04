<p align="center">
  <img src="assets/banner.png" alt="Recall — Persistent Memory for Coding Agents" width="100%">
</p>

# Recall — Persistent Memory for Coding Agents

All coding agents forget when a session ends. Recall doesn't — it extracts, indexes, and recalls what matters across every session, across every agent you use.

Built on the [Model Context Protocol](https://modelcontextprotocol.io). One SQLite file. No phone-home. No vendor lock-in.

> Stable on [Claude Code](https://claude.com/claude-code). Beta on [Pi](https://pi.dev/) and [OpenCode](https://opencode.ai/) (MCP works; lifecycle extensions are early). [Codex CLI](https://github.com/openai/codex) and [Gemini CLI](https://github.com/google-gemini/gemini-cli) on the roadmap. See [Roadmap](#roadmap).

---

[Jump to the Docs](#documentation)

## The Problem

Coding agents have no memory between sessions. Context is lost. You repeat yourself. Decisions made last week are forgotten today. Every new session re-learns the basics.

## How Recall Fixes It

Install once, then forget about it. Recall runs silently in the background:

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────────┐
│ You Work │───▶│ Session Ends │───▶│ Auto-Extract │───▶│ SQLite + FTS5 │───▶│ Next Session │
└─────▲────┘    └──────────────┘    └──────────────┘    └───────────────┘    └──────┬───────┘
      │                                                                             │
      └───────────────────────────── Memory Available ──────────────────────────────┘
```

- **Auto-extraction** — sessions are parsed into structured summaries when they end
- **Full-text + semantic search** — find anything from any past session
- **Tiered session-start context** — L0 identity (who you are) + L1 importance-ranked top records load automatically
- **Zero friction** — no workflow changes, no manual steps
- **MCP integration** — your agent searches memory automatically through standard MCP tools

## Why Recall

Four things that set Recall apart from cloud-hosted memory layers and from agent-specific scratch files:

- **Local-first, zero infrastructure.** One SQLite file at `~/.claude/memory.db`. WAL mode, `0600` perms. No vector database, no graph database, no agent server, no API keys for retrieval. Nothing leaves your machine — no telemetry, no phone-home. Optional Ollama for embeddings (also local).
- **Multi-agent native.** One memory layer across the agents you actually use. Stable on Claude Code today; Pi and OpenCode connect via MCP; Codex CLI and Gemini CLI on the way. Memories captured by one agent are searchable from any other agent on the same machine.
- **Structured taxonomy, not a flat blob.** Decisions (with supersede/revert lifecycle and confidence scoring), learnings, breadcrumbs, and curated **Library of Alexandria** entries — each has a purpose and a query path. Importance scoring (1–10) surfaces what matters first.
- **Hybrid search that works offline.** FTS5 keyword search ships with SQLite — no embedding infrastructure required to find anything. Optional Ollama embeddings layer on top for semantic queries. Both are merged via Reciprocal Rank Fusion. Lose Ollama, lose nothing — the keyword path keeps working.

## Quick Start

```bash
git clone https://github.com/edheltzel/Recall.git
cd Recall
./install.sh
```

Verify it works:

```bash
mem stats        # Database overview
mem doctor       # Health check
```

Restart your agent (Claude Code, Pi, or OpenCode) to load the MCP server and hooks.

### First run: set your identity

Recall's tiered SessionRecall injects a small identity file at the top
of every session (the L0 tier — your role, projects, tools, and working
preferences). Without it, L0 is empty and every new session has to
re-learn the basics.

```bash
mem onboard
```

A 7-question interview that writes `~/.claude/MEMORY/identity.md`. Run
it once. Re-run whenever your role, active projects, or working
preferences change. Use `|` (not `,`) to separate values so a phrase
like `no force-push, ever` survives as a single entry.

### Updating

From inside Claude Code, `/Recall:update` prints the current vs. latest
release and the exact command to run. From a shell:

```bash
./update.sh --check   # version check only
./update.sh           # full update: pull, build, migrate, re-register hooks
```

### Uninstalling

```bash
./uninstall.sh --dry-run   # preview, touch nothing
./uninstall.sh             # surgical remove; preserves memory.db + backups
./uninstall.sh --purge     # also destroy memory.db + backup tree (confirmed)
```

> [Full installation guide](docs/installation.md) — prerequisites, platform support, session extraction setup, uninstalling

## How Recall Works

Recall operates as three integrated layers — data flows in automatically, gets stored in a searchable database, and surfaces when you (or Claude) need it.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        DATA ENTRY POINTS                             │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐  ┌────────────┐    │
│  │ CLI Direct │  │ MCP Server │  │  Stop Hook   │  │   Batch    │    │
│  │  mem add   │  │ (Claude    │  │ SessionExt-  │  │  Extract   │    │
│  │  mem dump  │  │  Code)     │  │  ract.ts     │  │  (cron)    │    │
│  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘  └─────┬──────┘    │
└────────┼────────────────┼────────────────┼────────────────┼──────────┘
         │                │                │                │
         ▼                ▼                ▼                ▼
┌───────────────────────────────────────────────────────────────────────┐
│                      PROCESSING LAYER                                 │
│                                                                       │
│  Direct Inserts:              Session Extraction Pipeline:            │
│  mem add breadcrumb ──┐       Read JSONL                              │
│  mem add decision  ───┤         → Filter noise (tool results)         │
│  mem add learning  ───┤         → Dedup check (.extraction_tracker)   │
│  memory_add (MCP)  ───┤         → Acquire lock                        │
│                       │         → Claude Haiku extract                │
│                       │           (>120K? chunk → meta-extract)       │
│                       │           (fallback: Ollama)                  │
│                       │         → Quality gate                        │
│                       │           (requires SUMMARY + MAIN IDEAS)     │
│                       │              │                                │
└───────────────────────┼──────────────┼────────────────────────────────┘
                        │              │
                        ▼              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    STORAGE LAYER (Dual-Write)                        │
│                                                                      │
│  SQLite (~/.claude/memory.db)       Memory Files (~/.claude/MEMORY/) │
│  ┌────────────────────────────┐     ┌──────────────────────────────┐ │
│  │ sessions ←── messages      │     │ DISTILLED.md    (archive)    │ │
│  │ decisions    learnings     │     │ HOT_RECALL.md   (last 10)    │ │
│  │ breadcrumbs  loa_entries   │     │ SESSION_INDEX.json           │ │
│  │ embeddings (768-dim vecs)  │     │ DECISIONS.log                │ │
│  │                            │     │ REJECTIONS.log               │ │
│  │ FTS5 indexes (auto-sync)   │     │ ERROR_PATTERNS.json          │ │
│  │ WAL mode · 0600 perms      │     └──────────────────────────────┘ │
│  └────────────────────────────┘                                      │
└──────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      RETRIEVAL LAYER                                 │
│                                                                      │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────────────┐  │
│  │Keyword (FTS5) │  │Semantic (Embed)│  │  Hybrid (RRF Fusion)    │  │
│  │mem search     │  │mem semantic    │  │  mem hybrid (DEFAULT)   │  │
│  │memory_search  │  │embed → Ollama  │  │  FTS5 rank ─┐           │  │
│  │               │  │cosine sim      │  │  Embed rank ─┤→ merged  │  │
│  └───────────────┘  └────────────────┘  │  RRF(k=60) ◄┘           │  │
│                                         └─────────────────────────┘  │
│  Direct: mem recent · mem show · memory_recall · context_for_agent   │
└──────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  CONSUMERS:  Coding agents (MCP)  ·  CLI user (mem)  ·  Sub-agents   │
└──────────────────────────────────────────────────────────────────────┘
```

### Session Lifecycle

1. **Session starts** — A `SessionStart` hook loads recent decisions, breadcrumbs, and learnings from SQLite, giving Claude context from previous sessions immediately
2. **During the session** — your agent searches memory via MCP tools (`memory_search`, `memory_hybrid_search`) before falling back to git history. Decisions and learnings are recorded in real-time with `memory_add`
3. **Session ends** — A `Stop` hook fires `SessionExtract.ts`, which spawns a background process (non-blocking) to extract the conversation via Claude Haiku
4. **Extraction pipeline** — The conversation JSONL is filtered, deduplicated, and sent to Claude Haiku (with chunking for large sessions >120K chars). A quality gate rejects low-quality extractions
5. **Dual-write storage** — Results are written to both SQLite (structured, searchable) and markdown files (`DISTILLED.md`, `HOT_RECALL.md`, etc.)
6. **Batch catchup (optional)** — A cron job (`BatchExtract.ts`) can catch sessions missed during crashes or interruptions. `install.sh` prints the registration command at the end — opt in by running it once; nothing is auto-scheduled

### Search Strategies

| Strategy             | Command                      | How it works                                                                                                            |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Keyword**          | `mem search "query"`         | FTS5 full-text search across all tables                                                                                 |
| **Semantic**         | `mem embed semantic "query"` | Ollama embeddings → cosine similarity (requires Ollama)                                                                 |
| **Hybrid** (default) | `mem "query"`                | Both keyword + semantic, merged with Reciprocal Rank Fusion (k=60). Falls back to keyword-only if Ollama is unavailable |

> [Architecture deep-dive](docs/architecture.md) — database tables, FTS5 indexes, extraction pipeline details

## What You Get

- **Session memory** — auto-extracted on every session end via Claude Haiku
- **Full-text + semantic search** — FTS5 keyword search, Ollama vector embeddings, or hybrid with Reciprocal Rank Fusion
- **Tiered session-start context (v0.7.0+)** — L0 identity (your `identity.md`) + L1 top 12 records ranked by importance (with 4 reserved slots for Library of Alexandria entries)
- **Importance scoring (1-10)** — every record has an importance score; surfaces what matters most at session start. Manage with `mem pin` / `mem unpin` / `mem importance backfill`
- **PreCompact hook** — flushes in-flight messages to SQLite before Claude compacts its context, so nothing is lost
- **Benchmark harness** — measure your own context efficiency with `mem benchmark run B`
- **Decision & learning tracking** — record architectural decisions with reasoning, capture problems solved; decisions support lifecycle management (supersede/revert) and confidence scoring (high/medium/low)
- **Agent context** — spawned agents inherit relevant memory via `context_for_agent`
- **Library of Alexandria** — curated knowledge entries with Fabric extract_wisdom analysis
- **Breadcrumbs** — quick context notes for future sessions

## Measured wake-up efficiency

Suite B measures the byte cost of session-start memory injection. Latest tracked run ([2026-04-18, scope `atlas-recall`](benchmarks/results/2026-04-18T20-13-59-suite-B.md)):

| Variant                                      |     Chars | Tokens (est, 4 ch/tok) |
| -------------------------------------------- | --------: | ---------------------: |
| **v2 tiered SessionRecall** (L0 + L1 top 12) | **5,306** |             **~1,327** |
| v1 flat-blob SessionRecall (simulated)       |     8,020 |                 ~2,005 |
| CLAUDE.md static baseline                    |     8,760 |                 ~2,190 |

v2 is **51% smaller than v1** on this corpus. CLAUDE.md is hand-written static context; Recall is auto-extracted dynamic memory — the two are complementary, not competitors. Numbers scale with your own DB and L0 identity; reproduce with `mem benchmark run B`. Methodology and caveats live in [`benchmarks/README.md`](benchmarks/README.md).

## CLI at a Glance

```bash
mem "kubernetes auth"          # Search your memory
mem onboard                    # Seed your L0 identity tier (one-time)
mem dump "Session Title"       # Save this session
mem add decision "Use X" ...   # Record a decision
mem decision list              # List decisions with status and confidence
mem pin decisions 42           # Pin a record to high importance
mem benchmark run B            # Measure wake-up context efficiency
mem prune                      # Preview stale records for removal
mem stats                      # See what's stored
mem doctor                     # Health check
```

<details>
<summary>See it in action</summary>

| Search                                | Stats                               |
| ------------------------------------- | ----------------------------------- |
| ![mem search](assets/demo-search.gif) | ![mem stats](assets/demo-stats.gif) |

| Health Check                          | Recent Memory                         |
| ------------------------------------- | ------------------------------------- |
| ![mem doctor](assets/demo-doctor.gif) | ![mem recent](assets/demo-recent.gif) |

</details>

> [Full CLI reference](docs/cli-reference.md)

## For AI Agents

If you're an AI agent reading this repository:

| What you need                                                  | Where to find it                     |
| -------------------------------------------------------------- | ------------------------------------ |
| **Using Recall from Claude Code** (MCP tools, CLI, core rules) | [`FOR_CLAUDE.md`](FOR_CLAUDE.md)     |
| **Using Recall from OpenCode**                                 | [`FOR_OPENCODE.md`](FOR_OPENCODE.md) |
| **Using Recall from Pi**                                       | [`FOR_PI.md`](FOR_PI.md)             |
| **Developing Recall** (build, test, conventions)               | [`CLAUDE.md`](CLAUDE.md)             |

## Roadmap

Recall is built around two integration surfaces: **MCP** (memory search and add, available from inside the agent) and **lifecycle hooks** (auto-extraction, session-start context injection, pre-compact flushes). Different agents support different surfaces — the table below tracks where each one stands.

| Agent                                                         | MCP |                      Lifecycle hooks                       | Status                                |
| ------------------------------------------------------------- | :-: | :--------------------------------------------------------: | ------------------------------------- |
| [**Claude Code**](https://claude.com/claude-code)             | ✅  |            ✅ Stop · SessionStart · PreCompact             | **Stable** — reference implementation |
| [**Pi**](https://pi.dev/)                                     | ✅  | ⚠ Beta — `recall-compaction` + `recall-extract` extensions | In progress                           |
| [**OpenCode**](https://opencode.ai/)                          | ✅  |             ⚠ Alpha — `recall-extract` plugin              | In progress                           |
| [**Codex CLI**](https://github.com/openai/codex)              |  —  |                             —                              | Coming soon                           |
| [**Gemini CLI**](https://github.com/google-gemini/gemini-cli) |  —  |                             —                              | Coming soon                           |

**Candidate** — [Cursor](https://cursor.com): both `.cursor/hooks.json` and MCP are first-class; the integration model maps cleanly onto Recall's existing hook architecture. Tracked but not started.

Have an agent you'd like to see supported? [Open an issue](https://github.com/edheltzel/Recall/issues) — Recall is designed to be agent-agnostic, and any host that speaks MCP is a candidate.

## Documentation

| Guide                                      | Description                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| [Installation](docs/installation.md)       | Prerequisites, install, verify, session extraction                        |
| [CLI Reference](docs/cli-reference.md)     | All commands and options                                                  |
| [MCP Tools](docs/mcp-tools.md)             | Tools available to AI agents                                              |
| [Architecture](docs/architecture.md)       | Database, search, extraction pipeline                                     |
| [Slash Commands](docs/slash-commands.md)   | `/Recall:*` commands for Claude Code                                      |
| [Upgrading](docs/upgrading.md)             | Update, backup, migration system                                          |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes                                                   |
| [Changelog](CHANGELOG.md)                  | Release notes and breaking changes                                        |
| [Acknowledgments](ACKNOWLEDGMENTS.md)      | Ideas borrowed, reshaped, and rejected — with credits to original authors |

## Acknowledgments

Recall's tiered session-start context (L0 identity + L1 importance-ranked),
PreCompact hook, and importance scoring were inspired by
[MemPalace](https://github.com/MemPalace/mempalace) (Milla Jovovich,
Ben Sigman — MIT). We reshaped every adopted idea to fit Recall's
SQLite + FTS5 architecture and rejected others (PALACE_PROTOCOL
behavioral injection, KG triples) where they didn't survive review.
See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for the full what-we-took,
what-we-rejected, and credits to the independent critics (lhl, roman-rr,
danilchenko, tentenco) whose analyses shaped our reshape decisions.

## License

MIT
