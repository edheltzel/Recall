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

## How It Works

After installation, LMF3 runs silently in the background:

1. **You work normally** with Claude Code on your projects
2. **Sessions auto-extract** — when you end a session, the `SessionExtract` hook parses the conversation via Claude Haiku and stores structured summaries in `~/.claude/MEMORY/`
3. **Database grows** — extracted sessions, decisions, learnings, and breadcrumbs accumulate in `~/.claude/memory.db` (SQLite with FTS5 indexes)
4. **Next session** — Claude Code has MCP tools (`memory_search`, `memory_recall`, `context_for_agent`) to find relevant past context automatically
5. **Over time** — your memory database grows, making Claude increasingly effective at your specific projects and patterns

---

## Prerequisites

Install these **before** running `install.sh`. Each is required unless marked optional.

### 1. Ubuntu / Debian Linux

LMF3 is tested on Ubuntu 22.04+ and Debian 12+. Other Linux distros should work but are untested.

### 2. Bun (JavaScript runtime)

LMF3 uses Bun for TypeScript execution and `bun:sqlite` for the database.

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
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

### 5. Fabric (Optional but Recommended)

Fabric provides the `extract_wisdom` pattern used for rich LoA (Library of Alexandria) entries. LMF3 falls back to an inline prompt if Fabric isn't available, but Fabric extractions are higher quality.

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
1. Back up any existing Claude Code config files (`.mcp.json`, `CLAUDE.md`, `settings.json`, `memory.db`)
2. Install dependencies via `bun install`
3. Build TypeScript source via `tsup`
4. Link `mem` and `mem-mcp` globally via `npm link`
5. Initialize the SQLite database at `~/.claude/memory.db`
6. Configure the MCP server in `~/.claude/.mcp.json`
7. Set up session extraction hooks in `~/.claude/hooks/` and register in `~/.claude/settings.json`
8. Copy the Claude guide to `~/.claude/LMF3_GUIDE.md`
9. Add a MEMORY section to `~/.claude/CLAUDE.md`

**After install:** Restart Claude Code to load the MCP server and hooks.

### Session Extraction (Automatic)

The installer automatically sets up session extraction:
- Copies `SessionExtract.ts` and `BatchExtract.ts` to `~/.claude/hooks/`
- Registers the Stop hook in `~/.claude/settings.json`

After installation, every session end triggers automatic extraction. The hook:
1. Reads the session's JSONL conversation file
2. Sends it to Claude Haiku for structured extraction
3. Appends results to 6 memory files in `~/.claude/MEMORY/`
4. Tracks extraction state to prevent duplicates

If Haiku is unavailable, it falls back to a local Ollama model (configurable via `LMF3_OLLAMA_MODEL`).

**(Optional)** Set up cron for batch extraction of missed sessions:
```bash
crontab -e
# Add this line (runs every 30 minutes):
*/30 * * * * ~/.bun/bin/bun run ~/.claude/hooks/BatchExtract.ts --limit 20 >> /tmp/lmf3-batch.log 2>&1
```

---

## Architecture

### File Layout

```
~/.claude/
├── memory.db                          # SQLite database (FTS5 + WAL mode)
├── LMF3_GUIDE.md                      # Guide for the Claude Code instance
├── MEMORY/
│   ├── DISTILLED.md                   # All extracted session summaries (full archive)
│   ├── HOT_RECALL.md                  # Last 10 sessions (fast context loading)
│   ├── SESSION_INDEX.json             # Searchable session metadata lookup
│   ├── DECISIONS.log                  # Architectural decisions (deduplicated)
│   ├── REJECTIONS.log                 # Things to avoid
│   ├── ERROR_PATTERNS.json            # Known error/fix pairs
│   └── .extraction_tracker.json       # Per-file extraction state (dedup + retry)
├── hooks/
│   ├── SessionExtract.ts              # SessionEnd extraction hook
│   └── BatchExtract.ts                # Cron batch extractor
├── settings.json                      # Hook registration (Stop → SessionExtract)
└── .mcp.json                          # MCP server config (lmf-memory)
```

### Database Tables

| Table | Purpose | FTS5 Indexed |
|-------|---------|:---:|
| `sessions` | Claude Code session metadata (ID, timestamps, project, branch) | No |
| `messages` | Conversation turns (user + assistant content) | Yes |
| `loa_entries` | Library of Alexandria curated knowledge with Fabric extraction | Yes |
| `decisions` | Architectural decisions with reasoning and status | Yes |
| `learnings` | Problems solved and patterns discovered | Yes |
| `breadcrumbs` | Contextual notes, references, and TODOs (with importance 1-10) | Yes |
| `telos` | Purpose framework entries — Problems, Missions, Goals, Strategies (optional) | Yes |
| `documents` | Imported standalone markdown documents (optional) | Yes |
| `embeddings` | Vector embeddings for semantic search (768-dim, nomic-embed-text) | N/A |

