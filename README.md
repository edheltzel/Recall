# Larry Memory Framework 3.x (LMF3)

**Persistent memory for Claude Code.** Your AI remembers everything across sessions.

---

## Before You Start

**Verify prerequisites:**

```bash
node --version    # Need 18+ (22 recommended)
git --version     # Any recent version
curl --version    # Any recent version
```

**System requirements:**
- Ubuntu/Debian Linux (tested on 24.04)
- 500MB disk space
- sudo access for global install

---

## Quick Start

### Step 1: Install Dependencies

```bash
# Install build tools
sudo apt-get update
sudo apt-get install -y unzip build-essential git curl

# Install Node.js 22 via NodeSource
# (Ubuntu 24.04's apt nodejs/npm packages have dependency conflicts)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bun (fast JS runtime)
curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh
bash /tmp/bun-install.sh
source ~/.bashrc

# Verify
node --version   # Should show v22.x.x
bun --version    # Should show 1.x.x
```

### Step 2: Clone and Build

Clone to any directory you prefer (we'll use `$LMF3_DIR` to refer to it):

```bash
# Clone (change path if desired)
git clone https://github.com/nixfred/LMF3.git ~/Projects/LMF3
cd ~/Projects/LMF3

# Install dependencies
bun install

# Rebuild native SQLite module for your Node version
# (Required because bun and node use different module versions)
npm rebuild better-sqlite3

# Build
bun run build

# Link globally (makes `mem` and `mem-mcp` available everywhere)
sudo npm link

# Initialize database
mem init
```

**Verify:**
```bash
mem --version    # Should show 3.0.0
mem stats        # Should show "Total Records: 0"
which mem-mcp    # Should show /usr/bin/mem-mcp or /usr/local/bin/mem-mcp
```

### Step 3: Configure MCP Server

Create or update `~/.claude/.mcp.json`:

```bash
mkdir -p ~/.claude

# If you DON'T have an existing .mcp.json:
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

# If you DO have an existing .mcp.json, add this to your mcpServers object:
# "memory-larry": { "command": "mem-mcp", "args": [] }
```

**Verify MCP server works:**
```bash
echo '{}' | timeout 2 mem-mcp
# Should print: "Memory Larry MCP server running"
```

### Step 4: Configure CLAUDE.md

Create or edit `~/.claude/CLAUDE.md` and add:

```markdown
## MEMORY

You have persistent memory via LMF3. **Read the full guide:** ~/Projects/LMF3/FOR_CLAUDE.md

Core rules:
1. Before asking user to repeat anything → search first with `memory_search`
2. Before spawning agents (Task tool) → call `context_for_agent`
3. When decisions are made → record with `memory_add`
4. End of session when user says `/dump` → run `mem dump "Descriptive Title"`

Tool syntax:
- `memory_search({ query: "search terms" })`
- `memory_add({ type: "decision", content: "what", detail: "why" })`
- `context_for_agent({ task_description: "what the agent will do" })`
```

> **Note:** If `~/.claude/CLAUDE.md` doesn't exist, create it. This file contains persistent instructions for your Claude instance.

### Step 5: Restart Claude Code

Exit and restart Claude Code to load the MCP server.

**Verify:** After restart, ask Claude: "What MCP tools do you have access to?"

Claude should list `memory_search`, `memory_add`, `context_for_agent`, etc.

### Step 6: Prime Your Claude

In your first session, tell Claude:

```
Read ~/Projects/LMF3/FOR_CLAUDE.md - this is your memory system guide.
```

This teaches Claude the full workflow, patterns, and philosophy.

### Step 7: Test It

```bash
# Add a test record
mem add decision "Use LMF3 for memory" --why "Persistent context across sessions"

# Search for it
mem "LMF3"

# Should find the decision you just added
```

**Done!** Your Claude Code now has persistent memory.

---

## What You Get

| Without LMF3 | With LMF3 |
|--------------|-----------|
| Claude forgets everything between sessions | Claude remembers all conversations |
| Re-debate settled decisions every time | Instant recall of past decisions |
| Lose context constantly | Searchable knowledge base |
| Agents work blind | Agents get relevant project history |

---

## File Structure After Install

```
~/Projects/LMF3/          # (or wherever you cloned)
├── dist/                 # Built JavaScript
├── src/                  # Source TypeScript
├── FOR_CLAUDE.md         # Guide for Claude to read
└── package.json

~/.claude/
├── memory.db             # SQLite database (all memory stored here)
├── .mcp.json             # MCP server configuration
├── CLAUDE.md             # Your instructions to Claude
└── projects/             # Claude Code session files
    └── */*.jsonl         # Raw conversation logs
```

---

## Core Commands (CLI)

```bash
# Search memory
mem "your query"                    # Hybrid search (keyword + semantic)
mem "query" -k                      # Keyword only (faster)

# Add records
mem add decision "X" --why "Y"      # Record a decision with reasoning
mem add learning "problem" "fix"    # Record a problem/solution pair
mem add breadcrumb "note"           # Quick context note

# View records
mem stats                           # Database overview
mem recent decisions                # Recent decisions
mem show decisions 1                # Full details of decision #1

# Session capture (requires Fabric - see below)
mem dump "Session Title"            # Capture session + extract wisdom
```

---

## MCP Tools (For Claude)

When Claude Code runs, these tools are available via MCP:

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `memory_search` | Search past conversations, decisions, learnings | Before asking user to repeat anything |
| `memory_add` | Record decision, learning, or breadcrumb | When important decisions are made |
| `context_for_agent` | Get relevant history for agent tasks | Before EVERY Task tool call |
| `memory_recall` | Get recent entries | At session start for context |
| `memory_stats` | Database statistics | When curious about memory size |

### Critical Rule

**Before spawning any agent via Task tool, call `context_for_agent` first.**

This ensures agents have relevant history and don't duplicate past work.

---

## Session Capture with Fabric

**Fabric is required for full session capture.** Without it, you can still search and add records, but `mem dump` won't work.

### Install Fabric

```bash
# See https://github.com/danielmiessler/fabric for current install method
# After install, run setup:
fabric --setup
```

### How Session Capture Works

When user says `/dump` at session end:

1. Claude generates a descriptive title
2. Runs `mem dump "Title"`
3. LMF3 imports all conversation turns to database
4. Fabric's `extract_wisdom` pattern extracts key insights
5. Creates a Library of Alexandria (LoA) entry
6. Optionally auto-embeds for semantic search

**Without Fabric:** Use `mem dump --skip-fabric "Title"` to import messages without wisdom extraction.

---

## Optional: Semantic Search

Add vector embeddings for conceptual/semantic search:

```bash
# Install Ollama with embedding model
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text

# Backfill embeddings for existing records
mem embed backfill -t decisions
mem embed backfill -t loa
```

---

## Troubleshooting

### Error: `command not found: mem`

The npm link didn't work. Try:
```bash
cd ~/Projects/LMF3  # or wherever you cloned
sudo npm link
which mem  # Should show a path
```

### Error: `NODE_MODULE_VERSION mismatch`

```
Error: The module was compiled against a different Node.js version
```

Native SQLite module needs rebuild:
```bash
cd ~/Projects/LMF3
npm rebuild better-sqlite3
bun run build
```

### Error: MCP server not connecting

After restart, Claude doesn't see memory tools.

1. Check config exists: `cat ~/.claude/.mcp.json`
2. Check server path: `which mem-mcp`
3. Test server: `echo '{}' | timeout 2 mem-mcp`
4. Check for JSON syntax errors in `.mcp.json`
5. Fully quit and restart Claude Code (not just new session)

### Error: `Database not found`

```bash
mem init
```

### Error: `Empty content rejected`

Intentional validation - you tried to add a record with empty content.

### Error: `No session files found` (mem dump)

No Claude Code sessions exist yet, or you're not in a Claude Code project directory.

---

## Daily Workflow

**Session Start:**
- Memory is automatically available via MCP
- Claude can call `memory_recall` for recent context

**During Session:**
- Claude searches memory before asking you to repeat things
- Claude records decisions with `memory_add`
- Claude calls `context_for_agent` before spawning agents

**Session End:**
- You say `/dump` or "let's capture this session"
- Claude generates a title and runs `mem dump "Title"`
- Session wisdom is preserved for future sessions

---

## Backup

```bash
# Simple backup
cp ~/.claude/memory.db ~/.claude/memory.db.backup

# With timestamp
cp ~/.claude/memory.db ~/.claude/memory.db.$(date +%Y%m%d)
```

---

## Uninstall

```bash
# Remove global commands
sudo npm unlink -g memory-larry

# Remove database (WARNING: deletes all memory)
rm ~/.claude/memory.db

# Remove MCP config (or just delete the memory-larry entry)
rm ~/.claude/.mcp.json

# Remove source
rm -rf ~/Projects/LMF3
```

---

## Philosophy

> **Get smarter over time, not just within sessions.**

Every decision recorded = one less debate repeated.
Every learning captured = one less mistake repeated.
Every breadcrumb saved = context that survives.

This is institutional knowledge for AI.

---

## License

MIT License | Built by Larry (Claude) + Fred "Spike" Nix
