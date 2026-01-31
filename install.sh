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

set -e

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
            ((backed_up++))
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
    for file in "${FILES_TO_BACKUP[@]}"; do
        if [[ -f "$file" ]]; then
            cp "$file" "$pre_restore_dir/"
        fi
    done
    log_success "Current state saved to: pre_restore_$TIMESTAMP"

    # Restore files
    local restored=0
    for file in "$restore_dir"/*; do
        local filename=$(basename "$file")
        if [[ "$filename" == "manifest.txt" ]]; then
            continue
        fi

        local target="$CLAUDE_DIR/$filename"
        cp "$file" "$target"
        log_success "Restored: $filename"
        ((restored++))
    done

    echo ""
    log_success "Restore complete: $restored file(s) restored"
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

    mkdir -p "$CLAUDE_DIR"

    if [[ -f "$mcp_file" ]]; then
        # Check if memory-larry already configured
        if grep -q "memory-larry" "$mcp_file"; then
            log_success "MCP already configured for memory-larry"
            return
        fi

        # Need to merge into existing config
        log_info "Merging memory-larry into existing MCP config..."

        # Use node to safely merge JSON
        node -e "
            const fs = require('fs');
            const config = JSON.parse(fs.readFileSync('$mcp_file', 'utf8'));
            config.mcpServers = config.mcpServers || {};
            config.mcpServers['memory-larry'] = { command: 'mem-mcp', args: [] };
            fs.writeFileSync('$mcp_file', JSON.stringify(config, null, 2));
        "
        log_success "Merged memory-larry into existing MCP config"
    else
        # Create fresh config
        cat > "$mcp_file" << 'EOF'
{
  "mcpServers": {
    "memory-larry": {
      "command": "mem-mcp",
      "args": []
    }
  }
}
EOF
        log_success "Created MCP config"
    fi
}

#
# CONFIGURE CLAUDE.md
#
configure_claude_md() {
    local claude_md="$CLAUDE_DIR/CLAUDE.md"
    local lmf3_dir="$(pwd)"

    local memory_section="## MEMORY

You have persistent memory via LMF3. **Read the full guide:** $lmf3_dir/FOR_CLAUDE.md

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
    echo "║         Larry Memory Framework for Claude Code               ║"
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
    bun install --silent
    log_success "Dependencies installed"
    echo ""

    # Step 3: Rebuild native modules
    log_info "Step 3: Rebuilding native SQLite module..."
    npm rebuild better-sqlite3 > /dev/null 2>&1
    log_success "Native modules rebuilt"
    echo ""

    # Step 4: Build
    log_info "Step 4: Building..."
    bun run build > /dev/null 2>&1
    log_success "Build complete"
    echo ""

    # Step 5: Link globally
    log_info "Step 5: Linking globally (requires sudo)..."
    sudo npm link > /dev/null 2>&1
    log_success "Linked: mem and mem-mcp now available globally"
    echo ""

    # Step 6: Initialize database
    log_info "Step 6: Initializing database..."
    mem init
    echo ""

    # Step 7: Configure MCP
    log_info "Step 7: Configuring MCP server..."
    configure_mcp
    echo ""

    # Step 8: Configure CLAUDE.md
    log_info "Step 8: Configuring CLAUDE.md..."
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
    echo "  1. Restart Claude Code to load MCP server"
    echo "  2. Tell Claude: \"Read $(pwd)/FOR_CLAUDE.md\""
    echo "  3. Test: mem stats"
    echo ""
    echo "(Optional) Install Fabric for session capture:"
    echo "  https://github.com/danielmiessler/fabric"
    echo ""
}

#
# MAIN
#
case "${1:-}" in
    restore)
        do_restore "$2"
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
