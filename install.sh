#!/bin/bash
#
# Recall Install Script
# Backs up existing files before ANY changes, supports restore
#
# Usage:
#   ./install.sh          # Install with automatic backup
#   ./install.sh restore  # Restore from most recent backup
#   ./install.sh list     # List available backups
#

set -euo pipefail

# Error trap - guide user to restore on failure
cleanup() {
    if [[ $? -ne 0 ]]; then
        echo ""
        log_error "Installation failed!"
        if [[ -n "${BACKUP_DIR:-}" ]] && [[ -d "${BACKUP_DIR:-}" ]]; then
            log_info "Your backup is safe at: $BACKUP_DIR"
            log_info "To restore: ./install.sh restore"
        fi
    fi
}
trap cleanup EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
CLAUDE_DIR="$HOME/.claude"
BACKUP_BASE="$CLAUDE_DIR/backups/recall"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$BACKUP_BASE/$TIMESTAMP"

# Detect OS once at script init (used by check_prerequisites, do_install)
case "$(uname -s)" in
    Darwin) RECALL_OS="macos" ;;
    Linux)  RECALL_OS="linux" ;;
    *)      RECALL_OS="unknown" ;;
esac

# OpenCode paths
OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_DETECTED=false
CLAUDE_CODE_DETECTED=false

# Pi paths
PI_DETECTED=false
PI_CONFIG_DIR="$HOME/.pi/agent"

# Files we might modify
FILES_TO_BACKUP=(
    "$CLAUDE_DIR/.mcp.json"
    "$HOME/.claude.json"
    "$CLAUDE_DIR/CLAUDE.md"
    "$CLAUDE_DIR/settings.json"
    "$CLAUDE_DIR/memory.db"
    "$OPENCODE_CONFIG_DIR/opencode.json"
    "$PI_CONFIG_DIR/mcp.json"
    "$PI_CONFIG_DIR/AGENTS.md"
)

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

#
# BACKUP FUNCTION
#
create_backup() {
    log_info "Creating backup at: $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"

    local backed_up=0

    for file in "${FILES_TO_BACKUP[@]}"; do
        if [[ -f "$file" ]]; then
            cp "$file" "$BACKUP_DIR/"
            log_success "Backed up: $(basename "$file")"
            backed_up=$((backed_up + 1))
        fi
    done

    # Save backup manifest
    echo "Recall Backup Manifest" > "$BACKUP_DIR/manifest.txt"
    echo "====================" >> "$BACKUP_DIR/manifest.txt"
    echo "Timestamp: $TIMESTAMP" >> "$BACKUP_DIR/manifest.txt"
    echo "Date: $(date)" >> "$BACKUP_DIR/manifest.txt"
    echo "Files backed up: $backed_up" >> "$BACKUP_DIR/manifest.txt"
    echo "" >> "$BACKUP_DIR/manifest.txt"
    echo "To restore: ./install.sh restore $TIMESTAMP" >> "$BACKUP_DIR/manifest.txt"

    if [[ $backed_up -eq 0 ]]; then
        log_warn "No existing files to backup (fresh install)"
    else
        log_success "Backup complete: $backed_up file(s) saved"
    fi

    echo "$TIMESTAMP" > "$BACKUP_BASE/latest"
}

