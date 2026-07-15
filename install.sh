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

# Error trap — render structured failure panel with the failing step,
# captured log tail, and the exact restore command. yellow-3.3 of the
# installer aesthetic overhaul.
cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo ""
    local lines=(
      "Step:    ${CURRENT_STEP:-(setup phase)}"
      "Status:  exited with code $rc"
      ""
    )

    if [[ -s "${RECALL_INSTALL_LOG:-}" ]]; then
      lines+=("Last 10 lines of $RECALL_INSTALL_LOG:" "")
      while IFS= read -r line; do
        lines+=("  $line")
      done < <(tail -n 10 "$RECALL_INSTALL_LOG")
      lines+=("")
    fi

    if [[ -n "${BACKUP_DIR:-}" ]] && [[ -d "${BACKUP_DIR:-}" ]]; then
      lines+=(
        "Backup preserved at:"
        "  $BACKUP_DIR"
        ""
        "To recover:"
        "  ./install.sh restore"
        ""
      )
    fi
    lines+=("Troubleshooting: docs/troubleshooting.md")

    _panel error "INSTALL FAILED" "${lines[@]}"
  fi
}
trap cleanup EXIT

# Detect OS for error messages (used by check_prerequisites, do_install)
recall_detect_os

# ── Main install orchestration ───────────────────────────────────────────────

