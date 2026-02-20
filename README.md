# LMF3 — Persistent Memory for Claude Code

**LMF3** gives Claude Code persistent memory across sessions. Every conversation is automatically extracted, indexed, and searchable — so your AI assistant remembers what you've worked on together.

---

## What LMF3 Does

Without LMF3, every Claude Code session starts from zero. With LMF3:

- **Session Extraction** — When a session ends, the conversation is automatically extracted into structured summaries (ideas, decisions, errors fixed, insights)
- **Full-Text Search** — Search all past conversations via `mem search "kubernetes migration"` or the MCP `memory_search` tool
- **Hybrid Search** — Combines keyword (FTS5) and semantic (vector embeddings) search with Reciprocal Rank Fusion
- **Library of Alexandria (LoA)** — Curated knowledge entries with Fabric extract_wisdom analysis
- **Decision Tracking** — Record and search architectural decisions with reasoning
- **Learning Capture** — Record problems solved and patterns discovered
- **Breadcrumbs** — Drop contextual notes for future sessions
- **MCP Server** — Claude Code can search memory, add records, and prepare context for spawned agents — all via MCP tools
- **Batch Extraction** — Cron job catches any sessions that slipped through the cracks

## What Users Can Expect

After installation, LMF3 runs silently in the background:

1. **You work normally** with Claude Code on your projects
2. **Sessions auto-extract** — when you end a session, the conversation is parsed and stored
3. **Next session** — Claude Code has MCP tools (`memory_search`, `memory_recall`, etc.) to find relevant past context
4. **Over time** — your memory database grows, making Claude increasingly effective at your specific projects and patterns

The `mem` CLI lets you interact with memory directly:
```bash
mem search "auth flow"          # Search all memory
mem recent                      # Recent activity
mem stats                       # Database statistics
mem loa list                    # Browse curated knowledge
mem dump "Session title"        # Manually capture current session
```

---

## Prerequisites

Install these **before** running `install.sh`. Each is required unless marked optional.

### 1. Ubuntu / Debian Linux

LMF3 is tested on Ubuntu 22.04+ and Debian 12+. Other Linux distros should work but are untested.

### 2. Bun (JavaScript runtime)

LMF3 uses Bun for TypeScript execution and `bun:sqlite` for the database.

```bash
curl -fsSL https://bun.sh/install | bash
```