All FTS5-indexed tables have automatic sync triggers (INSERT/UPDATE/DELETE → FTS5 index stays consistent).

### Search Architecture

LMF3 supports three search modes:

| Mode | Command | MCP Tool | How It Works |
|------|---------|----------|-------------|
| **Keyword** | `mem search "query"` | `memory_search` | SQLite FTS5 full-text search. Supports AND, OR, NOT, prefix*, "exact phrases" |
| **Semantic** | `mem semantic "query"` | — | Ollama embedding → cosine similarity against stored vectors |
| **Hybrid** | `mem hybrid "query"` or `mem "query"` | `memory_hybrid_search` | Both keyword + semantic combined via Reciprocal Rank Fusion (k=60). Falls back to keyword-only if Ollama unavailable |

### Extraction Pipeline

When a session ends:

```
Session End → Stop Hook → SessionExtract.ts
                              │
                              ├── Read JSONL conversation file
                              ├── Extract text (skip tool results, thinking blocks)
                              ├── If >120K chars: chunk and meta-extract
                              ├── Send to Claude Haiku API (or Ollama fallback)
                              ├── Quality gate: reject if missing "ONE SENTENCE SUMMARY"
                              ├── Append to DISTILLED.md (full archive)
                              ├── Update HOT_RECALL.md (last 10 sessions)
                              ├── Update SESSION_INDEX.json (searchable metadata)
                              ├── Append to DECISIONS.log (deduplicated)
                              ├── Append to REJECTIONS.log
                              └── Update ERROR_PATTERNS.json
```

The hook self-spawns in background so the session exits immediately (non-blocking).

---

## MCP Tools

When Claude Code connects to the LMF MCP server, these tools become available:

### memory_search
FTS5 keyword search across all memory tables. **Use before asking the user to repeat anything.**
```
memory_search({ query: "kubernetes auth", project: "my-app", table: "decisions", limit: 10 })
```

### memory_hybrid_search
Combined keyword + semantic search with Reciprocal Rank Fusion. Best for natural language queries. Falls back to keyword-only if embeddings unavailable.
```
memory_hybrid_search({ query: "how did we handle rate limiting", project: "my-app" })
```

### memory_recall
Get recent context — LoA entries, decisions, and breadcrumbs. Good for session start.
```
memory_recall({ limit: 5, project: "my-app" })
```

### context_for_agent
**Call this before spawning any agent via the Task tool.** Uses hybrid search to find relevant memory context. Also recommends whether to call Brave web search based on task indicators.
```
context_for_agent({ agent_task: "Refactor the auth middleware", project: "my-app" })
```

### memory_add
Add structured records during sessions.
```
memory_add({ type: "decision", content: "Use PostgreSQL over MySQL", detail: "Better JSON support" })
memory_add({ type: "learning", content: "bun:sqlite uses $param syntax", detail: "Not :param like better-sqlite3" })
memory_add({ type: "breadcrumb", content: "Auth refactor in progress, don't touch middleware" })
```

### memory_stats
Get database statistics (record counts, database size).

### loa_show
Show a full Library of Alexandria entry with its Fabric extract_wisdom content.
```
loa_show({ id: 1 })
```

---

## CLI Reference

### Search

```bash
mem search <query>              # FTS5 keyword search
mem hybrid <query>              # Hybrid keyword + semantic search (default for bare query)
mem semantic <query>            # Semantic-only search (requires Ollama)
mem "<query>"                   # Shortcut for hybrid search
mem search <query> -t decisions # Search specific table
mem search <query> -p myproject # Filter by project
```

### Capture

```bash
mem dump <title>                # Import current session + create LoA entry (end-of-session workflow)
mem loa write <title>           # Create LoA entry from messages since last LoA
mem loa write <title> -c 1      # Continue from previous LoA entry (creates chain)
mem loa write <title> -p proj   # Tag with project
mem loa write <title> -t "a,b"  # Add tags
```

### Structured Records

```bash
mem add decision "Use TypeScript" --why "Type safety" -p myproject
mem add learning "Port 4000 conflict" "Use dynamic port allocation" --prevention "Check port first"
mem add breadcrumb "Auth refactor in progress" -p myproject -i 8   # importance 1-10
```

### Browse

```bash
mem loa list                    # List recent LoA entries
mem loa show <id>               # Full Fabric extract
mem loa quote <id>              # Raw source messages
mem recent                      # Recent records across all tables
mem recent decisions            # Recent decisions only
mem show decisions 5            # Show full decision #5
mem stats                       # Database statistics
```

### Import & Embeddings

