# Larry Memory Framework 3.x (LMF3)

**Persistent memory for Claude Code.** Your AI remembers everything across sessions.

---

## Quick Start (5 minutes)

### 1. System Requirements

```bash
# Ubuntu/Debian - install build tools
sudo apt-get update
sudo apt-get install -y unzip build-essential git curl

# Install Node.js 22 via NodeSource (Ubuntu 24.04's npm package is broken)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bun
curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh
bash /tmp/bun-install.sh
source ~/.bashrc
```

### 2. Install LMF3

```bash
git clone https://github.com/nixfred/LMF3.git ~/Projects/LMF3
cd ~/Projects/LMF3

# Install dependencies
bun install

# IMPORTANT: Rebuild native modules for your Node version
npm rebuild better-sqlite3

# Build
bun run build

# Link globally
sudo npm link

# Initialize database
mem init
```

### 3. Configure MCP

```bash
mkdir -p ~/.claude
cat > ~/.claude/.mcp.json << 'EOF'
{
  "mcpServers": {
    "memory-larry": {
      "command": "mem-mcp",
      "args": []
    }
  }
}
EOF
```

> **Note:** If you already have `.mcp.json`, merge the `memory-larry` entry into your existing `mcpServers` object.

### 4. Add to CLAUDE.md

Add these instructions to `~/.claude/CLAUDE.md` so Claude knows to use memory:

```markdown
## MEMORY

Before asking user to repeat anything: search first with `memory_search`.
Before spawning agents (Task tool): call `context_for_agent`.
When decisions are made: record with `memory_add`.
End of session: user says `/dump` → run `mem dump "Session Title"`.
```

### 5. Verify

```bash
mem --version          # Should show 3.0.0
mem stats              # Should show empty database
mem add decision "Test" --why "Testing"
mem "Test"             # Should find the decision
```

### 6. Restart Claude Code

Restart Claude Code to load the MCP server. You should see `memory-larry` in the MCP servers list.

**Done.** Your Claude Code now has persistent memory.

---

## What This Does

| Without LMF3 | With LMF3 |
|--------------|-----------|
| Forget everything between sessions | Remember all conversations |
| Re-debate settled decisions | Recall past decisions instantly |
| Lose context constantly | Searchable knowledge base |
| Agents work blind | Agents get relevant history |

---

## Core Commands

```bash
# Search memory
mem "your query"                    # Hybrid search
mem "query" -k                      # Keyword only (faster)

# Add records
mem add decision "X" --why "Y"      # Record a decision
mem add learning "problem" "fix"    # Record a solution
mem add breadcrumb "note"           # Quick context note

# View
mem stats                           # Database overview
mem recent decisions                # Recent decisions
mem show decisions 1                # Full details

# Session capture (requires Fabric)
mem dump "Session Title"            # Capture + extract wisdom
```

---

## MCP Tools

When Claude Code runs, these tools are available:

| Tool | Purpose |
|------|---------|
| `memory_search` | Search before asking user to repeat |
| `memory_add` | Add decision/learning/breadcrumb |
| `context_for_agent` | Get context before spawning agents |
| `memory_recall` | Recent entries at session start |
| `memory_stats` | Database statistics |

### Critical Rule

**Before spawning any agent via Task tool, call `context_for_agent` first.**

This ensures agents have relevant history and don't duplicate past work.

---

## Architecture

```
~/.claude/
├── memory.db          # SQLite database (all memory here)
├── .mcp.json          # MCP server config
└── projects/          # Claude Code session files
    └── */*.jsonl      # Raw conversation logs
```

### Database Tables

| Table | Stores |
|-------|--------|
| `messages` | Every conversation turn |
| `decisions` | Decisions with reasoning |
| `learnings` | Problems solved |
| `breadcrumbs` | Context notes |
| `loa_entries` | Curated knowledge (Fabric extracts) |
| `sessions` | Session metadata |

All tables have FTS5 full-text search indexes.

---

## Optional: Fabric Integration

[Fabric](https://github.com/danielmiessler/fabric) extracts wisdom from conversations. Required for `mem dump` and `mem loa write`.

```bash
# See Fabric repo for current install method
fabric --setup
```

Without Fabric, core features (search, add, MCP) still work.

---

## Optional: Semantic Search

Add vector embeddings for conceptual search:

```bash
# Install Ollama with embedding model
ollama pull nomic-embed-text

# Set URL (if not localhost)
export OLLAMA_URL=http://localhost:11434

# Backfill embeddings
mem embed backfill -t loa
mem embed backfill -t decisions
```

---

## Troubleshooting

### "Database not found"
```bash
mem init
```

### "NODE_MODULE_VERSION mismatch"
Native SQLite module compiled for different Node version. Re-run:
```bash
cd ~/Projects/LMF3
npm rebuild better-sqlite3
bun run build
```

### "MCP server not connecting"
1. Check config: `cat ~/.claude/.mcp.json`
2. Verify path: `which mem-mcp`
3. Test manually: `echo '{}' | timeout 1 mem-mcp`
4. Restart Claude Code

### Empty content rejected
Intentional validation. Provide non-empty content.

---

## Daily Workflow

**During session:**
- Use `memory_search` before asking user to repeat anything
- Use `memory_add` when decisions are made
- Use `context_for_agent` before spawning agents

**End of session:**
- User says `/dump`
- Run `mem dump "Descriptive Title"`

---

## Backup

```bash
cp ~/.claude/memory.db ~/.claude/memory.db.backup
```

---

## Philosophy

> **Get smarter over time, not just within sessions.**

Every decision recorded = one less debate repeated.
Every learning captured = one less mistake repeated.
Every breadcrumb saved = context that survives.

This is institutional knowledge for AI.

---

MIT License | Built by Larry + Fred
