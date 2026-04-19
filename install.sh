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

# Resolve script directory so we can source lib/install-lib.sh reliably
# regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/install-lib.sh
source "$SCRIPT_DIR/lib/install-lib.sh"

# Error trap — guide user to restore on failure
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

# Detect OS for error messages (used by check_prerequisites, do_install)
recall_detect_os

# ── Main install orchestration ───────────────────────────────────────────────

do_install() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║                      Recall INSTALLER                      ║"
  echo "║      RECALL - Persistent Memory for Coding Agents           ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  log_info "Checking prerequisites..."
  recall_check_prerequisites
  echo ""
  log_info "Detecting platforms..."
  recall_detect_platforms
  echo ""

  log_info "Step 1: Creating backup of existing files..."
  recall_create_backup
  echo ""

  log_info "Step 2: Installing dependencies..."
  if ! bun install; then
    log_error "Failed to install dependencies"
    log_info "Try running: bun install (manually to see errors)"
    exit 1
  fi
  log_success "Dependencies installed"
  echo ""

  log_info "Step 3: Building..."
  if ! bun run build; then
    log_error "Build failed"
    log_info "Try running: bun run build (manually to see errors)"
    exit 1
  fi
  log_success "Build complete"
  echo ""

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

  log_info "Step 5: Initializing database..."
  mkdir -p "$CLAUDE_DIR/MEMORY"
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

  log_info "Step 6: Configuring MCP server..."
  recall_configure_mcp
  echo ""

  log_info "Step 7: Setting up session extraction hooks..."
  _recall_copy_hook_files
  recall_register_all_hooks
  echo ""

  log_info "Step 8: Installing Claude guide..."
  cp "$(pwd)/FOR_CLAUDE.md" "$CLAUDE_DIR/Recall_GUIDE.md"
  log_success "Installed Recall guide at $CLAUDE_DIR/Recall_GUIDE.md"
  echo ""

  log_info "Step 8b: Installing slash commands..."
  local commands_src="$(pwd)/commands/recall"
  local commands_dest="$CLAUDE_DIR/commands/recall"
  if [[ -d "$commands_src" ]]; then
    mkdir -p "$commands_dest"
    cp "$commands_src"/*.md "$commands_dest/"
    log_success "Installed recall: slash commands to $commands_dest"
  else
    log_warn "Slash commands directory not found at $commands_src — skipping"
  fi
  echo ""

  log_info "Step 9: Configuring CLAUDE.md..."
  recall_configure_claude_md
  echo ""

  if [[ "$OPENCODE_DETECTED" == "true" ]]; then
    echo ""
    log_info "Step 10: Configuring OpenCode integration..."
    recall_configure_opencode_mcp
    recall_install_opencode_plugins
    recall_install_opencode_agent
    recall_install_opencode_guide
    echo ""
  fi

  if [[ "$PI_DETECTED" == "true" ]]; then
    echo ""
    log_info "Step 11: Configuring Pi integration..."
    recall_install_pi_adapter
    recall_configure_pi_mcp
    recall_install_pi_extensions
    recall_install_pi_guide
    echo ""
  fi

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
  [[ "$CLAUDE_CODE_DETECTED" == "true" ]] && echo "  ✓ Claude Code (MCP + hooks + CLAUDE.md)"
  [[ "$OPENCODE_DETECTED" == "true" ]] && echo "  ✓ OpenCode (MCP + plugins + agent)"
  [[ "$PI_DETECTED" == "true" ]] && echo "  ✓ Pi (MCP via adapter + extensions + AGENTS.md)"
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
  echo "  $step. (Recommended) Set up your L0 identity tier:"
  echo "     mem onboard"
  echo "     A 7-question interview that writes ~/.claude/MEMORY/identity.md."
  echo "     Loads at every session start, gives every agent the same baseline."
  step=$((step + 1))
  echo "  $step. (Optional) Install Fabric for richer session extraction:"
  echo "     https://github.com/danielmiessler/fabric"
  step=$((step + 1))
  echo "  $step. (Optional) Set up cron for batch extraction of missed sessions:"
  echo "     */30 * * * * $HOME/.bun/bin/bun run $CLAUDE_DIR/hooks/BatchExtract.ts --limit 20 >> /tmp/recall-batch.log 2>&1"
  echo ""
}

# ── MAIN ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
restore)
  recall_do_restore "${2:-}"
  ;;
list)
  recall_list_backups
  ;;
help | --help | -h)
  echo "Recall Install Script"
  echo ""
  echo "Usage:"
  echo "  ./install.sh                   Install Recall (creates backup first)"
  echo "  ./install.sh restore           Restore from most recent backup"
  echo "  ./install.sh restore TIMESTAMP Restore specific backup"
  echo "  ./install.sh list              List available backups"
  echo "  ./install.sh help              Show this help"
  ;;
*)
  do_install
  ;;
esac