```bash
mem import --dry-run            # Preview session import
mem import --yes -v             # Import all Claude Code sessions from ~/.claude/projects/
mem embed backfill -t loa       # Generate embeddings for LoA entries
mem embed backfill -t decisions # Generate embeddings for decisions
mem embed stats                 # Check embedding service status
mem telos import --dry-run      # Preview TELOS framework import (optional)
mem docs import --dry-run       # Preview document import (optional)
```

### Database

```bash
mem init                        # Initialize database (safe to re-run)
```

---

## Daily Workflows

### Session Start
Memory is automatically available via MCP. Claude Code can call `memory_recall` or `memory_search` to load context from past sessions.

### During a Session
- Claude Code uses `memory_search` before asking the user to repeat information
- When architectural decisions are made, Claude uses `memory_add` to record them
- Before spawning agents, Claude calls `context_for_agent` to enrich the agent's prompt

### End of Session
When you're done, tell Claude to run:
```bash
mem dump "Descriptive Session Title"
```
This imports the session's messages and creates a curated LoA entry with Fabric extraction.

### Agent Spawning
```
1. User requests: "Research caching solutions"
2. Claude calls: context_for_agent("Research caching solutions", "myproject")
3. If Brave recommended → calls brave_web_search
4. Includes memory context in agent prompt
5. Spawns agent with enriched context
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

Your database and memory files are preserved across updates. To also update the hooks:
```bash
cp hooks/SessionExtract.ts ~/.claude/hooks/
cp hooks/BatchExtract.ts ~/.claude/hooks/
```

---

## Backup & Restore

```bash
./install.sh list              # List available backups
./install.sh restore           # Restore most recent backup
./install.sh restore 20260219  # Restore specific backup
```

The installer automatically backs up existing files before any changes. Backups are stored at `~/.claude/backups/lmf3/`.

Manual backup:
```bash
cp ~/.claude/memory.db ~/.claude/memory.db.backup
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEM_DB_PATH` | `~/.claude/memory.db` | Database file location |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL for embeddings |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model for vector embeddings (768-dim) |
| `LMF3_OLLAMA_MODEL` | `qwen2.5:3b` | Ollama model for extraction fallback (when Anthropic API unavailable) |
| `LMF_BASE_DIR` | `~/.claude` | Base directory for document imports |

---

## Troubleshooting

### "Database not found"
```bash
mem init
```

### "Bun install fails — unzip required"
```bash
sudo apt-get install -y unzip
```

### "Fabric extraction failed"
Fabric is **optional** — only needed for `mem loa write` and `mem dump`. Core functionality (search, add, MCP tools) works without it.

```bash
# Verify Fabric works:
echo "test" | fabric --pattern extract_wisdom
```

### "MCP server not connecting"
1. Check `~/.claude/.mcp.json` syntax:
```json
{
  "mcpServers": {
    "lmf-memory": {
      "command": "mem-mcp",
      "args": []
    }
  }
}
```
2. Verify `mem-mcp` is in PATH: `which mem-mcp`
3. Test manually: `mem-mcp` (should hang waiting for stdin — Ctrl+C to exit)
4. Restart Claude Code

### "Session extraction not running"
1. Check hook is registered: `grep SessionExtract ~/.claude/settings.json`
2. Check hook file exists: `ls ~/.claude/hooks/SessionExtract.ts`
3. Check bun is accessible: `~/.bun/bin/bun --version`
4. Check extraction log: `cat ~/.claude/MEMORY/EXTRACT_LOG.txt`
5. Check claude CLI is available: `which claude`

### "Embedding service unavailable"
Embeddings are optional. Hybrid search falls back to FTS5-only automatically.

To enable:
```bash
ollama pull nomic-embed-text
# Verify: curl http://localhost:11434/api/tags
```

### Fresh Install Verification Checklist

```bash
# 1. System deps
which node npm bun

# 2. CLI linked
which mem mem-mcp

# 3. Database exists
ls -la ~/.claude/memory.db

# 4. MCP configured
cat ~/.claude/.mcp.json | grep lmf-memory

# 5. Hook registered
grep SessionExtract ~/.claude/settings.json

# 6. Hook file exists
ls ~/.claude/hooks/SessionExtract.ts

# 7. Test it
mem stats
```

---

## Technical Details

### SQLite Configuration
- **WAL mode** for concurrent reads (no locking during MCP queries)
- **FTS5** full-text search with automatic sync triggers
- **Foreign key constraints** enforced
- **File permissions** set to 0600 (owner read/write only)

### Extraction Quality
- **Chunked extraction** for sessions >120K characters
- **Meta-extraction** merges partial chunk results
- **Quality gate** rejects extractions missing required sections
- **Retry window** of 24 hours for failed extractions
- **Re-extraction** triggers when file grows by >50%

### Security
- Database files: chmod 0600 (owner-only access)
- Path validation: whitelist allowed characters, prevents shell injection
- Parameterized queries: no SQL injection vectors
- MCP authentication: requires Claude Code session (not publicly accessible)

---

## License

MIT