#
# RESTORE FUNCTION
#
do_restore() {
    local target_backup="$1"

    # If no specific backup given, use latest
    if [[ -z "$target_backup" ]]; then
        if [[ -f "$BACKUP_BASE/latest" ]]; then
            target_backup=$(cat "$BACKUP_BASE/latest")
        else
            log_error "No backups found. Nothing to restore."
            exit 1
        fi
    fi

    local restore_dir="$BACKUP_BASE/$target_backup"

    if [[ ! -d "$restore_dir" ]]; then
        log_error "Backup not found: $restore_dir"
        echo ""
        echo "Available backups:"
        list_backups
        exit 1
    fi

    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║                       Recall RESTORE                       ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    log_info "Restoring from backup: $target_backup"
    echo ""

    # Show what will be restored
    echo "Files to restore:"
    ls -la "$restore_dir" | grep -v manifest.txt | tail -n +2
    echo ""

    read -p "Proceed with restore? (y/N) " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warn "Restore cancelled"
        exit 0
    fi

    # Create a backup of CURRENT state before restore (inception backup)
    log_info "Backing up current state before restore..."
    local pre_restore_dir="$BACKUP_BASE/pre_restore_$TIMESTAMP"
    mkdir -p "$pre_restore_dir"
    local pre_backed=0
    for file in "${FILES_TO_BACKUP[@]}"; do
        if [[ -f "$file" ]]; then
            cp "$file" "$pre_restore_dir/"
            pre_backed=$((pre_backed + 1))
        fi
    done
    if [[ $pre_backed -gt 0 ]]; then
        log_success "Current state saved to: pre_restore_$TIMESTAMP ($pre_backed files)"
    else
        log_warn "No current files to backup"
    fi

    # Restore files (including hidden files)
    local restored=0
    shopt -s dotglob  # Include hidden files in glob
    for file in "$restore_dir"/*; do
        if [[ ! -f "$file" ]]; then
            continue
        fi
        local filename=$(basename "$file")
        if [[ "$filename" == "manifest.txt" ]]; then
            continue
        fi

        # .claude.json lives in $HOME, not $CLAUDE_DIR
        local target
        if [[ "$filename" == ".claude.json" ]]; then
            target="$HOME/.claude.json"
        else
            target="$CLAUDE_DIR/$filename"
        fi
        cp "$file" "$target"
        log_success "Restored: $filename → $target"
        restored=$((restored + 1))
    done
    shopt -u dotglob  # Reset

    echo ""
    log_success "Restore complete: $restored file(s) restored"

    # Validate restored files
    log_info "Validating restored files..."
    local validation_ok=true

    if [[ -f "$CLAUDE_DIR/.mcp.json" ]]; then
        if MCP_FILE="$CLAUDE_DIR/.mcp.json" bun -e 'JSON.parse(require("fs").readFileSync(process.env.MCP_FILE))' 2>/dev/null; then
            log_success "Validated: .mcp.json is valid JSON"
        else
            log_error "Restored .mcp.json is NOT valid JSON!"
            log_warn "You may need to manually fix $CLAUDE_DIR/.mcp.json"
            validation_ok=false
        fi
    fi

    if [[ -f "$CLAUDE_DIR/memory.db" ]]; then
        if command -v sqlite3 &>/dev/null; then
            if sqlite3 "$CLAUDE_DIR/memory.db" "PRAGMA integrity_check;" 2>/dev/null | grep -q "ok"; then
                log_success "Validated: memory.db integrity OK"
            else
                log_warn "Could not verify memory.db integrity"
            fi
        fi
    fi

    echo ""
    log_info "If you had MCP changes, restart Claude Code to apply"
    echo ""
    echo "To undo this restore: ./install.sh restore pre_restore_$TIMESTAMP"
}

#
# LIST BACKUPS
#
list_backups() {
    if [[ ! -d "$BACKUP_BASE" ]]; then
        log_warn "No backups directory found"
        return
    fi

    echo ""
    echo "Available Recall backups:"
    echo "======================="

    for dir in "$BACKUP_BASE"/*/; do
        if [[ -d "$dir" ]]; then
            local name=$(basename "$dir")
            local file_count=$(ls -1A "$dir" 2>/dev/null | grep -v manifest.txt | wc -l)

            # Check if this is the latest
            local latest_marker=""
            if [[ -f "$BACKUP_BASE/latest" ]] && [[ "$(cat "$BACKUP_BASE/latest")" == "$name" ]]; then
                latest_marker=" (latest)"
            fi

            echo "  $name - $file_count file(s)$latest_marker"
        fi
    done

    echo ""
    echo "To restore: ./install.sh restore [TIMESTAMP]"
    echo "           (omit timestamp to restore latest)"
}