do_install() {
  # Best-effort gum install. Honors RECALL_NO_GUM=1; silently falls back to
  # bash mode on any failure (timeout, network, missing tar/curl, etc.).
  _try_install_gum

  echo ""
  _banner info "Recall Installer" "Persistent Memory for Coding Agents"
  echo ""

  # If a prior install/update was interrupted before it could self-verify, the
  # completion sentinel is still present. Surface it (warn-only) so the user
  # knows this run is a convergence pass (#27).
  recall_warn_if_install_incomplete

  log_info "Checking prerequisites..."
  recall_check_prerequisites
  echo ""
  log_info "Detecting platforms..."
  recall_detect_platforms
  recall_select_platforms
  echo ""
  recall_prompt_db_path
  echo ""

  # Resolve the final DB path once so downstream steps and the pre-flight
  # summary agree on the value.
  local RESOLVED_DB_PATH
  RESOLVED_DB_PATH="$(recall_resolve_db_path)"

  # Step counter — 12 always-run steps (added Migrate, Skills); +1 each for
  # OpenCode/Pi/omp. Packaged installs (npm / npx / `bun install -g` via
  # `recall install`) arrive with deps vendored, dist/ prebuilt, and the bins
  # already on PATH, so the Installing / Building / Linking steps are skipped
  # (see RECALL_PACKAGED guard below) — drop 3 from the total.
  STEP_NUM=0
  STEP_TOTAL=12
  [[ "${RECALL_PACKAGED:-false}" == "true" ]] && STEP_TOTAL=$((STEP_TOTAL - 3))
  [[ "$OPENCODE_DETECTED" == "true" ]] && STEP_TOTAL=$((STEP_TOTAL + 1))
  [[ "$PI_DETECTED" == "true" ]] && STEP_TOTAL=$((STEP_TOTAL + 1))
  [[ "$OMP_DETECTED" == "true" ]] && STEP_TOTAL=$((STEP_TOTAL + 1))

  # Pre-flight summary panel — shows what's about to happen and asks the
  # user to confirm before any state changes. Skipped when --yes / non-TTY
  # / NO_CONFIRM=true (yellow-3.1).
  if [[ "$NO_CONFIRM" != "true" ]] && [[ -t 0 ]]; then
    local _platforms=()
    [[ "$CLAUDE_CODE_DETECTED" == "true" ]] && _platforms+=("Claude Code")
    [[ "$OPENCODE_DETECTED" == "true" ]] && _platforms+=("OpenCode")
    [[ "$PI_DETECTED" == "true" ]] && _platforms+=("Pi")
    [[ "$OMP_DETECTED" == "true" ]] && _platforms+=("omp")
    local _plist
    _plist=$(IFS=", "; echo "${_platforms[*]:-(none — core install only)}")

    # Tildify long paths so they fit inside the 58-col panel
    local _root_short="${RECALL_DIR/#$HOME/\~}"
    local _db_short="${RESOLVED_DB_PATH/#$HOME/\~}"
    local _backup_short="${BACKUP_DIR/#$HOME/\~}"

    _panel info "Pre-flight summary" \
      "Install:    $_root_short" \
      "Database:   $_db_short" \
      "Platforms:  $_plist" \
      "Backup:     $_backup_short" \
      "Steps:      $STEP_TOTAL total"
    echo ""

    if ! _confirm "Continue with installation?" "Y"; then
      log_warn "Install cancelled"
      trap - EXIT  # don't trigger error panel for user cancel
      exit 0
    fi
  fi

  _step "Backup" "Creating backup of existing files"
  recall_create_backup

  _step "Migrate" "Preparing install root + migrating legacy database"
  recall_create_install_root
  # Mark the install in-flight now that $RECALL_DIR exists, before any
  # artifact-mutating step. Cleared only after the self-check passes (#27).
  recall_mark_install_incomplete
  recall_auto_migrate

  # Bootstrap steps — vendoring deps, building dist/, and linking the global
  # bins. Packaged installs (RECALL_PACKAGED=1, set by `recall install`) already
  # have all three from the package manager, so they are skipped there. The
  # git-checkout `./install.sh` path (RECALL_PACKAGED unset) runs them as before.
  if [[ "${RECALL_PACKAGED:-false}" != "true" ]]; then
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

    _step "Linking" "Linking recall + recall-mcp globally"
    # recall_link_global does bun link → verify → npm link fallback → verify.
    # 0.7.22 hardening: the verify step catches the silent-no-op case where
    # `bun link` exits 0 but doesn't actually refresh ~/.bun/bin/recall{,-mcp},
    # which was the root cause of the "recall not on PATH after install" class
    # of failures.
    if ! recall_link_global; then
      exit 1
    fi
  else
    log_info "Packaged install — deps vendored, dist/ prebuilt, bins on PATH (skipping bun install/build/link)"
  fi

  _step "Database" "Initializing memory database"
  mkdir -p "$CLAUDE_DIR/MEMORY"
  local mem_bin="$HOME/.bun/bin/recall"
  if [[ ! -x "$mem_bin" ]]; then
    mem_bin="$(which recall 2>/dev/null || echo "")"
  fi
  if [[ -z "$mem_bin" ]]; then
    log_error "recall binary not found after linking. Check that ~/.bun/bin is in your PATH."
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
  if [[ -f "$RECALL_REPO_DIR/FOR_CLAUDE.md" ]]; then
    recall_copy_canonical "$RECALL_REPO_DIR/FOR_CLAUDE.md" "$RECALL_CLAUDE_ROOT/Recall_GUIDE.md"
    recall_link "$CLAUDE_DIR/Recall_GUIDE.md" "$RECALL_CLAUDE_ROOT/Recall_GUIDE.md"
    log_success "Installed at $CLAUDE_DIR/Recall_GUIDE.md"
  fi

  _step "Commands" "Cleaning up legacy slash commands"
  # Slash commands migrated to Agent Skills (#228) — remove what older
  # releases installed so retired /Recall:* commands don't linger.
  recall_remove_legacy_slash_commands

  _step "Skills" "Installing agent skills"
  if [[ -d "$RECALL_REPO_DIR/agent-skills" ]]; then
    recall_install_claude_skills
    log_success "Installed Recall: agent skills to $CLAUDE_DIR/skills"
  else
    log_warn "Agent skills directory not found at $RECALL_REPO_DIR/agent-skills — skipping"
  fi

  _step "CLAUDE.md" "Configuring CLAUDE.md"
  recall_configure_claude_md

  if [[ "$OPENCODE_DETECTED" == "true" ]]; then
    _step "OpenCode" "Configuring OpenCode integration"
    recall_install_opencode_platform
  fi

  if [[ "$PI_DETECTED" == "true" ]]; then
    _step "Pi" "Configuring Pi integration"
    recall_install_pi_platform
  fi

  if [[ "$OMP_DETECTED" == "true" ]]; then
    _step "omp" "Configuring omp integration"
    recall_install_omp_platform
  fi
  echo ""

  # Post-flight self-check — confirms the install is actually working before
  # we declare victory (yellow-3.2). Failures are surfaced inline; they don't
  # abort the install but they do warn the user something is off.
  CURRENT_STEP="Self-check"
  log_info "Running self-check..."
  local _check_ok=true

  # Provision the embedding model before the self-check reports health (#240).
  # Optional by design: never flips _check_ok, never aborts the install.
  recall_provision_embedding_model

  # First: verify every expected symlink is in place. This catches the class
  # of failure where an inner loop got interrupted between canonical-copy and
  # symlink creation (we hit this once — canonicals were copied but the
  # platform-home symlinks never materialized).
  if recall_verify_install; then
    log_success "All symlinks verified"
  else
    _check_ok=false
  fi

  if "$mem_bin" stats >/dev/null 2>&1; then
    log_success "Database initialized"
  else
    log_warn "recall stats failed — DB may not be initialized"
    _check_ok=false
  fi
  if "$mem_bin" doctor >/dev/null 2>&1; then
    log_success "recall doctor — all checks passing"
  else
    log_warn "recall doctor reports issues — run 'recall doctor' to investigate"
    _check_ok=false
  fi
  echo ""

  # Finalize: clear the sentinel on success, or leave it and fail loudly on a
  # self-check failure (#27, OQ#3 — matches update.sh:step_verify, which already
  # exit 1s). No more "installed (with self-check warnings)" — a failed gate is
  # a failed install.
  if ! recall_finalize_install "$_check_ok"; then
    # Suppress the generic EXIT panel — recall_finalize_install already printed
    # a tailored, accurate recovery (re-run converges). Mirrors the user-cancel
    # path above, which also drops the trap before a clean intentional exit.
    trap - EXIT
    _banner error "Installation Incomplete"
    exit 1
  fi

  _banner success "Installation Complete"
  echo ""
  log_success "Recall installed successfully — all systems operational."
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
  echo "  $step. Test: recall stats"
  step=$((step + 1))
  echo "  $step. (Recommended) Set up your L0 identity tier:"
  echo "     recall onboard"
  echo "     A 7-question interview that writes ~/.claude/MEMORY/identity.md."
  echo "     Loads at every session start, gives every agent the same baseline."
  step=$((step + 1))
  echo "  $step. (Optional) Install Fabric for richer session extraction:"
  echo "     https://github.com/danielmiessler/fabric"
  step=$((step + 1))
  echo "  $step. (Optional) Set up cron for batch extraction of missed sessions:"
  echo "     */30 * * * * $HOME/.bun/bin/bun run $CLAUDE_DIR/hooks/RecallBatchExtract.ts --limit 20 >> /tmp/recall-batch.log 2>&1"
  echo ""
}