- **Source:** [https://bun.sh](https://bun.sh)
- **Minimum version:** 1.0+
- **Why:** Fast TypeScript execution, built-in SQLite driver, no native module compilation needed

### 3. Node.js and npm

Required for global linking (`npm link`) so `mem` and `mem-mcp` are on your PATH.

```bash
# Ubuntu/Debian
sudo apt install nodejs npm

# Or use nvm (recommended):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install --lts
```

- **Source:** [https://nodejs.org](https://nodejs.org) or [https://github.com/nvm-sh/nvm](https://github.com/nvm-sh/nvm)
- **Minimum version:** Node 18+

### 4. Claude Code (Anthropic CLI)

LMF3 is an extension for Claude Code. You need a working Claude Code installation.

```bash
npm install -g @anthropic-ai/claude-code
```

- **Source:** [https://docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)
- **Required:** Active Anthropic API subscription or Claude Pro/Max plan

### 5. Anthropic API Key

The session extraction hook uses Claude Haiku to parse conversations. Set this in your shell profile:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

- **Get yours:** [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
- **Cost:** Extraction uses `claude-haiku-4-5` — typically < $0.01 per session extraction
- **Note:** If you use Claude Code with a Pro/Max plan, you still need a separate API key for the extraction hook (it runs outside Claude Code's session)

### 6. Fabric (Optional but Recommended)

Fabric provides the `extract_wisdom` pattern used for rich session analysis. LMF3 falls back to an inline prompt if Fabric isn't available, but Fabric extractions are higher quality.

```bash
go install github.com/danielmiessler/fabric@latest
fabric --setup
```

- **Source:** [https://github.com/danielmiessler/fabric](https://github.com/danielmiessler/fabric)
- **Requires:** Go 1.22+ — [https://go.dev/doc/install](https://go.dev/doc/install)
- **After install:** Run `fabric --setup` to configure your API keys and download patterns

### 7. Ollama (Optional — for Semantic Search)

Vector embeddings enable semantic search (find related content even when keywords don't match). Without Ollama, LMF3 uses keyword search only — still very capable.

```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull nomic-embed-text
```

- **Source:** [https://ollama.ai](https://ollama.ai)
- **Model:** `nomic-embed-text` (768-dimension embeddings, ~270MB)
- **Note:** Set `OLLAMA_URL` env var if Ollama runs on a different host (default: `http://localhost:11434`)

---

## Installation

```bash
git clone https://github.com/nixfred/LMF3.git ~/Projects/LMF3
cd ~/Projects/LMF3
./install.sh
```

The installer will:
1. Back up any existing Claude Code config files
2. Install dependencies via `bun install`
3. Build TypeScript source
4. Link `mem` and `mem-mcp` globally
5. Initialize the SQLite database at `~/.claude/memory.db`
6. Configure the MCP server in `~/.claude/.mcp.json`
7. Set up session extraction hooks in `~/.claude/hooks/` and `~/.claude/settings.json`
8. Copy the Claude guide to `~/.claude/LMF3_GUIDE.md`
9. Add a MEMORY section to `~/.claude/CLAUDE.md`

**After install:** Restart Claude Code to load the MCP server.

### Session Extraction (Automatic)

The installer automatically sets up session extraction:
- Copies `SessionExtract.ts` and `BatchExtract.ts` to `~/.claude/hooks/`
- Registers the Stop hook in `~/.claude/settings.json`

After installation, every session end triggers automatic extraction.

**(Optional)** Set up cron for batch extraction of missed sessions:
```bash
crontab -e
# Add this line (runs every 30 minutes):
*/30 * * * * ~/.bun/bin/bun run ~/.claude/hooks/BatchExtract.ts --limit 20 >> /tmp/lmf3-batch.log 2>&1
```

---

## Architecture

```
~/.claude/
├── memory.db                          # SQLite database (FTS5 + WAL mode)
├── MEMORY/
│   ├── DISTILLED.md                   # All extracted session summaries
│   ├── HOT_RECALL.md                  # Last 10 sessions (fast context)
│   ├── SESSION_INDEX.json             # Searchable session lookup
│   ├── DECISIONS.log                  # Architectural decisions
│   ├── ERROR_PATTERNS.json            # Known error/fix pairs
│   └── .extraction_tracker.json       # Per-file extraction state
├── hooks/
│   ├── FabricExtract.hook.ts          # SessionEnd extraction hook
│   └── BatchExtract.ts               # Cron batch extractor
└── .mcp.json                          # MCP server config
```

### Database Tables

| Table | Purpose |
|-------|---------|
| `sessions` | Claude Code session metadata |
| `messages` | Conversation turns (user + assistant) |
| `loa_entries` | Library of Alexandria curated knowledge |
| `decisions` | Architectural decisions with reasoning |
| `learnings` | Problems solved and patterns discovered |
| `breadcrumbs` | Contextual notes and references |
| `telos` | Purpose framework entries (optional) |
| `documents` | Imported standalone documents |
| `embeddings` | Vector embeddings for semantic search |

All text tables have FTS5 full-text search indexes with automatic sync triggers.

---

## MCP Tools

When Claude Code connects to the LMF MCP server, these tools become available:

| Tool | Purpose |
|------|---------|
| `memory_search` | FTS5 keyword search across all memory |
| `memory_hybrid_search` | Combined keyword + semantic search with RRF |
| `memory_recall` | Recent context (LoA entries, decisions, breadcrumbs) |
| `loa_show` | Full Library of Alexandria entry |
| `memory_add` | Add decision, learning, or breadcrumb |
| `memory_stats` | Database statistics |
| `context_for_agent` | Prepare memory context before spawning agents |

---

## CLI Reference

```bash
mem init                        # Initialize database
mem search <query>              # Full-text search
mem hybrid <query>              # Hybrid keyword + semantic search
mem semantic <query>            # Semantic-only search
mem recent [table]              # Recent records
mem show <table> <id>           # Show full record
mem stats                       # Database statistics
mem add decision <text>         # Record a decision
mem add learning <prob> <sol>   # Record a learning
mem add breadcrumb <text>       # Drop a breadcrumb
mem loa write <title>           # Create LoA entry
mem loa list                    # List LoA entries
mem loa show <id>               # Show full LoA entry
mem dump <title>                # Flush session + create LoA
mem docs import                 # Import standalone documents
mem telos import                # Import TELOS framework entries
mem embed backfill              # Generate vector embeddings
```

---

## Updating

```bash
cd ~/Projects/LMF3
git pull
bun install
bun run build
sudo npm link
```

Your database and memory files are preserved across updates.

---

## Backup & Restore

```bash
./install.sh list              # List available backups
./install.sh restore           # Restore most recent backup
./install.sh restore 20260219  # Restore specific backup
```

The installer automatically backs up existing files before any changes.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | (required) | API key for Haiku extraction |
| `MEM_DB_PATH` | `~/.claude/memory.db` | Database location |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server for embeddings |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `LMF3_OLLAMA_MODEL` | `qwen2.5:3b` | Ollama model for extraction fallback (when Anthropic API unavailable) |

---

## License

MIT
