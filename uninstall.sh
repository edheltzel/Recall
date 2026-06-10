#!/bin/bash
#
# Recall Uninstall Script
#
# Removes Recall integration from Claude Code, OpenCode, and Pi. By default
# preserves user data (~/.agents/Recall/ tree — DB, canonical hooks/commands,
# backups, MEMORY artifacts). Use --purge to destroy everything.
#
# Usage:
#   ./uninstall.sh                  # preserve-everything default
#   ./uninstall.sh --dry-run        # show what would change, touch nothing
#   ./uninstall.sh --purge          # also destroy memory.db + backup tree
#   ./uninstall.sh --no-confirm     # non-interactive; prints what was removed
#   ./uninstall.sh --skip-opencode  # leave OpenCode integration alone
#   ./uninstall.sh --skip-pi        # leave Pi integration alone
#   ./uninstall.sh --no-gum         # skip gum auto-install; use bash UX this run
#   ./uninstall.sh --help           # show this help
#
# Environment:
#   RECALL_NO_GUM=1   Permanent gum opt-out (same as --no-gum)
#   NO_COLOR=1        Disable ANSI colors
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/install-lib.sh
source "$SCRIPT_DIR/lib/install-lib.sh"

# ── Flags ────────────────────────────────────────────────────────────────────

DRY_RUN=false
PURGE=false
NO_CONFIRM=false
SKIP_OPENCODE=false
SKIP_PI=false

while [[ $# -gt 0 ]]; do
  case "$1" in
  --dry-run) DRY_RUN=true ;;
  --purge) PURGE=true ;;
  --no-confirm) NO_CONFIRM=true ;;
  --skip-opencode) SKIP_OPENCODE=true ;;
  --skip-pi) SKIP_PI=true ;;
  --no-gum) export RECALL_NO_GUM=1 ;;
  --help | -h)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    log_error "Unknown flag: $1"
    exit 1
    ;;
  esac
  shift
done

# Dry-run wrapper: when DRY_RUN is true, narrate the mutation instead of
# executing it. Preserves quoted args by passing through "$@".
run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# ── Hard-coded inventory of files Recall owns ────────────────────────────────

RECALL_HOOK_FILES=(
  "$CLAUDE_DIR/hooks/RecallExtract.ts"
  "$CLAUDE_DIR/hooks/RecallBatchExtract.ts"
  "$CLAUDE_DIR/hooks/RecallTelosSync.ts"
  "$CLAUDE_DIR/hooks/RecallStart.ts"
  "$CLAUDE_DIR/hooks/RecallPreCompact.ts"
  "$CLAUDE_DIR/hooks/RecallClearExtract.ts"
  # Legacy names — kept here so uninstall still cleans up installs that
  # haven't run a Phase-2-aware update.sh yet.
  "$CLAUDE_DIR/hooks/SessionExtract.ts"
  "$CLAUDE_DIR/hooks/BatchExtract.ts"
  "$CLAUDE_DIR/hooks/TelosSync.ts"
  "$CLAUDE_DIR/hooks/SessionRecall.ts"
  "$CLAUDE_DIR/hooks/SessionPreCompact.ts"
  "$CLAUDE_DIR/hooks/ClearExtract.ts"
)

RECALL_HOOK_LIB_FILES=(
  "$CLAUDE_DIR/hooks/lib/extraction-lock.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-migration.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-quality.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-semaphore.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-tracker.ts"
  "$CLAUDE_DIR/hooks/lib/pid-utils.ts"
  "$CLAUDE_DIR/hooks/lib/db-path.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-parsers.ts"
  "$CLAUDE_DIR/hooks/lib/sqlite-writers.ts"
  "$CLAUDE_DIR/hooks/lib/path-encoding.ts"
  "$CLAUDE_DIR/hooks/lib/pick-previous-jsonl.ts"
)

