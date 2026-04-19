#!/bin/bash
#
# Recall Update Script
#
# Pulls the latest release, rebuilds, applies DB migrations, refreshes
# runtime files, and re-registers hooks (permanently fixing the Bug 1 class
# of defect where one partial install could leave hooks missing).
#
# Usage:
#   ./update.sh                # full update
#   ./update.sh --check        # version check only, exit
#   ./update.sh --dry-run      # show plan, touch nothing
#   ./update.sh --force        # skip "already current" guard, still confirm
#   ./update.sh --no-migrate   # skip mem init migration step
#   ./update.sh --no-confirm   # non-interactive
#   ./update.sh --help         # this message
#
# Repository is expected to be a clone of github.com/edheltzel/Recall with
# `main` as the primary branch. DB schema downgrades are not supported.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/install-lib.sh
source "$SCRIPT_DIR/lib/install-lib.sh"

REPO_OWNER="edheltzel"
REPO_NAME="Recall"
RELEASES_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"

# ── Flags ────────────────────────────────────────────────────────────────────

CHECK_ONLY=false
DRY_RUN=false
FORCE=false
NO_MIGRATE=false
NO_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
  --check) CHECK_ONLY=true ;;
  --dry-run) DRY_RUN=true ;;
  --force) FORCE=true ;;
  --no-migrate) NO_MIGRATE=true ;;
  --no-confirm) NO_CONFIRM=true ;;
  --help | -h)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    log_error "Unknown flag: $1"
    exit 1
    ;;
  esac
  shift
done

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# ── Version helpers ──────────────────────────────────────────────────────────

current_version() {
  node -e 'process.stdout.write(require("./package.json").version)' 2>/dev/null \
    || echo "unknown"
}

# Fetch latest release tag from GitHub. Prefers `gh` (authenticated, higher
# rate limit); falls back to curl+jq or raw curl+sed.
latest_release_tag() {
  if command -v gh &>/dev/null; then
    gh release view --repo "${REPO_OWNER}/${REPO_NAME}" --json tagName -q .tagName 2>/dev/null \
      || true
    return
  fi
  local body
  body="$(curl -sf "$RELEASES_API" 2>/dev/null)" || { echo ""; return; }
  if command -v jq &>/dev/null; then
    echo "$body" | jq -r .tag_name
  else
    echo "$body" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1
  fi
}

# Fetch latest release body (release notes) for display.
latest_release_notes() {
  if command -v gh &>/dev/null; then
    gh release view --repo "${REPO_OWNER}/${REPO_NAME}" --json body -q .body 2>/dev/null \
      || true
    return
  fi
  local body
  body="$(curl -sf "$RELEASES_API" 2>/dev/null)" || return
  if command -v jq &>/dev/null; then
    echo "$body" | jq -r .body
  else
    echo "$body" | sed -n 's/.*"body": *"\(.*\)".*/\1/p' | head -1 | sed 's/\\n/\n/g'
  fi
}

# Strip a leading `v` for comparison.
normalize() { echo "${1#v}"; }

# ── Rollback recipe emission ─────────────────────────────────────────────────

write_rollback_recipe() {
  local pre_sha="$1"
  local reason="$2"
  local recipe="$BACKUP_DIR/ROLLBACK.txt"

  mkdir -p "$BACKUP_DIR"
  cat >"$recipe" <<EOF
Recall Update Rollback — $TIMESTAMP

Update failed: $reason

To roll back this repository and restore the pre-update runtime files:

  cd $SCRIPT_DIR
  git reset --hard $pre_sha
  bun install && bun run build
  ./install.sh restore $TIMESTAMP

Notes:
  - memory.db is NOT overwritten by restore — it lives through the restore.
  - DB schema downgrades are NOT supported. If migrations ran and applied
    a newer schema, you cannot revert the DB via ./install.sh restore
    alone; you must delete ~/.claude/memory.db and re-init from backup.
  - Release tag fetched from: $RELEASES_API
EOF

  log_warn "Rollback recipe written to: $recipe"
  echo ""
  cat "$recipe"
}

# Traps any failure and emits the rollback recipe before exiting.
PRE_SHA=""
rollback_on_failure() {
  local code=$?
  if [[ $code -ne 0 ]] && [[ -n "$PRE_SHA" ]] && [[ "$DRY_RUN" != "true" ]]; then
    echo ""
    log_error "Update failed (exit $code)."
    write_rollback_recipe "$PRE_SHA" "Exit code $code during update."
  fi
  exit $code
}

# ── Steps ────────────────────────────────────────────────────────────────────

step_version_check() {
  local cur latest
  cur="$(current_version)"
  latest="$(latest_release_tag)"

  if [[ -z "$latest" ]]; then
    log_warn "Could not fetch latest release from GitHub. Proceeding without version check."
    echo "Current: v$(normalize "$cur")"
    return 0
  fi

  local latest_norm cur_norm
  latest_norm="$(normalize "$latest")"
  cur_norm="$(normalize "$cur")"

  echo "Current: v$cur_norm"
  echo "Latest:  v$latest_norm"

  if [[ "$cur_norm" == "$latest_norm" ]] && [[ "$FORCE" != "true" ]]; then
    log_success "Recall is up to date at v$cur_norm."
    echo "(Pass --force to re-run update anyway.)"
    exit 0
  fi

  if [[ "$CHECK_ONLY" == "true" ]]; then
    echo ""
    echo "Release notes:"
    latest_release_notes | head -20 | sed 's/^/  /'
    echo ""
    echo "To apply: cd $SCRIPT_DIR && ./update.sh"
    exit 0
  fi

  echo ""
  echo "Release notes (excerpt):"
  latest_release_notes | head -10 | sed 's/^/  /'
  echo ""
}

