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
  printf '%b╔══════════════════════════════════════════════════════════╗%b\n' "$YELLOW" "$NC"
  printf '%b║%b                     Recall Installer                     %b║%b\n' "$YELLOW" "$NC" "$YELLOW" "$NC"
  printf '%b║%b           Persistent Memory for Coding Agents            %b║%b\n' "$YELLOW" "$NC" "$YELLOW" "$NC"
  printf '%b╚══════════════════════════════════════════════════════════╝%b\n' "$YELLOW" "$NC"
  echo ""

  log_info "Checking prerequisites..."
  recall_check_prerequisites
  echo ""
  log_info "Detecting platforms..."
  recall_detect_platforms
  recall_select_platforms
  echo ""

  # Step counter — 10 always-run steps; +1 each for OpenCode/Pi when detected.
  STEP_NUM=0
  STEP_TOTAL=10
  [[ "$OPENCODE_DETECTED" == "true" ]] && STEP_TOTAL=$((STEP_TOTAL + 1))
  [[ "$PI_DETECTED" == "true" ]] && STEP_TOTAL=$((STEP_TOTAL + 1))

  _step "Backup" "Creating backup of existing files"
  recall_create_backup

  _step "Installing" "Bun dependencies"
  if ! _run_quiet "bun install" bun install; then
    log_info "Try running: bun install (manually to see errors)"
    exit 1
  fi

  _step "Building" "Compiling bundles"
  if ! _run_quiet "bun run build" bun run build; then
    log_info "Try running: bun run build (manually to see errors)"
    exit 1
  fi

  _step "Linking" "Linking mem + mem-mcp globally"
  # recall_link_global does bun link → verify → npm link fallback → verify.
  # 0.7.22 hardening: the verify step catches the silent-no-op case where
  # `bun link` exits 0 but doesn't actually refresh ~/.bun/bin/mem{,-mcp},
  # which was the root cause of the "mem not on PATH after install" class
  # of failures.
  if ! recall_link_global; then
    exit 1
  fi

  _step "Database" "Initializing memory database"
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
  log_success "MEMORY directory at $CLAUDE_DIR/MEMORY"

  _step "MCP" "Configuring MCP server"
  recall_configure_mcp

  _step "Hooks" "Installing session extraction hooks"
  _recall_copy_hook_files
  recall_register_all_hooks

  _step "Guide" "Installing Recall guide"
  cp "$(pwd)/FOR_CLAUDE.md" "$CLAUDE_DIR/Recall_GUIDE.md"
  log_success "Installed at $CLAUDE_DIR/Recall_GUIDE.md"

  _step "Commands" "Installing slash commands"
  local commands_src="$(pwd)/commands/Recall"
  local commands_dest="$CLAUDE_DIR/commands/Recall"
  local commands_legacy="$CLAUDE_DIR/commands/recall"
  if [[ -d "$commands_src" ]]; then
    mkdir -p "$commands_dest"
    cp "$commands_src"/*.md "$commands_dest/"
    if [[ -d "$commands_legacy" && "$commands_legacy" != "$commands_dest" ]]; then
      rm -rf "$commands_legacy"
      log_info "Removed legacy lowercase slash commands at $commands_legacy"
    fi
    log_success "Installed Recall: slash commands to $commands_dest"
  else
    log_warn "Slash commands directory not found at $commands_src — skipping"
  fi

  _step "CLAUDE.md" "Configuring CLAUDE.md"
  recall_configure_claude_md

  if [[ "$OPENCODE_DETECTED" == "true" ]]; then
    _step "OpenCode" "Configuring OpenCode integration"
    recall_configure_opencode_mcp
    recall_install_opencode_plugins
    recall_install_opencode_agent
    recall_install_opencode_guide
  fi

  if [[ "$PI_DETECTED" == "true" ]]; then
    _step "Pi" "Configuring Pi integration"
    recall_install_pi_adapter
    recall_configure_pi_mcp
    recall_install_pi_extensions
    recall_install_pi_guide
  fi
  echo ""

  printf '%b╔══════════════════════════════════════════════════════════╗%b\n' "$GREEN" "$NC"
  printf '%b║%b                  Installation Complete                   %b║%b\n' "$GREEN" "$NC" "$GREEN" "$NC"
  printf '%b╚══════════════════════════════════════════════════════════╝%b\n' "$GREEN" "$NC"
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
  echo "  ./install.sh --yes | -y        Install non-interactively (configure all detected agents)"
  echo "  ./install.sh restore           Restore from most recent backup"
  echo "  ./install.sh restore TIMESTAMP Restore specific backup"
  echo "  ./install.sh list              List available backups"
  echo "  ./install.sh help              Show this help"
  ;;
--yes | -y)
  export NO_CONFIRM=true
  do_install
  ;;
*)
  do_install
  ;;
esac
