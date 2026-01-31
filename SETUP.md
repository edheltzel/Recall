# LMF3 Complete Setup Guide

This guide teaches your Claude Code instance **all memory techniques** for persistent knowledge across sessions.

---

## Part 1: Installation

### Prerequisites

**System packages (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install -y nodejs npm unzip build-essential git
```

**Required:**
1. **Node.js 18+** - For building and running
2. **Bun** (preferred) or npm - Package management
3. **build-essential** - For compiling native SQLite bindings

**Optional (for LoA wisdom extraction):**
4. **Fabric CLI** - For `mem loa write` and `mem dump` commands

### Install Bun

```bash
curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh
bash /tmp/bun-install.sh
source ~/.bashrc
```

### Install LMF3

```bash
cd ~/Projects/LMF3.x

# Install dependencies
bun install

# Build
bun run build

# IMPORTANT: If you copied this repo from another machine,
# rebuild native modules for your Node version:
npm rebuild better-sqlite3
bun run build

# Link CLI globally
sudo npm link

# Verify
which mem      # Should show /usr/bin/mem or similar
which mem-mcp  # Should show /usr/bin/mem-mcp
```

### Initialize Database

```bash
mem init
# Output: Database created at /home/USER/.claude/memory.db
```

### Configure MCP Server

Create or update `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "memory-larry": {
      "command": "mem-mcp",
      "args": []
    }
  }
}
```

### Update CLAUDE.md

Copy the memory section from `templates/CLAUDE.md.template` to your `~/.claude/CLAUDE.md`.

---

## Part 2: Memory Techniques

### Technique 1: Session Import

Import existing Claude Code conversations into the database.

```bash
# Preview what will be imported
mem import --dry-run