# Hook name patterns that identify Recall-owned entries in settings.json.
# Includes both new (RecallExtract etc.) and legacy (SessionExtract etc.)
# names so uninstall scrubs both. filter_claude_settings does substring
# matching, so listing both eras is correct.
RECALL_HOOK_NAMES=(
  RecallExtract RecallBatchExtract RecallTelosSync RecallStart RecallPreCompact RecallClearExtract
  SessionExtract BatchExtract TelosSync SessionRecall SessionPreCompact ClearExtract
)

# ── Summary + confirmation ───────────────────────────────────────────────────

print_summary() {
  echo ""
  _banner warn "Recall Uninstall"
  echo ""
  echo "Mode: $([[ "$DRY_RUN" == "true" ]] && echo "DRY-RUN (no changes)" || echo "LIVE")"
  [[ "$PURGE" == "true" ]] && echo "Purge: YES (will destroy ~/.agents/Recall/ tree, including the DB)"
  [[ "$SKIP_OPENCODE" == "true" ]] && echo "Skipping: OpenCode"
  [[ "$SKIP_PI" == "true" ]] && echo "Skipping: Pi"
  echo ""
  echo "Will REMOVE (symlinks back to ~/.agents/Recall/ — canonical files stay):"
  echo "  • ~/.claude/commands/Recall/ (and legacy ~/.claude/commands/recall/ if present)"
  echo "  • ~/.claude/Recall_GUIDE.md"
  echo "  • Recall hook entries in ~/.claude/settings.json and ~/.claude.json"
  echo "  • Recall mcpServers entry in ~/.claude/settings.json and ~/.claude.json"
  echo "  • ~/.claude/hooks/*.ts (Recall-managed symlinks only)"
  echo "  • ~/.claude/hooks/lib/*.ts (Recall-managed symlinks only)"
  echo "  • ## MEMORY section in ~/.claude/CLAUDE.md (preserves everything else)"
  echo "  • ~/.claude/MEMORY/extract_prompt.md (symlink → ~/.agents/Recall/shared/)"
  [[ "$SKIP_OPENCODE" != "true" ]] && echo "  • OpenCode MCP entry + plugin symlinks"
  [[ "$SKIP_PI" != "true" ]] && echo "  • Pi MCP entry + extension symlinks + AGENTS.md MEMORY section"
  echo "  • bun unlink (removes recall/recall-mcp from PATH)"
  echo ""
  if [[ "$PURGE" == "true" ]]; then
    echo "Will DESTROY (--purge):"
    echo "  • ~/.agents/Recall/recall.db  (your persistent memory database)"
    echo "  • ~/.claude/memory.db  (legacy DB, if still present)"
    echo "  • ~/.agents/Recall/  (canonical hooks, commands, guides, backups)"
    echo ""
  fi
  echo "Will PRESERVE:"
  if [[ "$PURGE" != "true" ]]; then
    echo "  • ~/.agents/Recall/ (DB, canonical files, backups, MEMORY artifacts)"
    echo "  • ~/.claude/memory.db (legacy DB if it exists)"
  fi
  echo "  • ~/.claude/MEMORY/ (non-Recall artifacts in this Claude-owned directory)"
  echo "  • This source directory (remove with: rm -rf $SCRIPT_DIR)"
  echo ""
}

confirm_or_exit() {
  if [[ "$NO_CONFIRM" == "true" ]] || [[ "$DRY_RUN" == "true" ]]; then
    return
  fi
  if ! _confirm "Proceed?" "N"; then
    log_warn "Uninstall cancelled"
    exit 0
  fi
}

confirm_purge_or_exit() {
  if [[ "$PURGE" != "true" ]] || [[ "$DRY_RUN" == "true" ]]; then
    return
  fi
  echo ""
  log_warn "--purge will permanently destroy memory.db and all backups."
  read -p "Type 'PURGE' to confirm: " -r
  echo ""
  if [[ "$REPLY" != "PURGE" ]]; then
    log_warn "Purge declined — skipping memory.db/backup destruction."
    PURGE=false
  fi
}

# ── Removal steps ────────────────────────────────────────────────────────────

remove_slash_commands() {
  # Remove both Title-case (current) and legacy lowercase if present
  local dir
  for dir in "$CLAUDE_DIR/commands/Recall" "$CLAUDE_DIR/commands/recall"; do
    if [[ -d "$dir" ]]; then
      run rm -rf "$dir"
      log_success "Removed $dir"
    fi
  done
}