step_confirm() {
  if [[ "$NO_CONFIRM" == "true" ]] || [[ "$DRY_RUN" == "true" ]]; then return; fi
  log_warn "Update will pull, rebuild, and reload hooks."
  log_warn "If Claude Code / OpenCode / Pi is running, exit them BEFORE continuing."
  read -p "Proceed? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warn "Update cancelled"
    exit 0
  fi
}

step_backup() {
  log_info "Creating pre-update backup..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would create backup at $BACKUP_DIR"
    PRE_SHA="$(git rev-parse HEAD 2>/dev/null || echo "unknown")"
  else
    recall_create_backup
    PRE_SHA="$(git rev-parse HEAD)"
  fi
}

step_fetch_and_pull() {
  log_info "Fetching latest tags..."
  run git fetch --tags origin

  log_info "Pulling (fast-forward only)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would: git pull --ff-only origin main"
    return
  fi

  if ! git pull --ff-only origin main; then
    log_error "git pull --ff-only failed — you likely have local commits or a dirty tree."
    log_error "Resolve manually, then re-run ./update.sh."
    exit 1
  fi
}

step_install_and_build() {
  log_info "Installing dependencies (bun install)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would: bun install"
  else
    bun install
  fi

  log_info "Building (bun run build)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would: bun run build"
  else
    bun run build
  fi
}

step_migrate() {
  if [[ "$NO_MIGRATE" == "true" ]]; then
    log_warn "--no-migrate: skipping database migrations"
    return
  fi

  log_info "Applying database migrations (mem init)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would: mem init"
    return
  fi

  local mem_bin="$HOME/.bun/bin/mem"
  if [[ ! -x "$mem_bin" ]]; then
    mem_bin="$(which mem 2>/dev/null || echo "")"
  fi
  if [[ -z "$mem_bin" ]]; then
    log_warn "mem binary not found — skipping migrations. Run './install.sh' to relink."
    return
  fi
  "$mem_bin" init
}

step_refresh_runtime() {
  log_info "Refreshing runtime files (hooks, lib, commands, guide)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would: copy hooks/, hooks/lib/, commands/recall/, FOR_CLAUDE.md"
    return
  fi

  # Check for drift on extract_prompt.md; write .new on drift.
  local installed="$CLAUDE_DIR/MEMORY/extract_prompt.md"
  local source_file="$SCRIPT_DIR/hooks/extract_prompt.md"
  if [[ -f "$installed" ]] && [[ -f "$source_file" ]]; then
    if ! diff -q "$installed" "$source_file" >/dev/null 2>&1; then
      cp "$source_file" "$installed.new"
      log_warn "User-modified $installed preserved. New version written to: $installed.new"
    fi
  fi

  recall_copy_runtime_files
}

step_reregister_hooks() {
  log_info "Re-registering all hooks (permanently fixes Bug 1 class)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would: recall_register_all_hooks"
    return
  fi
  recall_register_all_hooks
}

step_verify() {
  log_info "Verifying..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would: mem --version && mem stats"
    return
  fi

  local mem_bin="$HOME/.bun/bin/mem"
  [[ ! -x "$mem_bin" ]] && mem_bin="$(which mem 2>/dev/null || echo "")"
  if [[ -n "$mem_bin" ]]; then
    "$mem_bin" --version
    "$mem_bin" stats 2>/dev/null | head -10 || log_warn "mem stats output non-zero (db may be empty)"
  else
    log_warn "mem binary not found — skipping verification. Run './install.sh' to relink."
  fi
}

step_report() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║                    UPDATE COMPLETE                       ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  log_success "Recall updated to v$(normalize "$(current_version)")"
  echo ""
  echo "Backup:    $BACKUP_DIR"
  echo "PRE_SHA:   $PRE_SHA"
  echo ""
  if ls "$CLAUDE_DIR/MEMORY"/*.new 2>/dev/null; then
    echo "Drift preserved — review .new files in ~/.claude/MEMORY/ and merge manually."
    echo ""
  fi
  echo "Next step: restart Claude Code / OpenCode / Pi to load the new hooks."
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  trap rollback_on_failure ERR

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║                       Recall UPDATE                        ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "Mode: $([[ "$DRY_RUN" == "true" ]] && echo "DRY-RUN (no changes)" || echo "LIVE")"
  [[ "$FORCE" == "true" ]] && echo "Force: YES (will rerun even if already current)"
  [[ "$NO_MIGRATE" == "true" ]] && echo "No-migrate: YES"
  echo ""

  step_version_check
  [[ "$CHECK_ONLY" == "true" ]] && exit 0

  step_confirm
  step_backup
  step_fetch_and_pull
  step_install_and_build
  step_migrate
  step_refresh_runtime
  step_reregister_hooks
  step_verify
  step_report
}

main