# Import all sessions
mem import --yes -v
```

This reads `~/.claude/projects/*/*.jsonl` files and extracts:
- Session metadata (ID, timestamps, project)
- All user/assistant message turns
- Project name from directory structure

**When to use:** After installing LMF3 to backfill history.

---

### Technique 2: Library of Alexandria (LoA)

**LoA is the core knowledge capture mechanism.** It extracts wisdom from conversations, not just stores them.

#### What Makes LoA Special

Raw transcripts are noise. LoA entries contain:
1. **Fabric extraction**: The `extract_wisdom` pattern distills insights, ideas, learnings
2. **Message lineage**: Links to source messages for auditability
3. **Continuation chains**: Can link related sessions via `parent_loa_id`
4. **Project context**: Tagged to specific projects

#### Creating LoA Entries

```bash
# Capture messages since last LoA
mem loa write "Session Title"

# With project tagging
mem loa write "VPN Configuration" -p infrastructure

# Continue from previous entry (creates a chain)
mem loa write "VPN Part 2" -c 1

# Add tags
mem loa write "Auth System" -t "auth,security,oauth"
```

#### Viewing LoA Entries

```bash
# List recent entries
mem loa list

# View full Fabric extract
mem loa show 1

# View raw source messages (quotable)
mem loa quote 1
```

#### The Dump Shortcut

`mem dump` combines session import + LoA capture in one command:

```bash
mem dump "Session Title"
```

This:
1. Finds the current session JSONL file
2. Imports all messages to database
3. Runs Fabric `extract_wisdom`
4. Creates LoA entry
5. Auto-embeds for semantic search (if Ollama available)

**This is your end-of-session workflow.** Do it every time.

---

### Technique 3: Structured Records

#### Decisions

Record architectural and process decisions with reasoning:

```bash
mem add decision "Use TypeScript over Python" --why "Type safety, team preference" -p myproject
```

Decisions have statuses: `active`, `superseded`, `reverted`

#### Learnings

Record problems solved and patterns discovered:

```bash
mem add learning "Port conflict on 4000" "Kill process or change port" -p myproject --prevention "Use dynamic port allocation"
```

#### Breadcrumbs

Quick context notes, references, TODOs:

```bash
mem add breadcrumb "User prefers dark mode in all UIs" -p myproject -i 8
# -i sets importance (1-10, default 5)
```

---

### Technique 4: Search

#### Full-Text Search (FTS5)

```bash
# Search all tables
mem "VPN configuration"

# Search specific table
mem "auth" -t decisions

# Filter by project
mem "error" -p infrastructure
```

FTS5 supports:
- `AND`, `OR`, `NOT` operators
- Prefix matching: `auth*`
- Exact phrases: `"vpn config"`

#### Semantic Search (Optional)

Requires Ollama with `nomic-embed-text`:

```bash
# Vector-only search
mem "how do we handle authentication" -v

# Hybrid (FTS5 + semantic with RRF fusion)
mem "authentication patterns"  # default mode
```

#### Backfilling Embeddings

```bash
# Check embedding service
mem embed stats

# Backfill LoA entries
mem embed backfill -t loa -l 100

# Backfill decisions
mem embed backfill -t decisions
```

---

### Technique 5: MCP Tools (Systematic Access)

When Claude Code runs, the MCP server exposes memory as tools.

#### context_for_agent

**MANDATORY before Task tool.** Gets relevant memory for agent context.

```
context_for_agent(
  agent_task: "Research authentication patterns",
  project: "myproject"
)
```

Returns:
- Relevant memory matches (hybrid search)
- Recent LoA entries
- Active decisions
- Recommendation on whether to call Brave search

#### memory_search

Search memory before asking the user to repeat anything.

```
memory_search(
  query: "VPN",
  project: "infrastructure",
  table: "decisions"
)
```

#### memory_recall

Get recent context at session start:

```
memory_recall(limit: 5, project: "myproject")
```

Returns recent LoA entries, decisions, and breadcrumbs.

#### memory_add

Add structured records during sessions:

```
memory_add(
  type: "decision",
  content: "Use Redis for caching",
  detail: "Better performance than in-memory",
  project: "myproject"
)
```

---

### Technique 6: TELOS Framework (Optional)

TELOS structures your AI's purpose and goals.

#### Import from LARRY.md

If you have a structured purpose document:

```bash
mem telos import --dry-run
mem telos import --yes -u  # -u updates existing entries
```

#### Query TELOS

```bash
mem telos list              # All entries
mem telos list -t goal      # Goals only
mem telos show G7           # Specific entry by code
mem telos search "memory"   # Search content
```

---

### Technique 7: Document Import (Optional)

Import standalone markdown files as searchable documents:

```bash
mem docs import --dry-run
mem docs import --yes

mem docs list
mem docs search "architecture"
mem docs show 1
```

---

## Part 3: Workflows

### Daily Workflow

1. **Session Start**: Memory is automatically available via MCP
2. **During Session**: Use `memory_search` before asking user to repeat
3. **Before Agents**: Call `context_for_agent` to enrich agent prompts
4. **Session End**: User says `/dump` → run `mem dump "Session Title"`

### Agent Spawning Workflow

```
1. User requests: "Research caching solutions"
2. You call: context_for_agent("Research caching solutions", "myproject")
3. If Brave recommended → call mcp__brave-search__brave_web_search
4. Include context in agent prompt
5. Spawn agent with: Task(prompt="...[context here]...", subagent_type="researcher")
```

### Knowledge Capture Workflow

```
1. Made an important decision? → mem add decision "..." --why "..."
2. Solved a tricky problem? → mem add learning "problem" "solution"
3. Context worth preserving? → mem add breadcrumb "..."
4. End of session? → mem dump "Session Title"
```

---

## Part 4: Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEM_DB_PATH` | `~/.claude/memory.db` | Database location |
| `OLLAMA_URL` | `http://nano:11434` | Ollama server for embeddings |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |

---

## Part 5: Backup

```bash
# With restic (recommended)
restic backup ~/.claude/memory.db --tag "lmf3"

# Simple copy
cp ~/.claude/memory.db ~/.claude/memory.db.backup

# Export to JSON (portable)
mem export > memory-export.json
```

---

## Part 6: Troubleshooting

### "Database not found"
```bash
mem init
```

### "NODE_MODULE_VERSION mismatch" / "was compiled against a different Node.js version"

This happens when:
- You copied node_modules from another machine
- You upgraded Node.js

**Fix:**
```bash
cd ~/Projects/LMF3.x
npm rebuild better-sqlite3
bun run build  # Rebuild after native module fix
```

### "Bun install fails - unzip required"
```bash
sudo apt-get install -y unzip
```

### "Fabric extraction failed"

Fabric is **OPTIONAL** - only needed for `mem loa write` and `mem dump`.
Core functionality (search, add, MCP) works without it.

If you want Fabric:
```bash
# Check Fabric project for current install method:
# https://github.com/danielmiessler/fabric

# After install:
fabric --setup
echo "test" | fabric --pattern extract_wisdom
```

### "better-sqlite3 binding issues"
After Node version changes:
```bash
npm rebuild better-sqlite3
bun run build
```

### "MCP server not connecting"
1. Check `~/.claude/.mcp.json` syntax:
```json
{
  "mcpServers": {
    "memory-larry": {
      "command": "mem-mcp",
      "args": []
    }
  }
}
```
2. Verify `mem-mcp` is in PATH: `which mem-mcp`
3. Test manually: `mem-mcp` (should hang waiting for stdin)
4. Restart Claude Code

### "Embedding service unavailable"
Embeddings are optional. Hybrid search falls back to FTS5-only.

To enable:
```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh -o /tmp/ollama.sh
bash /tmp/ollama.sh

# Pull embedding model
ollama pull nomic-embed-text

# Set URL if not localhost
export OLLAMA_URL=http://localhost:11434
```

### Fresh Install Checklist

If things aren't working, verify each step:

```bash
# 1. System deps
which node npm unzip
node --version  # Should be 18+

# 2. Bun
which bun
bun --version

# 3. LMF3 built
ls ~/Projects/LMF3.x/dist/  # Should have .js files

# 4. CLI linked
which mem mem-mcp

# 5. Database exists
ls -la ~/.claude/memory.db

# 6. Test
mem stats
```

---

## Quick Reference Card

```bash
# SEARCH
mem "query"                    # Hybrid search
mem "query" -k                 # Keyword only
mem "query" -v                 # Vector only

# CAPTURE
mem dump "title"               # Session → LoA (end of session)
mem loa write "title"          # Messages → LoA
mem add decision "X" --why "Y" # Structured decision
mem add learning "P" "S"       # Problem → Solution
mem add breadcrumb "note"      # Quick note

# VIEW
mem loa list                   # Recent LoA
mem loa show 1                 # Full Fabric extract
mem loa quote 1                # Raw messages
mem stats                      # Database stats

# IMPORT
mem import --yes               # Import sessions
mem embed backfill -t loa      # Generate embeddings
```

---

*You now have all the memory techniques. Use them consistently.*