remove_guide() {
  local f="$CLAUDE_DIR/Recall_GUIDE.md"
  if [[ -f "$f" ]]; then
    run rm -f "$f"
    log_success "Removed $f"
  fi
}

# Filter Recall entries out of settings.json using a single bun -e pass.
# Removes:
#   - hooks[event] entries whose commands reference any RECALL_HOOK_NAMES
#   - mcpServers["recall-memory"]
filter_claude_settings() {
  local f="$CLAUDE_DIR/settings.json"
  [[ ! -f "$f" ]] && return

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would filter Recall entries out of $f"
    return
  fi

  SETTINGS_FILE="$f" HOOK_NAMES_CSV="$(IFS=,; echo "${RECALL_HOOK_NAMES[*]}")" bun -e '
    const fs = require("fs");
    const file = process.env.SETTINGS_FILE;
    const names = process.env.HOOK_NAMES_CSV.split(",");

    let config = {};
    try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }

    if (config.hooks && typeof config.hooks === "object") {
      for (const event of Object.keys(config.hooks)) {
        const list = config.hooks[event];
        if (!Array.isArray(list)) continue;
        const kept = list.filter(entry => {
          const inner = (entry && entry.hooks) || [];
          return !inner.some(h => h && h.command && names.some(n => h.command.includes(n)));
        });
        if (kept.length === 0) {
          delete config.hooks[event];
        } else {
          config.hooks[event] = kept;
        }
      }
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
    }

    if (config.mcpServers && config.mcpServers["recall-memory"]) {
      delete config.mcpServers["recall-memory"];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
    }

    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  '
  log_success "Filtered Recall entries from $f"
}

# Some Claude Code installs register MCP servers via `claude mcp remove`
# rather than by editing settings.json. Try the CLI first.
unregister_claude_mcp_cli() {
  if ! command -v claude &>/dev/null; then return; fi
  if claude mcp list 2>/dev/null | grep -q "recall-memory"; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would run: claude mcp remove --scope user recall-memory"
    else
      claude mcp remove --scope user recall-memory 2>/dev/null || true
      log_success "Unregistered recall-memory via claude mcp remove"
    fi
  fi
}

