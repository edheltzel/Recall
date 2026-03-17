<p align="center">
  <img src="assets/banner.png" alt="Recall — Persistent Memory for Claude Code" width="100%">
</p>

# Recall — Persistent Memory for Claude Code

Every Claude Code session starts from zero. Recall fixes that — conversations are automatically extracted, indexed, and searchable across sessions.

---

## The Problem

Claude Code has no memory between sessions. Context is lost. You repeat yourself. Decisions made last week are forgotten today.

## How Recall Fixes It

Install once, then forget about it. Recall runs silently in the background:

```mermaid
graph LR
    A[You Work] --> B[Session Ends]
    B --> C[Auto-Extract]
    C --> D[SQLite + FTS5]
    D --> E[Next Session]
    E -->|Memory Available| A

    style A fill:#3B82F6,color:#fff
    style C fill:#10B981,color:#fff
    style D fill:#F59E0B,color:#fff
```

- **Auto-extraction** — sessions are parsed into structured summaries when they end
- **Full-text + semantic search** — find anything from any past session
- **Zero friction** — no workflow changes, no manual steps
- **MCP integration** — Claude Code searches your memory automatically

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

Restart Claude Code to load the MCP server and hooks.

> [Full installation guide](docs/installation.md) — prerequisites, platform support, session extraction setup

## What You Get

- **Session memory** — auto-extracted on every session end via Claude Haiku
- **Full-text + semantic search** — FTS5 keyword search, Ollama vector embeddings, or hybrid with Reciprocal Rank Fusion
- **Decision & learning tracking** — record architectural decisions with reasoning, capture problems solved
- **Agent context** — spawned agents inherit relevant memory via `context_for_agent`
- **Library of Alexandria** — curated knowledge entries with Fabric extract_wisdom analysis
- **Breadcrumbs** — quick context notes for future sessions

## CLI at a Glance

```bash
mem "kubernetes auth"          # Search your memory
mem dump "Session Title"       # Save this session
mem add decision "Use X" ...   # Record a decision
mem stats                      # See what's stored
mem doctor                     # Health check
```

> [Full CLI reference](docs/cli-reference.md)

## For AI Agents

If you're an AI agent reading this repository:

| What you need | Where to find it |
|---------------|-----------------|
| **Using Recall** (MCP tools, CLI, core rules) | [`FOR_CLAUDE.md`](FOR_CLAUDE.md) |
| **Developing Recall** (build, test, conventions) | [`CLAUDE.md`](CLAUDE.md) |

## Documentation

| Guide | Description |
|-------|-------------|
| [Installation](docs/installation.md) | Prerequisites, install, verify, session extraction |
| [CLI Reference](docs/cli-reference.md) | All commands and options |
| [MCP Tools](docs/mcp-tools.md) | Tools available to AI agents |
| [Architecture](docs/architecture.md) | Database, search, extraction pipeline |
| [Slash Commands](docs/slash-commands.md) | `/recall:*` commands for Claude Code |
| [Upgrading](docs/upgrading.md) | Update, backup, migration system |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |

## License

MIT