# ── MAIN ─────────────────────────────────────────────────────────────────────

# Flag parser — supports any combination of --yes, --no-gum, --db-path. The
# previous case-statement form only accepted one flag at a time. Subcommands
# (restore / list / help) still take the first positional arg.
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
  echo "  ./install.sh                          Install Recall (creates backup first)"
  echo "  ./install.sh --yes | -y               Install non-interactively (configure all detected agents)"
  echo "  ./install.sh --no-gum                 Skip gum auto-install; use bash UX for this run"
  echo "  ./install.sh --db-path PATH           Use a custom database path (skips the interactive prompt)"
  echo "  ./install.sh restore                  Restore from most recent backup"
  echo "  ./install.sh restore TIMESTAMP        Restore specific backup"
  echo "  ./install.sh list                     List available backups"
  echo "  ./install.sh help                     Show this help"
  echo ""
  echo "Environment:"
  echo "  RECALL_DB_PATH                        Database path (primary)"
  echo "  MEM_DB_PATH                           Database path (deprecated; still accepted)"
  echo "  RECALL_NO_GUM=1                       Permanently disable gum (same as --no-gum)"
  echo "  NO_COLOR=1                            Disable ANSI colors"
  echo "  RECALL_VERBOSE=1                      Show full output of bun install/build"
  echo "  RECALL_PACKAGED=1                     Packaged install (set by 'recall install'): skip bun install/build/link"
  ;;
*)
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes | -y)
        export NO_CONFIRM=true
        shift
        ;;
      --no-gum)
        export RECALL_NO_GUM=1
        shift
        ;;
      --db-path)
        if [[ -z "${2:-}" ]]; then
          echo "Error: --db-path requires an argument" >&2
          exit 1
        fi
        # Expand a leading tilde so we always pass an absolute path through
        # to downstream config writers.
        if [[ "$2" == "~"* ]]; then
          export RECALL_DB_PATH="${2/#\~/$HOME}"
        else
          export RECALL_DB_PATH="$2"
        fi
        shift 2
        ;;
      --db-path=*)
        _val="${1#--db-path=}"
        if [[ "$_val" == "~"* ]]; then
          export RECALL_DB_PATH="${_val/#\~/$HOME}"
        else
          export RECALL_DB_PATH="$_val"
        fi
        unset _val
        shift
        ;;
      *)
        echo "Error: unknown argument: $1" >&2
        echo "Run ./install.sh --help for usage." >&2
        exit 1
        ;;
    esac
  done
  do_install
  ;;
esac