remove_hook_files() {
  local f removed=0
  for f in "${RECALL_HOOK_FILES[@]}" "${RECALL_HOOK_LIB_FILES[@]}"; do
    # Symlinks resolve via -e (the underlying file). A Recall-managed symlink
    # under $RECALL_DIR is removed by recall_unlink_if_managed. A regular file
    # at the same path (legacy install, pre-symlink era) is removed outright
    # — uninstall asked for it.
    if [[ -L "$f" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [dry-run] would unlink Recall-managed symlink: $f"
      else
        recall_unlink_if_managed "$f"
      fi
      removed=$((removed + 1))
    elif [[ -f "$f" ]]; then
      run rm -f "$f"
      removed=$((removed + 1))
    fi
  done
  log_success "Removed $removed Recall hook file(s)/symlink(s) (surgical — non-Recall hooks/lib untouched)"

  if [[ -d "$CLAUDE_DIR/hooks/lib" ]] && [[ -z "$(ls -A "$CLAUDE_DIR/hooks/lib" 2>/dev/null)" ]]; then
    run rmdir "$CLAUDE_DIR/hooks/lib"
  fi
}

# Remove extract_prompt.md at the platform home. With the symlink architecture
# this is just a Recall-managed link; recall_unlink_if_managed handles the
# safety check. Legacy installs may still have a regular file there — diff
# against the source as before, only remove if unmodified.
remove_extract_prompt_if_unmodified() {
  local installed="$CLAUDE_DIR/MEMORY/extract_prompt.md"
  local source_file="$SCRIPT_DIR/hooks/extract_prompt.md"

  if [[ -L "$installed" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would unlink Recall-managed symlink: $installed"
    else
      recall_unlink_if_managed "$installed"
    fi
    log_success "Removed extract_prompt.md symlink at $installed"
    return
  fi

  [[ ! -f "$installed" ]] && return

  if [[ -f "$source_file" ]] && diff -q "$installed" "$source_file" >/dev/null 2>&1; then
    run rm -f "$installed"
    log_success "Removed unmodified $installed"
  else
    log_warn "Preserved $installed (diverged from source — not auto-removing)"
  fi
}

# Strip the "## MEMORY" section (and everything up to the next heading at
# level 1-2, or EOF) without disturbing anything else.
remove_memory_section() {
  local f="$1"
  [[ ! -f "$f" ]] && return
  if ! grep -q "^## MEMORY" "$f"; then return; fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] would remove ## MEMORY section from $f"
    return
  fi

  MD_FILE="$f" bun -e '
    const fs = require("fs");
    const file = process.env.MD_FILE;
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");

    const startIdx = lines.findIndex(l => /^## MEMORY\b/.test(l));
    if (startIdx === -1) process.exit(0);

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^#{1,2} \S/.test(lines[i])) { endIdx = i; break; }
    }

    let trimStart = startIdx;
    if (trimStart > 0 && lines[trimStart - 1].trim() === "") trimStart--;

    const next = [...lines.slice(0, trimStart), ...lines.slice(endIdx)].join("\n");
    fs.writeFileSync(file, next);
  '
  log_success "Removed ## MEMORY section from $f"
}

run_bun_unlink() {
  # Test escape hatch: `bun unlink` and `npm unlink -g` operate on the host's
  # global registry regardless of CLAUDE_DIR. The uninstall test suite runs
  # this script against a tmpdir CLAUDE_DIR, but without RECALL_SKIP_BUN_UNLINK
  # the test would still wipe the developer's live `recall` link, breaking
  # `recall` and the recall-memory MCP server on the host.
  if [[ "${RECALL_SKIP_BUN_UNLINK:-false}" == "true" ]]; then
    log_info "Skipping bun unlink (RECALL_SKIP_BUN_UNLINK=true)"
    return
  fi

  if command -v bun &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would run: bun unlink"
    else
      bun unlink 2>/dev/null || true
      log_success "bun unlink (recall, recall-mcp)"
    fi
  elif command -v npm &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would run: npm unlink -g recall-memory"
    else
      npm unlink -g recall-memory 2>/dev/null || true
      log_success "npm unlink -g recall-memory"
    fi
  fi
}

# ── OpenCode removal ─────────────────────────────────────────────────────────

remove_opencode() {
  local config="$OPENCODE_CONFIG_DIR/opencode.json"

  if [[ -f "$config" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would remove recall-memory from $config"
    else
      CONFIG_PATH="$config" bun -e '
        const fs = require("fs");
        const path = process.env.CONFIG_PATH;
        let raw = fs.readFileSync(path, "utf-8")
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        const cfg = JSON.parse(raw);
        if (cfg.mcp && cfg.mcp["recall-memory"]) {
          delete cfg.mcp["recall-memory"];
          if (Object.keys(cfg.mcp).length === 0) delete cfg.mcp;
        }
        fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
      '
      log_success "Removed recall-memory from $config"
    fi
  fi

  local plugin_dir="$OPENCODE_CONFIG_DIR/plugins"
  local agent_dir="$OPENCODE_CONFIG_DIR/agents"
  local guide="$OPENCODE_CONFIG_DIR/Recall_GUIDE.md"

  local p
  for p in RecallExtract.ts RecallPreCompact.ts; do
    local pf="$plugin_dir/$p"
    if [[ -L "$pf" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [dry-run] would unlink Recall-managed symlink: $pf"
      else
        recall_unlink_if_managed "$pf"
      fi
      log_success "Removed OpenCode plugin symlink: $p"
    elif [[ -f "$pf" ]]; then
      run rm -f "$pf"
      log_success "Removed OpenCode plugin: $p"
    fi
  done
  if [[ -f "$agent_dir/recall-memory.md" ]]; then
    run rm -f "$agent_dir/recall-memory.md"
    log_success "Removed OpenCode agent: recall-memory.md"
  fi
  if [[ -L "$guide" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would unlink Recall-managed symlink: $guide"
    else
      recall_unlink_if_managed "$guide"
    fi
    log_success "Removed $guide"
  elif [[ -f "$guide" ]]; then
    run rm -f "$guide"
    log_success "Removed $guide"
  fi
}

# ── Pi removal ───────────────────────────────────────────────────────────────

remove_pi() {
  local config="$PI_CONFIG_DIR/mcp.json"

  if [[ -f "$config" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would remove recall-memory from $config"
    else
      CONFIG_PATH="$config" bun -e '
        const fs = require("fs");
        const path = process.env.CONFIG_PATH;
        let raw = fs.readFileSync(path, "utf-8")
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        const cfg = JSON.parse(raw);
        if (cfg.mcpServers && cfg.mcpServers["recall-memory"]) {
          delete cfg.mcpServers["recall-memory"];
          if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
        }
        fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
      '
      log_success "Removed recall-memory from $config"
    fi
  fi

  local ext_dir="$PI_CONFIG_DIR/extensions"
  local guide="$PI_CONFIG_DIR/Recall_GUIDE.md"
  local agents_md="$PI_CONFIG_DIR/AGENTS.md"

  local e
  for e in RecallExtract.ts RecallPreCompact.ts; do
    local ef="$ext_dir/$e"
    if [[ -L "$ef" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [dry-run] would unlink Recall-managed symlink: $ef"
      else
        recall_unlink_if_managed "$ef"
      fi
      log_success "Removed Pi extension symlink: $e"
    elif [[ -f "$ef" ]]; then
      run rm -f "$ef"
      log_success "Removed Pi extension: $e"
    fi
  done
  if [[ -L "$guide" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would unlink Recall-managed symlink: $guide"
    else
      recall_unlink_if_managed "$guide"
    fi
    log_success "Removed $guide"
  elif [[ -f "$guide" ]]; then
    run rm -f "$guide"
    log_success "Removed $guide"
  fi

  remove_memory_section "$agents_md"
}

# ── Purge ────────────────────────────────────────────────────────────────────

do_purge() {
  # Snapshot every Recall-owned DB we can find before destroying it. Then
  # remove the install root entirely (preserving the pre_purge_ snapshot
  # under $BACKUP_BASE/pre_purge_$TIMESTAMP/, which lives outside the tree
  # we're about to delete since we capture it first).
  local pre_purge_dir="$BACKUP_BASE/pre_purge_$TIMESTAMP"

  # Snapshot canonical DB + sidecars (new layout).
  local canonical_db="$RECALL_DIR/recall.db"
  if [[ -f "$canonical_db" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would snapshot $canonical_db to $pre_purge_dir/"
    else
      mkdir -p "$pre_purge_dir"
      cp "$canonical_db" "$pre_purge_dir/recall.db"
      for ext in -wal -shm; do
        [[ -f "${canonical_db}${ext}" ]] && cp "${canonical_db}${ext}" "$pre_purge_dir/recall.db${ext}"
      done
      log_success "Snapshotted recall.db to $pre_purge_dir/"
    fi
  fi

  # Snapshot legacy DB + sidecars if still present (pre-migration installs).
  local legacy_db="$CLAUDE_DIR/memory.db"
  if [[ -f "$legacy_db" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would snapshot $legacy_db to $pre_purge_dir/"
    else
      mkdir -p "$pre_purge_dir"
      cp "$legacy_db" "$pre_purge_dir/memory.db"
      for ext in -wal -shm; do
        [[ -f "${legacy_db}${ext}" ]] && cp "${legacy_db}${ext}" "$pre_purge_dir/memory.db${ext}"
      done
      log_success "Snapshotted legacy memory.db to $pre_purge_dir/"
      run rm -f "$legacy_db" "${legacy_db}-wal" "${legacy_db}-shm"
      log_success "Removed legacy DB at $legacy_db"
    fi
  fi

  # Wipe the install root, but preserve the pre_purge snapshot we just made.
  # Easiest: move snapshot out of $BACKUP_BASE before rm -rf, restore after.
  if [[ -d "$RECALL_DIR" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would rm -rf $RECALL_DIR (keeping $pre_purge_dir)"
    else
      local snapshot_holding=""
      if [[ -d "$pre_purge_dir" ]]; then
        snapshot_holding="${TMPDIR:-/tmp}/recall-pre-purge-$TIMESTAMP"
        mv "$pre_purge_dir" "$snapshot_holding"
      fi
      rm -rf "$RECALL_DIR"
      log_success "Removed install root: $RECALL_DIR"
      if [[ -n "$snapshot_holding" ]] && [[ -d "$snapshot_holding" ]]; then
        mkdir -p "$BACKUP_BASE"
        mv "$snapshot_holding" "$pre_purge_dir"
        log_info "Preserved snapshot at: $pre_purge_dir"
      fi
    fi
  fi

  # Legacy backup tree cleanup. If $BACKUP_BASE lives outside $RECALL_DIR
  # (which it does on pre-migration installs whose backups stayed under
  # $CLAUDE_DIR/backups/recall/, or whenever the user/tests override
  # BACKUP_BASE), remove the sibling snapshots — but not the pre_purge
  # snapshot we just wrote.
  if [[ -d "$BACKUP_BASE" ]] && [[ "$BACKUP_BASE" != "$RECALL_DIR/backups" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would rm legacy backups in $BACKUP_BASE (except pre_purge_$TIMESTAMP)"
    else
      local dir
      for dir in "$BACKUP_BASE"/*/; do
        [[ ! -d "$dir" ]] && continue
        [[ "$(basename "$dir")" == "pre_purge_$TIMESTAMP" ]] && continue
        rm -rf "$dir"
      done
      [[ -f "$BACKUP_BASE/latest" ]] && rm -f "$BACKUP_BASE/latest"
      log_success "Cleared legacy backup snapshots in $BACKUP_BASE"
    fi
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  print_summary
  confirm_or_exit
  confirm_purge_or_exit

  echo ""
  log_info "Removing slash commands..."
  remove_slash_commands
  echo ""

  log_info "Removing guide..."
  remove_guide
  echo ""

  log_info "Removing Claude Code MCP registration..."
  unregister_claude_mcp_cli
  filter_claude_settings
  echo ""

  log_info "Removing hook files..."
  remove_hook_files
  remove_extract_prompt_if_unmodified
  echo ""

  log_info "Removing CLAUDE.md MEMORY section..."
  remove_memory_section "$CLAUDE_DIR/CLAUDE.md"
  echo ""

  if [[ "$SKIP_OPENCODE" != "true" ]]; then
    log_info "Removing OpenCode integration..."
    remove_opencode
    echo ""
  fi

  if [[ "$SKIP_PI" != "true" ]]; then
    log_info "Removing Pi integration..."
    remove_pi
    echo ""
  fi

  log_info "Unlinking global binaries..."
  run_bun_unlink
  echo ""

  if [[ "$PURGE" == "true" ]]; then
    log_info "Purging install root + databases..."
    do_purge
    echo ""
  fi

  _banner success "Uninstall Complete"
  echo ""
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "Dry-run: no files were modified."
  else
    log_success "Recall uninstalled successfully."
    echo ""
    if [[ "$PURGE" != "true" ]]; then
      echo "Preserved (remove manually if desired):"
      echo "  • ~/.agents/Recall/ (DB, canonical files, backups)"
      echo "  • ~/.claude/memory.db (legacy DB if not migrated)"
      echo "  • ~/.claude/MEMORY/ (non-Recall artifacts)"
    else
      echo "Preserved:"
      echo "  • Pre-purge snapshot at $BACKUP_BASE/pre_purge_$TIMESTAMP/"
      echo "  • ~/.claude/MEMORY/ (non-Recall artifacts only — our symlinks were removed)"
    fi
    echo "  • Source directory at $SCRIPT_DIR (remove with: rm -rf $SCRIPT_DIR)"
  fi
  echo ""
}

main
