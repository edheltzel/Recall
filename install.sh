#!/bin/bash
#
# LMF3 Install Script
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
BACKUP_BASE="$CLAUDE_DIR/backups/lmf3"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$BACKUP_BASE/$TIMESTAMP"

# Files we might modify
FILES_TO_BACKUP=(
    "$CLAUDE_DIR/.mcp.json"
    "$CLAUDE_DIR/CLAUDE.md"
    "$CLAUDE_DIR/settings.json"
    "$CLAUDE_DIR/memory.db"
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
    echo "LMF3 Backup Manifest" > "$BACKUP_DIR/manifest.txt"
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
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    LMF3 RESTORE                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
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

        local target="$CLAUDE_DIR/$filename"
        cp "$file" "$target"
        log_success "Restored: $filename"
        restored=$((restored + 1))
    done
    shopt -u dotglob  # Reset

    echo ""
    log_success "Restore complete: $restored file(s) restored"

    # Validate restored files
    log_info "Validating restored files..."
    local validation_ok=true

    if [[ -f "$CLAUDE_DIR/.mcp.json" ]]; then
        if node -e "JSON.parse(require('fs').readFileSync('$CLAUDE_DIR/.mcp.json'))" 2>/dev/null; then
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
    echo "Available LMF3 backups:"
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
        echo "Please install the missing tools first. See README.md Step 1."
        exit 1
    fi

    log_success "Prerequisites OK (node, bun, npm)"
}

#
# CONFIGURE MCP
#
configure_mcp() {
    local mcp_file="$CLAUDE_DIR/.mcp.json"
    local mem_mcp_path="$HOME/.bun/bin/mem-mcp"

    mkdir -p "$CLAUDE_DIR"

    if [[ -f "$mcp_file" ]]; then
        # Check if lmf-memory already configured
        if grep -q "lmf-memory" "$mcp_file"; then
            log_success "MCP already configured for lmf-memory"
            return
        fi

        # Need to merge into existing config
        log_info "Merging lmf-memory into existing MCP config..."

        # Use node to safely merge JSON (full path for reliability)
        node -e "
            const fs = require('fs');
            const config = JSON.parse(fs.readFileSync('$mcp_file', 'utf8'));
            config.mcpServers = config.mcpServers || {};
            config.mcpServers['lmf-memory'] = { command: '$mem_mcp_path', args: [] };
            fs.writeFileSync('$mcp_file', JSON.stringify(config, null, 2));
        "
        log_success "Merged lmf-memory into existing MCP config"
    else
        # Create fresh config (use full path so MCP works regardless of PATH)
        cat > "$mcp_file" << MCPEOF
{
  "mcpServers": {
    "lmf-memory": {
      "command": "$mem_mcp_path",
      "args": []
    }
  }
}
MCPEOF
        log_success "Created MCP config"
    fi
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

    # Register hook in settings.json
    if [[ -f "$settings_file" ]]; then
        if grep -q "SessionExtract" "$settings_file"; then
            log_success "SessionExtract hook already registered in settings.json"
            return
        fi
    fi

    # Create or merge settings.json with hook registration
    local bun_path="$HOME/.bun/bin/bun"
    local hook_cmd="$bun_path run $hooks_dir/SessionExtract.ts"

    if [[ -f "$settings_file" ]]; then
        # Merge into existing settings using node
        node -e "
            const fs = require('fs');
            const config = JSON.parse(fs.readFileSync('$settings_file', 'utf8'));
            config.hooks = config.hooks || {};
            config.hooks.Stop = config.hooks.Stop || [];
            const exists = config.hooks.Stop.some(e =>
                e.hooks && e.hooks.some(h => h.command && h.command.includes('SessionExtract'))
            );
            if (!exists) {
                config.hooks.Stop.push({
                    matcher: '',
                    hooks: [{ type: 'command', command: '$hook_cmd' }]
                });
            }
            fs.writeFileSync('$settings_file', JSON.stringify(config, null, 2));
        "
        log_success "Registered SessionExtract hook in existing settings.json"
    else
        # Create new settings.json
        cat > "$settings_file" << HOOKEOF
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$hook_cmd"
          }
        ]
      }
    ]
  }
}
HOOKEOF
        log_success "Created settings.json with SessionExtract hook"
    fi
}

#
# CONFIGURE CLAUDE.md
#
configure_claude_md() {
    local claude_md="$CLAUDE_DIR/CLAUDE.md"
    local lmf3_dir="$(pwd)"

    local memory_section="## MEMORY

You have persistent memory via LMF3. **Read the full guide:** $CLAUDE_DIR/LMF3_GUIDE.md

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
# MAIN INSTALL
#
do_install() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    LMF3 INSTALLER                            ║"
    echo "║         LMF - Persistent Memory for Claude Code               ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    # Step 0: Check prerequisites
    log_info "Checking prerequisites..."
    check_prerequisites
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
        log_warn "bun link failed, trying npm link (may need sudo)..."
        if ! sudo npm link; then
            log_error "Failed to link globally"
            exit 1
        fi
    fi
    log_success "Linked: mem and mem-mcp now available globally"
    echo ""

    # Step 5: Initialize database and MEMORY directory
    log_info "Step 5: Initializing database..."
    mkdir -p "$CLAUDE_DIR/MEMORY"
    mem init
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
    cp "$(pwd)/FOR_CLAUDE.md" "$CLAUDE_DIR/LMF3_GUIDE.md"
    log_success "Installed LMF3 guide at $CLAUDE_DIR/LMF3_GUIDE.md"
    echo ""

    # Step 9: Configure CLAUDE.md
    log_info "Step 9: Configuring CLAUDE.md..."
    configure_claude_md
    echo ""

    # Done!
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                 INSTALLATION COMPLETE                        ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    log_success "LMF3 installed successfully!"
    echo ""
    echo "Backup location: $BACKUP_DIR"
    echo "To restore:      ./install.sh restore"
    echo ""
    echo "Next steps:"
    echo "  1. Restart Claude Code to load MCP server and hooks"
    echo "  2. Test: mem stats"
    echo "  3. (Optional) Install Fabric for richer session extraction:"
    echo "     https://github.com/danielmiessler/fabric"
    echo "  4. (Optional) Set up cron for batch extraction of missed sessions:"
    echo "     */30 * * * * $HOME/.bun/bin/bun run $CLAUDE_DIR/hooks/BatchExtract.ts --limit 20 >> /tmp/lmf3-batch.log 2>&1"
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
        echo "LMF3 Install Script"
        echo ""
        echo "Usage:"
        echo "  ./install.sh          Install LMF3 (creates backup first)"
        echo "  ./install.sh restore  Restore from most recent backup"
        echo "  ./install.sh restore TIMESTAMP  Restore specific backup"
        echo "  ./install.sh list     List available backups"
        echo "  ./install.sh help     Show this help"
        ;;
    *)
        do_install
        ;;
esac
