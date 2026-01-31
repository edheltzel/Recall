# LMF3 Quickstart (5 Minutes)

Get persistent memory running in 5 minutes.

---

## Prerequisites

- Ubuntu/Debian Linux (tested on Ubuntu 24.04)
- User with sudo access (passwordless sudo recommended)
- Internet connection for package downloads

---

## 1. System Prerequisites

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y nodejs npm unzip build-essential

# Install Bun
curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh
bash /tmp/bun-install.sh
source ~/.bashrc
```

## 2. Install LMF3 (2 min)

```bash
# Clone or download LMF3
cd ~/Projects/LMF3.x

# Install and build
bun install && bun run build

# IMPORTANT: If copied from another machine, rebuild native modules:
npm rebuild better-sqlite3 && bun run build

# Link globally
sudo npm link

# Initialize database
mem init
```

## 3. Configure MCP (1 min)

Create `~/.claude/.mcp.json`:

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

## 4. Install Claude Code (if not installed)

```bash
sudo npm install -g @anthropic-ai/claude-code
```

## 5. (Optional) Install Fabric

Fabric is only needed for `mem dump` and `mem loa write` commands.
Core memory features work without it.

```bash
# See https://github.com/danielmiessler/fabric for current install method
# After install:
fabric --setup
```

## 6. Add to CLAUDE.md (1 min)

Add to `~/.claude/CLAUDE.md`:

```markdown
## MEMORY

Before asking user to repeat: search first with `memory_search`.
Before spawning agents: call `context_for_agent`.
End of session: run `mem dump "Session Title"`.
```

---

## Done! Try it:

```bash
# Search your memory
mem "test query"

# Check stats
mem stats

# End of session capture
mem dump "First Test Session"
```

---

## Daily Use

| Action | Command |
|--------|---------|
| Search | `mem "query"` |
| End session | `mem dump "title"` |
| Add decision | `mem add decision "X" --why "Y"` |
| View recent | `mem loa list` |

See `SETUP.md` for complete guide.
