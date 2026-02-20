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
# Ubuntu/Debian - install build tools
sudo apt-get update
sudo apt-get install -y unzip build-essential git curl

# Install Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bun
curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh
bash /tmp/bun-install.sh
source ~/.bashrc
```

## 2. Install Claude Code (if not installed)

```bash
sudo npm install -g @anthropic-ai/claude-code
```

## 3. Set Anthropic API Key

The extraction hook needs an API key to parse sessions:

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

Get yours at: https://console.anthropic.com/settings/keys

## 4. Install LMF3

```bash
git clone https://github.com/nixfred/LMF3.git ~/Projects/LMF3
cd ~/Projects/LMF3
./install.sh
```

The installer handles everything: dependencies, build, database, MCP config, CLAUDE.md, and session extraction hooks.

## 5. Restart Claude Code

```bash
# Restart Claude Code to load the MCP server and hooks
```

## 6. (Optional) Install Fabric

Fabric provides richer session analysis. Core memory works without it.

```bash
# See https://github.com/danielmiessler/fabric for current install method
# After install:
fabric --setup
```

---

## Done! Try it:

```bash
# Check stats
mem stats

# Search your memory
mem search "test query"

# End of session capture
mem dump "First Test Session"
```

---

## Daily Use

| Action | Command |
|--------|---------|
| Search | `mem search "query"` or `mem "query"` |
| End session | `mem dump "title"` |
| Add decision | `mem add decision "X" --why "Y"` |
| View recent | `mem loa list` |

See `SETUP.md` for the complete guide with all memory techniques.
