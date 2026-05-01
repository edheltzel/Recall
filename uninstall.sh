#!/bin/bash
#
# Recall Uninstall Script
#
# Removes Recall integration from Claude Code, OpenCode, and Pi. By default
# preserves user data (memory.db, identity.md, ~/.claude/MEMORY/ tree, and
# ~/.claude/backups/recall/). Use --purge to destroy everything.
#
# Usage:
#   ./uninstall.sh                  # preserve-everything default
#   ./uninstall.sh --dry-run        # show what would change, touch nothing
#   ./uninstall.sh --purge          # also destroy memory.db + backup tree
#   ./uninstall.sh --no-confirm     # non-interactive; prints what was removed
#   ./uninstall.sh --skip-opencode  # leave OpenCode integration alone
#   ./uninstall.sh --skip-pi        # leave Pi integration alone
#   ./uninstall.sh --help           # show this help
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
  "$CLAUDE_DIR/hooks/SessionExtract.ts"
  "$CLAUDE_DIR/hooks/BatchExtract.ts"
  "$CLAUDE_DIR/hooks/TelosSync.ts"
  "$CLAUDE_DIR/hooks/SessionRecall.ts"
  "$CLAUDE_DIR/hooks/SessionPreCompact.ts"
)

RECALL_HOOK_LIB_FILES=(
  "$CLAUDE_DIR/hooks/lib/extraction-lock.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-migration.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-quality.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-semaphore.ts"
  "$CLAUDE_DIR/hooks/lib/extraction-tracker.ts"
  "$CLAUDE_DIR/hooks/lib/pid-utils.ts"
)

RECALL_HOOK_NAMES=(SessionExtract TelosSync SessionRecall SessionPreCompact)

# ── Summary + confirmation ───────────────────────────────────────────────────

print_summary() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║                     Recall UNINSTALL                       ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "Mode: $([[ "$DRY_RUN" == "true" ]] && echo "DRY-RUN (no changes)" || echo "LIVE")"
  [[ "$PURGE" == "true" ]] && echo "Purge: YES (will destroy memory.db + backup tree)"
  [[ "$SKIP_OPENCODE" == "true" ]] && echo "Skipping: OpenCode"
  [[ "$SKIP_PI" == "true" ]] && echo "Skipping: Pi"
  echo ""
  echo "Will REMOVE:"
  echo "  • ~/.claude/commands/Recall/ (and legacy ~/.claude/commands/recall/)"
  echo "  • ~/.claude/Recall_GUIDE.md"
  echo "  • Recall hook entries in ~/.claude/settings.json"
  echo "  • Recall mcpServers entry in ~/.claude/settings.json"
  echo "  • ~/.claude/hooks/{SessionExtract,BatchExtract,TelosSync,SessionRecall,SessionPreCompact}.ts"
  echo "  • ~/.claude/hooks/lib/{extraction-*,pid-utils}.ts (Recall-owned only)"
  echo "  • ## MEMORY section in ~/.claude/CLAUDE.md (preserves everything else)"
  echo "  • ~/.claude/MEMORY/extract_prompt.md (only if unmodified vs source)"
  [[ "$SKIP_OPENCODE" != "true" ]] && echo "  • OpenCode MCP entry + plugins"
  [[ "$SKIP_PI" != "true" ]] && echo "  • Pi MCP entry + extensions + AGENTS.md MEMORY section"
  echo "  • bun unlink (removes mem/mem-mcp from PATH)"
  echo ""
  if [[ "$PURGE" == "true" ]]; then
    echo "Will DESTROY (--purge):"
    echo "  • ~/.claude/memory.db  (your persistent memory database)"
    echo "  • ~/.claude/backups/recall/  (all backup snapshots)"
    echo ""
  fi
  echo "Will PRESERVE:"
  if [[ "$PURGE" != "true" ]]; then
    echo "  • ~/.claude/memory.db"
    echo "  • ~/.claude/backups/recall/"
  fi
  echo "  • ~/.claude/MEMORY/ (identity.md, DISTILLED.md, session subdirs)"
  echo "  • This source directory (remove with: rm -rf $SCRIPT_DIR)"
  echo ""
}