#
# CHECK PREREQUISITES
#
check_prerequisites() {
    local missing=()

    if ! command -v node &> /dev/null; then
        missing+=("node")
    fi

    if ! command -v bun &> /dev/null; then
        missing+=("bun")
    fi

    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing prerequisites: ${missing[*]}"
        echo ""
        if [[ "$RECALL_OS" == "macos" ]]; then
            echo "Install on macOS:"
            for dep in "${missing[@]}"; do
                case "$dep" in
                    node|npm) echo "  brew install node" ;;
                    bun) echo "  brew install oven-sh/bun/bun" ;;
                esac
            done
        elif [[ "$RECALL_OS" == "linux" ]]; then
            echo "Install on Linux:"
            for dep in "${missing[@]}"; do
                case "$dep" in
                    node|npm) echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" ;;
                    bun) echo "  curl -fsSL https://bun.sh/install | bash && source ~/.bashrc" ;;
                esac
            done
        else
            echo "Please install the missing tools first. See README.md."
        fi
        exit 1
    fi

    log_success "Prerequisites OK (node, bun, npm) on $RECALL_OS"

    # Warn if cloned to a temporary directory (bun link will break on reboot)
    local install_dir="$(pwd)"
    if [[ "$install_dir" == /tmp/* ]] || [[ "$install_dir" == /var/tmp/* ]]; then
        echo ""
        log_warn "Recall is in a temporary directory ($install_dir)!"
        log_warn "bun link creates symlinks back here — if this directory"
        log_warn "is cleaned (e.g. on reboot), 'mem' commands will break."
        log_warn "Recommended: clone to a permanent directory instead."
        echo ""
    fi

    # Verify claude CLI is available (used for session extraction)
    if ! command -v claude &> /dev/null; then
        echo ""
        log_warn "Claude Code CLI not found."
        log_warn "Session extraction uses 'claude -p' for parsing conversations."
        if [[ "$RECALL_OS" == "macos" ]]; then
            log_warn "Install it: npm install -g @anthropic-ai/claude-code"
        else
            log_warn "Install it: sudo npm install -g @anthropic-ai/claude-code"
        fi
        echo ""
    fi
}

#
# CONFIGURE MCP
#
configure_mcp() {
    local mem_mcp_path
    mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"

    mkdir -p "$CLAUDE_DIR"

    # Check if already registered via claude mcp list
    if command -v claude &> /dev/null; then
        if claude mcp list 2>/dev/null | grep -q "recall-memory"; then
            log_success "MCP already configured for recall-memory"
            return
        fi

        # Register via Claude Code CLI (user scope = available in all projects)
        log_info "Registering recall-memory MCP server..."
        if claude mcp add --transport stdio --scope user recall-memory -- "$mem_mcp_path" 2>/dev/null; then
            log_success "Registered recall-memory MCP server via Claude Code CLI"
        else
            log_warn "claude mcp add failed — adding to settings.json directly"
            _write_mcp_settings "$mem_mcp_path"
        fi
    else
        # Claude Code not installed yet — write to settings.json (user scope) as fallback
        log_warn "Claude Code CLI not found — adding recall-memory to settings.json directly"
        _write_mcp_settings "$mem_mcp_path"
    fi
}

_write_mcp_settings() {
    local mem_mcp_path="$1"
    local settings_file="$CLAUDE_DIR/settings.json"

    # Check if already registered
    if [[ -f "$settings_file" ]] && grep -q "recall-memory" "$settings_file"; then
        log_success "recall-memory already in settings.json"
        return
    fi

    # Merge into existing settings.json (or create new) using bun — no shell interpolation
    SETTINGS_FILE="$settings_file" MCP_PATH="$mem_mcp_path" bun -e '
        const fs = require("fs");
        let config = {};
        try { config = JSON.parse(fs.readFileSync(process.env.SETTINGS_FILE, "utf8")); } catch {}
        config.mcpServers = config.mcpServers || {};
        config.mcpServers["recall-memory"] = { command: process.env.MCP_PATH, args: [] };
        fs.writeFileSync(process.env.SETTINGS_FILE, JSON.stringify(config, null, 2));
    '
    log_success "Added recall-memory to settings.json mcpServers"
}

#
# CONFIGURE HOOKS
#
configure_hooks() {
    local hooks_dir="$CLAUDE_DIR/hooks"
    local settings_file="$CLAUDE_DIR/settings.json"
    local src_dir="$(pwd)/hooks"

    mkdir -p "$hooks_dir"

    # Copy hook files
    if [[ -f "$src_dir/SessionExtract.ts" ]]; then
        cp "$src_dir/SessionExtract.ts" "$hooks_dir/SessionExtract.ts"
        log_success "Copied SessionExtract.ts to $hooks_dir"
    else
        log_warn "SessionExtract.ts not found in $src_dir — skipping hook setup"
        return
    fi

    if [[ -f "$src_dir/BatchExtract.ts" ]]; then
        cp "$src_dir/BatchExtract.ts" "$hooks_dir/BatchExtract.ts"
        log_success "Copied BatchExtract.ts to $hooks_dir"
    fi

    # Copy extraction prompt template
    local memory_dir="$CLAUDE_DIR/MEMORY"
    mkdir -p "$memory_dir"
    if [[ -f "$src_dir/extract_prompt.md" ]]; then
        cp "$src_dir/extract_prompt.md" "$memory_dir/extract_prompt.md"
        log_success "Copied extraction prompt template to $memory_dir"
    fi

    # Register hook in settings.json
    if [[ -f "$settings_file" ]]; then
        if grep -q "SessionExtract" "$settings_file"; then
            log_success "SessionExtract hook already registered in settings.json"
            return
        fi
    fi

    # Build hook command — resolve bun path dynamically
    local bun_path
    bun_path="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
    local hook_cmd="$bun_path run $hooks_dir/SessionExtract.ts"

    # Merge or create settings.json using bun with env vars (no shell interpolation in JS)
    SETTINGS_FILE="$settings_file" HOOK_CMD="$hook_cmd" bun -e '
        const fs = require("fs");
        const settingsFile = process.env.SETTINGS_FILE;
        const hookCmd = process.env.HOOK_CMD;
        let config = {};
        try { config = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch {}
        config.hooks = config.hooks || {};
        config.hooks.Stop = config.hooks.Stop || [];
        const exists = config.hooks.Stop.some(e =>
            e.hooks && e.hooks.some(h => h.command && h.command.includes("SessionExtract"))
        );
        if (!exists) {
            config.hooks.Stop.push({
                matcher: "",
                hooks: [{ type: "command", command: hookCmd }]
            });
        }
        fs.writeFileSync(settingsFile, JSON.stringify(config, null, 2));
    '
    log_success "Registered SessionExtract hook in settings.json"
}

#
# CONFIGURE CLAUDE.md
#
configure_claude_md() {
    local claude_md="$CLAUDE_DIR/CLAUDE.md"
    local recall_dir="$(pwd)"

    local memory_section="## MEMORY

You have persistent memory via Recall. **Read the full guide:** $CLAUDE_DIR/Recall_GUIDE.md

Core rules:
1. Before asking user to repeat anything → search first with \`memory_search\`
2. Before spawning agents (Task tool) → call \`context_for_agent\`
3. When decisions are made → record with \`memory_add\`
4. End of session when user says \`/dump\` → run \`mem dump \"Descriptive Title\"\`

Tool syntax:
- \`memory_search({ query: \"search terms\" })\`
- \`memory_add({ type: \"decision\", content: \"what\", detail: \"why\" })\`
- \`context_for_agent({ task_description: \"what the agent will do\" })\`"

    if [[ -f "$claude_md" ]]; then
        # Check if MEMORY section already exists
        if grep -q "## MEMORY" "$claude_md"; then
            log_success "CLAUDE.md already has MEMORY section"
            return
        fi

        # Append to existing file
        echo "" >> "$claude_md"
        echo "$memory_section" >> "$claude_md"
        log_success "Added MEMORY section to existing CLAUDE.md"
    else
        # Create new file
        echo "$memory_section" > "$claude_md"
        log_success "Created CLAUDE.md with MEMORY section"
    fi
}

#
# DETECT PLATFORMS
#
detect_platforms() {
    if [[ -d "$HOME/.claude" ]] || command -v claude &>/dev/null; then
        CLAUDE_CODE_DETECTED=true
        log_success "Detected: Claude Code"
    fi

    if command -v opencode &>/dev/null; then
        OPENCODE_DETECTED=true
        log_success "Detected: OpenCode"
    fi

    if command -v pi &>/dev/null; then
        PI_DETECTED=true
        log_success "Detected: Pi"
    fi

    if [[ "$CLAUDE_CODE_DETECTED" == "false" ]] && [[ "$OPENCODE_DETECTED" == "false" ]] && [[ "$PI_DETECTED" == "false" ]]; then
        log_warn "No coding agents detected (Claude Code, OpenCode, Pi)"
        log_info "Recall will install core tools. Configure MCP manually later."
    fi
}

#
# CONFIGURE OPENCODE MCP
#
configure_opencode_mcp() {
    local config="$OPENCODE_CONFIG_DIR/opencode.json"
    local mem_mcp_path bun_path
    mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"
    bun_path="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

    # Resolve absolute DB path (no tilde — env vars don't expand ~)
    local db_path_abs
    db_path_abs="$(eval echo "${MEM_DB_PATH:-$HOME/.claude/memory.db}")"

    mkdir -p "$OPENCODE_CONFIG_DIR"

    # Check if already registered
    if [[ -f "$config" ]] && grep -q "recall-memory" "$config"; then
        log_success "recall-memory already registered in opencode.json"
        return
    fi

    # JSONC-safe merge: strip comments before parsing
    INSTALL_MCP_PATH="$mem_mcp_path" \
    BUN_PATH="$bun_path" \
    DB_PATH_ABS="$db_path_abs" \
    CONFIG_PATH="$config" \
    bun -e '
        const fs = require("fs");
        const path = process.env.CONFIG_PATH;

        let raw = "{}";
        if (fs.existsSync(path)) {
            raw = fs.readFileSync(path, "utf-8")
                .replace(/\/\/.*$/gm, "")
                .replace(/\/\*[\s\S]*?\*\//g, "");
        }

        const existing = JSON.parse(raw);
        existing.mcp = existing.mcp || {};
        existing.mcp["recall-memory"] = {
            type: "local",
            command: [process.env.BUN_PATH, "run", process.env.INSTALL_MCP_PATH],
            enabled: true,
            environment: {
                MEM_DB_PATH: process.env.DB_PATH_ABS
            }
        };
        fs.writeFileSync(path, JSON.stringify(existing, null, 2));
    '
    log_success "Registered recall-memory MCP server in opencode.json"
}

#
# INSTALL OPENCODE PLUGINS
#
install_opencode_plugins() {
    local plugin_dir="$OPENCODE_CONFIG_DIR/plugins"
    local src_dir="$(pwd)/opencode"

    mkdir -p "$plugin_dir"

    if [[ -f "$src_dir/recall-extract.ts" ]]; then
        cp "$src_dir/recall-extract.ts" "$plugin_dir/"
        log_success "Installed recall-extract.ts plugin"
    fi

    if [[ -f "$src_dir/recall-compaction.ts" ]]; then
        cp "$src_dir/recall-compaction.ts" "$plugin_dir/"
        log_success "Installed recall-compaction.ts plugin"
    fi
}

#
# INSTALL OPENCODE AGENT
#
install_opencode_agent() {
    local agent_dir="$OPENCODE_CONFIG_DIR/agents"
    local src_dir="$(pwd)/opencode"

    mkdir -p "$agent_dir"

    if [[ -f "$src_dir/recall-memory.md" ]]; then
        cp "$src_dir/recall-memory.md" "$agent_dir/"
        log_success "Installed recall-memory agent definition"
    fi
}

#
# INSTALL OPENCODE GUIDE
#
install_opencode_guide() {
    if [[ -f "$(pwd)/FOR_OPENCODE.md" ]]; then
        cp "$(pwd)/FOR_OPENCODE.md" "$OPENCODE_CONFIG_DIR/Recall_GUIDE.md"
        log_success "Installed Recall guide for OpenCode"
    fi
}

#
# INSTALL PI MCP ADAPTER
#
install_pi_adapter() {
    log_info "Ensuring pi-mcp-adapter is installed..."
    if pi install npm:pi-mcp-adapter 2>/dev/null; then
        log_success "pi-mcp-adapter ready"
    else
        log_warn "Could not install pi-mcp-adapter automatically"
        log_warn "Install manually: pi install npm:pi-mcp-adapter"
    fi
}

#
# CONFIGURE PI MCP
#
configure_pi_mcp() {
    local config="$PI_CONFIG_DIR/mcp.json"
    local db_path_abs
    db_path_abs="$(eval echo "${MEM_DB_PATH:-$HOME/.claude/memory.db}")"
    local mem_mcp_path
    mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"

    mkdir -p "$PI_CONFIG_DIR"

    # Check if already registered
    if [[ -f "$config" ]] && grep -q "recall-memory" "$config"; then
        log_success "recall-memory already registered in Pi mcp.json"
        return
    fi

    # JSONC-safe merge (same pattern as OpenCode)
    MCP_CONFIG_PATH="$config" \
    DB_PATH_ABS="$db_path_abs" \
    MEM_MCP_PATH="$mem_mcp_path" \
    bun -e '
        const fs = require("fs");
        const path = process.env.MCP_CONFIG_PATH;

        let raw = "{}";
        if (fs.existsSync(path)) {
            raw = fs.readFileSync(path, "utf-8")
                .replace(/\/\/.*$/gm, "")
                .replace(/\/\*[\s\S]*?\*\//g, "");
        }

        const existing = JSON.parse(raw);
        existing.mcpServers = existing.mcpServers || {};
        existing.mcpServers["recall-memory"] = {
            command: process.env.MEM_MCP_PATH,
            args: [],
            lifecycle: "lazy",
            environment: {
                MEM_DB_PATH: process.env.DB_PATH_ABS
            }
        };
        fs.writeFileSync(path, JSON.stringify(existing, null, 2));
    '
    log_success "Registered recall-memory in Pi mcp.json"
}

#
# INSTALL PI EXTENSIONS
#
install_pi_extensions() {
    local ext_dir="$PI_CONFIG_DIR/extensions"
    local src_dir="$(pwd)/pi"

    mkdir -p "$ext_dir"

    if [[ -f "$src_dir/recall-extract.ts" ]]; then
        cp "$src_dir/recall-extract.ts" "$ext_dir/"
        log_success "Installed recall-extract.ts Pi extension"
    fi

    if [[ -f "$src_dir/recall-compaction.ts" ]]; then
        cp "$src_dir/recall-compaction.ts" "$ext_dir/"
        log_success "Installed recall-compaction.ts Pi extension"
    fi
}

#
# INSTALL PI GUIDE + AGENTS.MD
#
install_pi_guide() {
    mkdir -p "$PI_CONFIG_DIR"

    # Copy guide
    if [[ -f "$(pwd)/FOR_PI.md" ]]; then
        cp "$(pwd)/FOR_PI.md" "$PI_CONFIG_DIR/Recall_GUIDE.md"
        log_success "Installed Recall guide for Pi"
    fi

    # Append MEMORY section to AGENTS.md (Pi auto-loads this file)
    local agents_md="$PI_CONFIG_DIR/AGENTS.md"

    if [[ -f "$agents_md" ]] && grep -q "## MEMORY" "$agents_md"; then
        log_success "AGENTS.md already has MEMORY section"
        return
    fi

    local memory_section="
## MEMORY

You have persistent memory via Recall. **Read the full guide:** ~/.pi/agent/Recall_GUIDE.md

Core rules:
1. Before asking user to repeat anything → search first with \`recall-memory_memory_search\`
2. When decisions are made → record with \`recall-memory_memory_add\`
3. End of session when user says \`/dump\` → run \`mem dump \"Descriptive Title\"\`

Tool syntax:
- \`recall-memory_memory_search({ query: \"search terms\" })\`
- \`recall-memory_memory_add({ type: \"decision\", content: \"what\", detail: \"why\" })\`
- \`recall-memory_context_for_agent({ task_description: \"what the agent will do\" })\`"

    # Ensure trailing newline before appending
    if [[ -f "$agents_md" ]] && [[ -s "$agents_md" ]] && [[ "$(tail -c 1 "$agents_md" | wc -l)" -eq 0 ]]; then
        echo "" >> "$agents_md"
    fi
    echo "$memory_section" >> "$agents_md"
    log_success "Added MEMORY section to AGENTS.md"
}

#
# MAIN INSTALL
#
do_install() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║                      Recall INSTALLER                      ║"
    echo "║      RECALL - Persistent Memory for Coding Agents           ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""

    # Step 0: Check prerequisites and detect platforms
    log_info "Checking prerequisites..."
    check_prerequisites
    echo ""
    log_info "Detecting platforms..."
    detect_platforms
    echo ""

    # Step 1: BACKUP FIRST (before touching anything)
    log_info "Step 1: Creating backup of existing files..."
    create_backup
    echo ""

    # Step 2: Install dependencies
    log_info "Step 2: Installing dependencies..."
    if ! bun install; then
        log_error "Failed to install dependencies"
        log_info "Try running: bun install (manually to see errors)"
        exit 1
    fi
    log_success "Dependencies installed"
    echo ""

    # Step 3: Build
    log_info "Step 3: Building..."
    if ! bun run build; then
        log_error "Build failed"
        log_info "Try running: bun run build (manually to see errors)"
        exit 1
    fi
    log_success "Build complete"
    echo ""

    # Step 4: Link globally
    log_info "Step 4: Linking globally..."
    if ! bun link; then
        log_warn "bun link failed, trying npm link..."
        local npm_link_ok=false
        if [[ "$RECALL_OS" == "linux" ]]; then
            sudo npm link && npm_link_ok=true
        else
            npm link && npm_link_ok=true
        fi
        if [[ "$npm_link_ok" != "true" ]]; then
            log_error "Failed to link globally"
            [[ "$RECALL_OS" != "linux" ]] && log_info "On macOS, try: sudo npm link"
            exit 1
        fi
    fi
    log_success "Linked: mem and mem-mcp now available globally"
    echo ""

    # Step 5: Initialize database and MEMORY directory
    log_info "Step 5: Initializing database..."
    mkdir -p "$CLAUDE_DIR/MEMORY"
    # Use absolute path — bun link may not be in PATH yet for this shell session
    local mem_bin="$HOME/.bun/bin/mem"
    if [[ ! -x "$mem_bin" ]]; then
        mem_bin="$(which mem 2>/dev/null || echo "")"
    fi
    if [[ -z "$mem_bin" ]]; then
        log_error "mem binary not found after linking. Check that ~/.bun/bin is in your PATH."
        exit 1
    fi
    "$mem_bin" init
    log_success "MEMORY directory created at $CLAUDE_DIR/MEMORY"
    echo ""

    # Step 6: Configure MCP
    log_info "Step 6: Configuring MCP server..."
    configure_mcp
    echo ""

    # Step 7: Configure session extraction hooks
    log_info "Step 7: Setting up session extraction hooks..."
    configure_hooks
    echo ""

    # Step 8: Copy FOR_CLAUDE.md guide to stable location
    log_info "Step 8: Installing Claude guide..."
    cp "$(pwd)/FOR_CLAUDE.md" "$CLAUDE_DIR/Recall_GUIDE.md"
    log_success "Installed Recall guide at $CLAUDE_DIR/Recall_GUIDE.md"
    echo ""

    # Step 9: Configure CLAUDE.md
    log_info "Step 9: Configuring CLAUDE.md..."
    configure_claude_md
    echo ""

    # Step 10: Configure OpenCode (if detected)
    if [[ "$OPENCODE_DETECTED" == "true" ]]; then
        echo ""
        log_info "Step 10: Configuring OpenCode integration..."
        configure_opencode_mcp
        install_opencode_plugins
        install_opencode_agent
        install_opencode_guide
        echo ""
    fi

    # Step 11: Configure Pi (if detected)
    if [[ "$PI_DETECTED" == "true" ]]; then
        echo ""
        log_info "Step 11: Configuring Pi integration..."
        install_pi_adapter
        configure_pi_mcp
        install_pi_extensions
        install_pi_guide
        echo ""
    fi

    # Done!
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║                  INSTALLATION COMPLETE                   ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    log_success "Recall installed successfully!"
    echo ""
    echo "Backup location: $BACKUP_DIR"
    echo "To restore:      ./install.sh restore"
    echo ""
    echo "Platforms configured:"
    if [[ "$CLAUDE_CODE_DETECTED" == "true" ]]; then
        echo "  ✓ Claude Code (MCP + hooks + CLAUDE.md)"
    fi
    if [[ "$OPENCODE_DETECTED" == "true" ]]; then
        echo "  ✓ OpenCode (MCP + plugins + agent)"
    fi
    if [[ "$PI_DETECTED" == "true" ]]; then
        echo "  ✓ Pi (MCP via adapter + extensions + AGENTS.md)"
    fi
    echo ""
    echo "Next steps:"
    local step=1
    if [[ "$CLAUDE_CODE_DETECTED" == "true" ]]; then
        echo "  $step. Restart Claude Code to load MCP server and hooks"
        step=$((step + 1))
    fi
    if [[ "$OPENCODE_DETECTED" == "true" ]]; then
        echo "  $step. Restart OpenCode to load MCP server and plugins"
        step=$((step + 1))
    fi
    if [[ "$PI_DETECTED" == "true" ]]; then
        echo "  $step. Restart Pi to load MCP adapter and extensions"
        step=$((step + 1))
    fi
    echo "  $step. Test: mem stats"
    step=$((step + 1))
    echo "  $step. (Optional) Install Fabric for richer session extraction:"
    echo "     https://github.com/danielmiessler/fabric"
    step=$((step + 1))
    echo "  $step. (Optional) Set up cron for batch extraction of missed sessions:"
    echo "     */30 * * * * $HOME/.bun/bin/bun run $CLAUDE_DIR/hooks/BatchExtract.ts --limit 20 >> /tmp/recall-batch.log 2>&1"
    echo ""
}

#
# MAIN
#
case "${1:-}" in
    restore)
        do_restore "${2:-}"
        ;;
    list)
        list_backups
        ;;
    help|--help|-h)
        echo "Recall Install Script"
        echo ""
        echo "Usage:"
        echo "  ./install.sh          Install Recall (creates backup first)"
        echo "  ./install.sh restore  Restore from most recent backup"
        echo "  ./install.sh restore TIMESTAMP  Restore specific backup"
        echo "  ./install.sh list     List available backups"
        echo "  ./install.sh help     Show this help"
        ;;
    *)
        do_install
        ;;
esac