confirm_or_exit() {
  if [[ "$NO_CONFIRM" == "true" ]] || [[ "$DRY_RUN" == "true" ]]; then
    return
  fi
  read -p "Proceed? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
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
    if [[ -f "$f" ]]; then
      run rm -f "$f"
      removed=$((removed + 1))
    fi
  done
  log_success "Removed $removed Recall hook file(s) (surgical — other hooks/lib/ files untouched)"

  if [[ -d "$CLAUDE_DIR/hooks/lib" ]] && [[ -z "$(ls -A "$CLAUDE_DIR/hooks/lib" 2>/dev/null)" ]]; then
    run rmdir "$CLAUDE_DIR/hooks/lib"
  fi
}

# Diff-check: only remove extract_prompt.md if it matches the source exactly.
remove_extract_prompt_if_unmodified() {
  local installed="$CLAUDE_DIR/MEMORY/extract_prompt.md"
  local source_file="$SCRIPT_DIR/hooks/extract_prompt.md"

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
  # `mem` and the recall-memory MCP server on the host.
  if [[ "${RECALL_SKIP_BUN_UNLINK:-false}" == "true" ]]; then
    log_info "Skipping bun unlink (RECALL_SKIP_BUN_UNLINK=true)"
    return
  fi

  if command -v bun &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would run: bun unlink"
    else
      bun unlink 2>/dev/null || true
      log_success "bun unlink (mem, mem-mcp)"
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
  for p in recall-extract.ts recall-compaction.ts; do
    if [[ -f "$plugin_dir/$p" ]]; then
      run rm -f "$plugin_dir/$p"
      log_success "Removed OpenCode plugin: $p"
    fi
  done
  if [[ -f "$agent_dir/recall-memory.md" ]]; then
    run rm -f "$agent_dir/recall-memory.md"
    log_success "Removed OpenCode agent: recall-memory.md"
  fi
  if [[ -f "$guide" ]]; then
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
  for e in recall-extract.ts recall-compaction.ts; do
    if [[ -f "$ext_dir/$e" ]]; then
      run rm -f "$ext_dir/$e"
      log_success "Removed Pi extension: $e"
    fi
  done
  if [[ -f "$guide" ]]; then
    run rm -f "$guide"
    log_success "Removed $guide"
  fi

  remove_memory_section "$agents_md"
}

# ── Purge ────────────────────────────────────────────────────────────────────

do_purge() {
  local db="$CLAUDE_DIR/memory.db"
  if [[ -f "$db" ]]; then
    local pre_purge_dir="$BACKUP_BASE/pre_purge_$TIMESTAMP"
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would snapshot $db to $pre_purge_dir/memory.db"
      echo "  [dry-run] would rm $db"
    else
      mkdir -p "$pre_purge_dir"
      cp "$db" "$pre_purge_dir/memory.db"
      log_success "Snapshotted memory.db to $pre_purge_dir/memory.db"
      rm -f "$db"
      log_success "Removed $db"
    fi
  fi

  if [[ -d "$BACKUP_BASE" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [dry-run] would rm -rf $BACKUP_BASE (except pre_purge snapshot)"
    else
      local dir
      for dir in "$BACKUP_BASE"/*/; do
        [[ ! -d "$dir" ]] && continue
        [[ "$(basename "$dir")" == "pre_purge_$TIMESTAMP" ]] && continue
        rm -rf "$dir"
      done
      [[ -f "$BACKUP_BASE/latest" ]] && rm -f "$BACKUP_BASE/latest"
      log_success "Cleared $BACKUP_BASE (kept pre_purge_$TIMESTAMP snapshot)"
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
    log_info "Purging memory.db + backups..."
    do_purge
    echo ""
  fi

  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║                   UNINSTALL COMPLETE                    ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "Dry-run: no files were modified."
  else
    log_success "Recall uninstalled successfully."
    echo ""
    if [[ "$PURGE" != "true" ]]; then
      echo "Preserved (remove manually if desired):"
      echo "  • ~/.claude/memory.db"
      echo "  • ~/.claude/backups/recall/"
      echo "  • ~/.claude/MEMORY/"
    else
      echo "Preserved:"
      echo "  • ~/.claude/MEMORY/ (identity.md, DISTILLED.md, session subdirs)"
      echo "  • pre-purge snapshot at $BACKUP_BASE/pre_purge_$TIMESTAMP/"
    fi
    echo "  • Source directory at $SCRIPT_DIR (remove with: rm -rf $SCRIPT_DIR)"
  fi
  echo ""
}

main
