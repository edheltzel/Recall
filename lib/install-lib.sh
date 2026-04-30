#!/bin/bash
#
# Recall — shared install/update/uninstall library
#
# Sourced by install.sh, update.sh, and uninstall.sh. Every function prefixed
# with `recall_` to avoid collisions when another script sources this and also
# defines its own helpers.
#
# Environment assumptions:
#   - Globals (CLAUDE_DIR, BACKUP_BASE, TIMESTAMP, BACKUP_DIR, RECALL_OS, etc.)
#     are set with safe defaults here; callers may override BEFORE sourcing.
#   - Log helpers (log_info/log_success/log_warn/log_error) are defined only
#     if the caller hasn't already — lets tests stub them with no-ops.
#
# Behavior contract: every function is idempotent. Re-running install/update
# must always converge on the same settings.json / hooks / CLAUDE.md state.
#

# ── Globals ──────────────────────────────────────────────────────────────────

: "${CLAUDE_DIR:=$HOME/.claude}"
: "${BACKUP_BASE:=$CLAUDE_DIR/backups/recall}"
: "${TIMESTAMP:=$(date +%Y%m%d_%H%M%S)}"
: "${BACKUP_DIR:=$BACKUP_BASE/$TIMESTAMP}"

# Colors — defined only when stdout is a TTY (so curl|bash, CI, and piped
# output stay clean). Tests can override by exporting RED/GREEN/etc. before
# sourcing — those overrides win because of the := default operator.
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" != "1" ]]; then
  : "${RED:=$'\033[0;31m'}"
  : "${GREEN:=$'\033[0;32m'}"
  : "${YELLOW:=$'\033[1;33m'}"
  : "${BLUE:=$'\033[0;34m'}"
  : "${CYAN:=$'\033[0;36m'}"
  : "${MAGENTA:=$'\033[0;35m'}"
  : "${BOLD:=$'\033[1m'}"
  : "${DIM:=$'\033[2m'}"
  : "${NC:=$'\033[0m'}"
else
  : "${RED:=}"
  : "${GREEN:=}"
  : "${YELLOW:=}"
  : "${BLUE:=}"
  : "${CYAN:=}"
  : "${MAGENTA:=}"
  : "${BOLD:=}"
  : "${DIM:=}"
  : "${NC:=}"
fi

# Step counter — set STEP_TOTAL up front in install.sh, _step() increments STEP_NUM
: "${STEP_NUM:=0}"
: "${STEP_TOTAL:=0}"

# OS detection (populated by recall_detect_os; can be overridden in tests)
: "${RECALL_OS:=}"

# Platform configuration
: "${OPENCODE_CONFIG_DIR:=${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
: "${PI_CONFIG_DIR:=$HOME/.pi/agent}"

# Platform detection flags (populated by recall_detect_platforms,
# possibly cleared again by recall_select_platforms when the user opts out)
: "${CLAUDE_CODE_DETECTED:=false}"
: "${OPENCODE_DETECTED:=false}"
: "${PI_DETECTED:=false}"

# When true, recall_select_platforms / _confirm skip their interactive prompts.
# Set via install.sh --yes / -y, or implicitly when stdin is not a TTY.
: "${NO_CONFIRM:=false}"


# Files that install.sh / update.sh back up before modifying
if [[ -z "${FILES_TO_BACKUP+x}" ]]; then
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
fi

# ── Log helpers (respect pre-existing definitions) ───────────────────────────
#
# Glyph-prefixed status lines, inspired by Starship's installer. Each level
# has a distinct character + color; the prefix is single-glyph so the rest of
# the line reads as natural prose.
#
#   →  info       (blue)    routine progress
#   ✓  success    (green)   step completed
#   ⚠  warn       (yellow)  non-fatal degradation
#   ✗  error      (red)     fatal; exit imminent
#

if ! declare -F log_info >/dev/null 2>&1; then
  log_info() { printf '%b→%b %s\n' "$BLUE" "$NC" "$1"; }
fi
if ! declare -F log_success >/dev/null 2>&1; then
  log_success() { printf '%b✓%b %s\n' "$GREEN" "$NC" "$1"; }
fi
if ! declare -F log_warn >/dev/null 2>&1; then
  log_warn() { printf '%b⚠%b %s\n' "$YELLOW" "$NC" "$1"; }
fi
if ! declare -F log_error >/dev/null 2>&1; then
  log_error() { printf '%b✗%b %s\n' "$RED" "$NC" "$1" >&2; }
fi

# _step "verb" "detail" — render a numbered step with right-aligned 12-char
# verb in bold green and a detail string. Increments STEP_NUM. Volta-inspired.
#
#   [3/9]   Installing  bun dependencies
#
if ! declare -F _step >/dev/null 2>&1; then
  _step() {
    STEP_NUM=$((STEP_NUM + 1))
    local verb="${1:-}"
    local detail="${2:-}"
    if [[ "$STEP_TOTAL" -gt 0 ]]; then
      printf '\n%b[%d/%d]%b %b%12s%b  %s\n' \
        "$DIM" "$STEP_NUM" "$STEP_TOTAL" "$NC" \
        "${BOLD}${GREEN}" "$verb" "$NC" "$detail"
    else
      printf '\n%b%12s%b  %s\n' "${BOLD}${GREEN}" "$verb" "$NC" "$detail"
    fi
  }
fi

# ── Captured-output runner ──────────────────────────────────────────────────
#
# _run_quiet "label" command [args...] — runs command with stdout+stderr
# redirected to RECALL_INSTALL_LOG (default /tmp/recall-install.log). Renders
# a single status line that flips from "→ label..." to "✓ label (Ns)" on
# success or "✗ label (exit N)" + the last 10 log lines on failure.
#
# Set RECALL_VERBOSE=1 to bypass capture entirely (stdout passthrough).
#
: "${RECALL_INSTALL_LOG:=/tmp/recall-install.log}"

if ! declare -F _run_quiet >/dev/null 2>&1; then
  _run_quiet() {
    local label="${1:-running}"
    shift
    local logfile="$RECALL_INSTALL_LOG"

    if [[ "${RECALL_VERBOSE:-0}" == "1" ]]; then
      printf '  %b→%b  %s\n' "$BLUE" "$NC" "$label"
      "$@"
      return $?
    fi

    : >"$logfile" || logfile=/dev/null
    local start_ts
    start_ts=$(date +%s)
    printf '  %b→%b  %s' "$BLUE" "$NC" "$label"

    if "$@" >>"$logfile" 2>&1; then
      local elapsed=$(( $(date +%s) - start_ts ))
      printf '\r  %b✓%b  %s %b(%ds)%b\n' "$GREEN" "$NC" "$label" "$DIM" "$elapsed" "$NC"
      return 0
    else
      local rc=$?
      local elapsed=$(( $(date +%s) - start_ts ))
      printf '\r  %b✗%b  %s %b(exit %d, %ds)%b\n' "$RED" "$NC" "$label" "$RED" "$rc" "$elapsed" "$NC"
      if [[ -s "$logfile" ]]; then
        echo ""
        printf '  %blast 10 lines of %s:%b\n' "$DIM" "$logfile" "$NC"
        tail -n 10 "$logfile" | sed 's/^/    /'
      fi
      return "$rc"
    fi
  }
fi

# ── Gum integration ─────────────────────────────────────────────────────────
#
# Charmbracelet's gum gives us animated spinners, multi-select pickers, and
# styled banners — but it's an optional Go binary, not a hard dep. The flow:
#
#   1. _detect_gum()       — sets HAS_GUM=true|false based on what's present.
#   2. _try_install_gum()  — attempts brew (mac) then GitHub release binary.
#                            30s timeout per path; silent failure → bash mode.
#   3. _confirm/_choose/_spin/_style/_banner wrappers branch on $HAS_GUM.
#
# Opt-out: set RECALL_NO_GUM=1 or pass --no-gum. We never install gum without
# explicit consent given by the user running install.sh.
#
# Required minimum gum version: 0.14 (released 2024-09; first stable spin API).

: "${HAS_GUM:=}"
: "${RECALL_NO_GUM:=0}"
: "${RECALL_GUM_MIN_MAJOR:=0}"
: "${RECALL_GUM_MIN_MINOR:=14}"

_detect_gum() {
  if [[ "$RECALL_NO_GUM" == "1" ]]; then
    HAS_GUM=false
    return 0
  fi
  if ! command -v gum &>/dev/null; then
    HAS_GUM=false
    return 1
  fi
  local v major minor
  v=$(gum --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [[ -z "$v" ]]; then
    HAS_GUM=false
    return 1
  fi
  major=${v%%.*}
  minor=${v#*.}; minor=${minor%%.*}
  if (( major > RECALL_GUM_MIN_MAJOR )) || \
     (( major == RECALL_GUM_MIN_MAJOR && minor >= RECALL_GUM_MIN_MINOR )); then
    HAS_GUM=true
    return 0
  fi
  HAS_GUM=false
  return 1
}

# Auto-install fallback chain. Each path is timeout-bounded; on any failure
# (including timeout), falls through. After exhausting paths, HAS_GUM stays
# false and the install continues in bash mode.
_try_install_gum() {
  if [[ "$RECALL_NO_GUM" == "1" ]]; then
    HAS_GUM=false
    return 0
  fi

  # Already installed and meets minimum?
  if _detect_gum; then return 0; fi

  # brew on macOS
  if [[ "$RECALL_OS" == "macos" ]] && command -v brew &>/dev/null; then
    if _run_quiet "Installing gum via brew" \
       bash -c 'timeout 30 brew install gum >/dev/null 2>&1'; then
      _detect_gum && return 0
    fi
  fi

  # GitHub release binary — universal fallback
  if _run_quiet "Installing gum from GitHub releases" _install_gum_binary; then
    # Make sure the new binary is on PATH for this session
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *) export PATH="$HOME/.local/bin:$PATH" ;;
    esac
    _detect_gum && return 0
  fi

  HAS_GUM=false
  return 1
}

_install_gum_binary() {
  local os arch version asset
  case "$(uname -s)" in
    Darwin) os="Darwin" ;;
    Linux)  os="Linux" ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x86_64" ;;
    *) return 1 ;;
  esac

  # Discover latest version. Cap at 10s — we don't want to block the install.
  version=$(timeout 10 curl -fsSL \
    "https://api.github.com/repos/charmbracelet/gum/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [[ -z "$version" ]] && return 1

  asset="gum_${version}_${os}_${arch}.tar.gz"
  local dl="https://github.com/charmbracelet/gum/releases/download/v${version}/${asset}"
  local sumurl="https://github.com/charmbracelet/gum/releases/download/v${version}/checksums.txt"

  local tmpdir
  tmpdir=$(mktemp -d 2>/dev/null) || return 1

  if ! timeout 25 curl -fsSL "$dl" -o "$tmpdir/$asset" 2>/dev/null; then
    rm -rf "$tmpdir"
    return 1
  fi

  # SHA256 verify (best-effort: skip if checksum file unreachable)
  if timeout 10 curl -fsSL "$sumurl" -o "$tmpdir/checksums.txt" 2>/dev/null; then
    local expected actual
    expected=$(grep "  $asset\$" "$tmpdir/checksums.txt" 2>/dev/null | awk '{print $1}' | head -1)
    if [[ -n "$expected" ]]; then
      if command -v shasum &>/dev/null; then
        actual=$(shasum -a 256 "$tmpdir/$asset" | awk '{print $1}')
      elif command -v sha256sum &>/dev/null; then
        actual=$(sha256sum "$tmpdir/$asset" | awk '{print $1}')
      fi
      if [[ -n "$actual" ]] && [[ "$expected" != "$actual" ]]; then
        log_warn "gum checksum mismatch — refusing to install (expected $expected, got $actual)"
        rm -rf "$tmpdir"
        return 1
      fi
    fi
  fi

  if ! tar xzf "$tmpdir/$asset" -C "$tmpdir" 2>/dev/null; then
    rm -rf "$tmpdir"
    return 1
  fi

  # The release tarball extracts into a versioned subdir; the binary may
  # also be at the tarball root depending on Charm's packaging.
  local bin
  bin=$(find "$tmpdir" -name gum -type f -perm -u+x 2>/dev/null | head -1)
  if [[ -z "$bin" ]]; then
    bin=$(find "$tmpdir" -name gum -type f 2>/dev/null | head -1)
  fi
  if [[ -z "$bin" ]] || [[ ! -f "$bin" ]]; then
    rm -rf "$tmpdir"
    return 1
  fi

  mkdir -p "$HOME/.local/bin"
  cp "$bin" "$HOME/.local/bin/gum"
  chmod +x "$HOME/.local/bin/gum"
  rm -rf "$tmpdir"
  return 0
}

# ── UX wrapper functions ────────────────────────────────────────────────────
#
# Every interactive primitive routes through one of these. Each branches on
# $HAS_GUM. Bash fallbacks are cyan-1.x compatible: glyphs, gated colors,
# captured stdout for slow ops.

# _confirm "question" [default=Y]
# Returns 0 for yes, 1 for no. Honors NO_CONFIRM=true (bypasses prompt and
# returns the default).
_confirm() {
  local q="${1:-Continue?}"
  local default="${2:-Y}"

  if [[ "${NO_CONFIRM:-}" == "true" ]] || [[ ! -t 0 ]]; then
    [[ "$default" == "Y" ]] && return 0 || return 1
  fi

  if [[ "$HAS_GUM" == "true" ]]; then
    if [[ "$default" == "Y" ]]; then
      gum confirm --default=true "$q"
    else
      gum confirm --default=false "$q"
    fi
    return $?
  fi

  local prompt
  if [[ "$default" == "Y" ]]; then prompt="$q [Y/n] "; else prompt="$q [y/N] "; fi
  read -p "$prompt" -r
  if [[ "$default" == "Y" ]]; then
    [[ "$REPLY" =~ ^[Nn] ]] && return 1 || return 0
  else
    [[ "$REPLY" =~ ^[Yy] ]] && return 0 || return 1
  fi
}

# _choose "title" "opt1" "opt2" ... — multi-select picker.
# Prints selected options to stdout, one per line. NO_CONFIRM/non-TTY selects
# all options.
_choose() {
  local title="${1:-Select}"
  shift
  if [[ $# -eq 0 ]]; then return 0; fi

  if [[ "${NO_CONFIRM:-}" == "true" ]] || [[ ! -t 0 ]]; then
    printf '%s\n' "$@"
    return 0
  fi

  if [[ "$HAS_GUM" == "true" ]]; then
    local selected=""
    selected=$(IFS=,; echo "$*")
    gum choose --no-limit --selected="$selected" --header="$title" "$@"
    return $?
  fi

  # Bash fallback: per-option Y/n
  printf '%b→%b %s\n' "$BLUE" "$NC" "$title"
  local opt
  for opt in "$@"; do
    read -p "    Configure $opt? [Y/n] " -r
    if [[ ! "$REPLY" =~ ^[Nn] ]]; then
      echo "$opt"
    fi
  done
}

# _spin "label" -- command [args...]
# gum: animated spinner around the command. bash fallback: _run_quiet's
# captured-output path.
_spin() {
  local label="${1:-Working...}"
  shift
  [[ "${1:-}" == "--" ]] && shift

  if [[ "$HAS_GUM" == "true" ]] && [[ -t 1 ]]; then
    if gum spin --spinner dot --title "$label" --show-output -- "$@" \
        >>"$RECALL_INSTALL_LOG" 2>&1; then
      printf '  %b✓%b  %s\n' "$GREEN" "$NC" "$label"
      return 0
    else
      local rc=$?
      printf '  %b✗%b  %s %b(exit %d)%b\n' "$RED" "$NC" "$label" "$RED" "$rc" "$NC"
      tail -n 10 "$RECALL_INSTALL_LOG" 2>/dev/null | sed 's/^/    /'
      return "$rc"
    fi
  fi

  _run_quiet "$label" "$@"
}

# _style "text" — render a styled bordered text block.
_style() {
  local text="${1:-}"
  if [[ "$HAS_GUM" == "true" ]]; then
    gum style --border rounded --padding "1 2" --foreground 214 "$text"
    return 0
  fi
  printf '%b┌─%b %s\n%b└──%b\n' "$YELLOW" "$NC" "$text" "$YELLOW" "$NC"
}

# _banner <tone> "title" [subtitle ...]
#
#   tone: info | success | warn | error (controls border color)
#
# gum: rounded styled box. bash: 60-col ASCII box matching cyan-1.3 width.
_banner() {
  local tone="${1:-info}"
  shift
  local title="${1:-}"
  shift
  local ansi gum_color
  case "$tone" in
    success) ansi="$GREEN";  gum_color=46  ;;
    warn)    ansi="$BLUE";   gum_color=39  ;;
    error)   ansi="$RED";    gum_color=196 ;;
    info|*)  ansi="$YELLOW"; gum_color=214 ;;
  esac

  if [[ "$HAS_GUM" == "true" ]]; then
    if [[ $# -gt 0 ]]; then
      gum style --border double --padding "1 4" --align center \
                --width 60 --foreground "$gum_color" --border-foreground "$gum_color" \
                "$title" "$@"
    else
      gum style --border double --padding "1 4" --align center \
                --width 60 --foreground "$gum_color" --border-foreground "$gum_color" \
                "$title"
    fi
    return 0
  fi

  printf '%b╔══════════════════════════════════════════════════════════╗%b\n' "$ansi" "$NC"
  _banner_line "$ansi" "$title"
  local line
  for line in "$@"; do
    _banner_line "$ansi" "$line"
  done
  printf '%b╚══════════════════════════════════════════════════════════╝%b\n' "$ansi" "$NC"
}

_banner_line() {
  local color="${1:-}"
  local text="${2:-}"
  local width=58
  local plen=${#text}
  if (( plen > width )); then
    text="${text:0:$width}"
    plen=$width
  fi
  local left=$(( (width - plen) / 2 ))
  local right=$(( width - plen - left ))
  printf '%b║%b%*s%s%*s%b║%b\n' "$color" "$NC" "$left" "" "$text" "$right" "" "$color" "$NC"
}

# ── OS detection ─────────────────────────────────────────────────────────────

recall_detect_os() {
  case "$(uname -s)" in
  Darwin) RECALL_OS="macos" ;;
  Linux) RECALL_OS="linux" ;;
  *) RECALL_OS="unknown" ;;
  esac
}

# ── Prerequisites check ──────────────────────────────────────────────────────

recall_check_prerequisites() {
  local missing=()

  command -v node &>/dev/null || missing+=("node")
  command -v bun &>/dev/null || missing+=("bun")
  command -v npm &>/dev/null || missing+=("npm")

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Missing prerequisites: ${missing[*]}"
    echo ""
    if [[ "$RECALL_OS" == "macos" ]]; then
      echo "Install on macOS:"
      for dep in "${missing[@]}"; do
        case "$dep" in
        node | npm) echo "  brew install node" ;;
        bun) echo "  brew install oven-sh/bun/bun" ;;
        esac
      done
    elif [[ "$RECALL_OS" == "linux" ]]; then
      echo "Install on Linux:"
      for dep in "${missing[@]}"; do
        case "$dep" in
        node | npm) echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" ;;
        bun) echo "  curl -fsSL https://bun.sh/install | bash && source ~/.bashrc" ;;
        esac
      done
    else
      echo "Please install the missing tools first. See README.md."
    fi
    return 1
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

  # Soft warning if Claude Code CLI is missing (used for session extraction)
  if ! command -v claude &>/dev/null; then
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

# ── Platform detection ───────────────────────────────────────────────────────

recall_detect_platforms() {
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

  if [[ "$CLAUDE_CODE_DETECTED" == "false" ]] \
    && [[ "$OPENCODE_DETECTED" == "false" ]] \
    && [[ "$PI_DETECTED" == "false" ]]; then
    log_warn "No coding agents detected (Claude Code, OpenCode, Pi)"
    log_info "Recall will install core tools. Configure MCP manually later."
  fi
}

# ── Interactive platform selection ───────────────────────────────────────────
#
# Asks the user which detected agents should actually be configured. Uses
# the _choose wrapper — gum multi-select picker if available, bash Y/n loop
# otherwise. Skipped entirely when NO_CONFIRM=true or stdin is not a TTY.
recall_select_platforms() {
  if [[ "$NO_CONFIRM" == "true" ]] || [[ ! -t 0 ]]; then
    return 0
  fi

  local options=()
  [[ "$CLAUDE_CODE_DETECTED" == "true" ]] && options+=("Claude Code")
  [[ "$OPENCODE_DETECTED" == "true" ]] && options+=("OpenCode")
  [[ "$PI_DETECTED" == "true" ]] && options+=("Pi")

  if [[ ${#options[@]} -eq 0 ]]; then
    return 0
  fi

  local selected
  selected=$(_choose "Select which agents to configure" "${options[@]}")

  local was_cc="$CLAUDE_CODE_DETECTED"
  local was_oc="$OPENCODE_DETECTED"
  local was_pi="$PI_DETECTED"
  CLAUDE_CODE_DETECTED=false
  OPENCODE_DETECTED=false
  PI_DETECTED=false
  while IFS= read -r line; do
    case "$line" in
      "Claude Code") [[ "$was_cc" == "true" ]] && CLAUDE_CODE_DETECTED=true ;;
      "OpenCode")    [[ "$was_oc" == "true" ]] && OPENCODE_DETECTED=true ;;
      "Pi")          [[ "$was_pi" == "true" ]] && PI_DETECTED=true ;;
    esac
  done <<<"$selected"

  if [[ "$CLAUDE_CODE_DETECTED" == "false" ]] \
    && [[ "$OPENCODE_DETECTED" == "false" ]] \
    && [[ "$PI_DETECTED" == "false" ]]; then
    log_warn "All agents skipped — Recall will install core tools only."
    log_info "Re-run ./install.sh later to configure agent integrations."
  fi
}


# ── Backup ───────────────────────────────────────────────────────────────────

recall_create_backup() {
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

  {
    echo "Recall Backup Manifest"
    echo "===================="
    echo "Timestamp: $TIMESTAMP"
    echo "Date: $(date)"
    echo "Files backed up: $backed_up"
    echo ""
    echo "To restore: ./install.sh restore $TIMESTAMP"
  } >"$BACKUP_DIR/manifest.txt"

  # Record the git SHA at backup time (used by update.sh for rollback recipes)
  local pre_sha
  if pre_sha="$(git rev-parse HEAD 2>/dev/null)"; then
    echo "PRE_SHA: $pre_sha" >>"$BACKUP_DIR/manifest.txt"
  fi

  if [[ $backed_up -eq 0 ]]; then
    log_warn "No existing files to backup (fresh install)"
  else
    log_success "Backup complete: $backed_up file(s) saved"
  fi

  echo "$TIMESTAMP" >"$BACKUP_BASE/latest"
}

recall_list_backups() {
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
      local latest_marker=""
      if [[ -f "$BACKUP_BASE/latest" ]] \
        && [[ "$(cat "$BACKUP_BASE/latest")" == "$name" ]]; then
        latest_marker=" (latest)"
      fi
      echo "  $name - $file_count file(s)$latest_marker"
    fi
  done

  echo ""
  echo "To restore: ./install.sh restore [TIMESTAMP]"
  echo "           (omit timestamp to restore latest)"
}

recall_do_restore() {
  local target_backup="$1"

  if [[ -z "$target_backup" ]]; then
    if [[ -f "$BACKUP_BASE/latest" ]]; then
      target_backup=$(cat "$BACKUP_BASE/latest")
    else
      log_error "No backups found. Nothing to restore."
      return 1
    fi
  fi

  local restore_dir="$BACKUP_BASE/$target_backup"

  if [[ ! -d "$restore_dir" ]]; then
    log_error "Backup not found: $restore_dir"
    echo ""
    echo "Available backups:"
    recall_list_backups
    return 1
  fi

  echo ""
  _banner warn "Recall Restore"
  echo ""
  log_info "Restoring from backup: $target_backup"
  echo ""

  echo "Files to restore:"
  ls -la "$restore_dir" | grep -v manifest.txt | tail -n +2
  echo ""

  if ! _confirm "Proceed with restore?" "N"; then
    log_warn "Restore cancelled"
    return 0
  fi

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

  local restored=0
  shopt -s dotglob
  for file in "$restore_dir"/*; do
    [[ ! -f "$file" ]] && continue
    local filename=$(basename "$file")
    [[ "$filename" == "manifest.txt" ]] && continue

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
  shopt -u dotglob

  echo ""
  log_success "Restore complete: $restored file(s) restored"

  log_info "Validating restored files..."
  if [[ -f "$CLAUDE_DIR/.mcp.json" ]]; then
    if MCP_FILE="$CLAUDE_DIR/.mcp.json" bun -e \
      'JSON.parse(require("fs").readFileSync(process.env.MCP_FILE))' 2>/dev/null; then
      log_success "Validated: .mcp.json is valid JSON"
    else
      log_error "Restored .mcp.json is NOT valid JSON!"
      log_warn "You may need to manually fix $CLAUDE_DIR/.mcp.json"
    fi
  fi
  if [[ -f "$CLAUDE_DIR/memory.db" ]] && command -v sqlite3 &>/dev/null; then
    if sqlite3 "$CLAUDE_DIR/memory.db" "PRAGMA integrity_check;" 2>/dev/null \
      | grep -q "ok"; then
      log_success "Validated: memory.db integrity OK"
    else
      log_warn "Could not verify memory.db integrity"
    fi
  fi

  echo ""
  log_info "If you had MCP changes, restart Claude Code to apply"
  echo ""
  echo "To undo this restore: ./install.sh restore pre_restore_$TIMESTAMP"
}

# ── MCP registration ─────────────────────────────────────────────────────────

recall_configure_mcp() {
  local mem_mcp_path bun_path
  mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"
  bun_path="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

  mkdir -p "$CLAUDE_DIR"

  if command -v claude &>/dev/null; then
    if claude mcp list 2>/dev/null | grep -q "recall-memory"; then
      log_success "MCP already configured for recall-memory"
      return
    fi

    log_info "Registering recall-memory MCP server..."
    if claude mcp add --transport stdio --scope user recall-memory -- \
      "$bun_path" "run" "$mem_mcp_path" 2>/dev/null; then
      log_success "Registered recall-memory MCP server via Claude Code CLI"
    else
      log_warn "claude mcp add failed — adding to settings.json directly"
      _recall_write_mcp_settings "$bun_path" "$mem_mcp_path"
    fi
  else
    log_warn "Claude Code CLI not found — adding recall-memory to settings.json directly"
    _recall_write_mcp_settings "$bun_path" "$mem_mcp_path"
  fi
}

_recall_write_mcp_settings() {
  local bun_path="$1"
  local mem_mcp_path="$2"
  local settings_file="$CLAUDE_DIR/settings.json"

  if [[ -f "$settings_file" ]] && grep -q "recall-memory" "$settings_file"; then
    log_success "recall-memory already in settings.json"
    return
  fi

  SETTINGS_FILE="$settings_file" BUN_PATH="$bun_path" MCP_PATH="$mem_mcp_path" node -e '
    const fs = require("fs");
    let config = {};
    try { config = JSON.parse(fs.readFileSync(process.env.SETTINGS_FILE, "utf8")); } catch {}
    config.mcpServers = config.mcpServers || {};
    config.mcpServers["recall-memory"] = {
      command: process.env.BUN_PATH,
      args: ["run", process.env.MCP_PATH]
    };
    fs.writeFileSync(process.env.SETTINGS_FILE, JSON.stringify(config, null, 2));
  '
  log_success "Added recall-memory to settings.json mcpServers"
}

# ── Hooks ────────────────────────────────────────────────────────────────────
#
# Hook registration is split into two concerns:
#   _recall_copy_hook_files — copies the TypeScript files + extract_prompt.md
#                             from the source repo to ~/.claude/hooks/
#   recall_register_hook    — idempotent single-hook writer for settings.json
#   recall_register_all_hooks — convenience loop that wires up all 4 hooks
#
# The PREVIOUS install.sh had a blanket early-return after finding one hook,
# which silently skipped the other three on re-install. `recall_register_hook`
# fixes that class of bug permanently: each call is self-contained.

_recall_copy_hook_files() {
  local hooks_dir="$CLAUDE_DIR/hooks"
  local src_dir="$(pwd)/hooks"

  mkdir -p "$hooks_dir"

  # SessionExtract is required; log and bail early if missing.
  if [[ ! -f "$src_dir/SessionExtract.ts" ]]; then
    log_warn "SessionExtract.ts not found in $src_dir — skipping hook setup"
    return 1
  fi

  local hook
  for hook in SessionExtract BatchExtract TelosSync SessionRecall SessionPreCompact; do
    if [[ -f "$src_dir/$hook.ts" ]]; then
      cp "$src_dir/$hook.ts" "$hooks_dir/$hook.ts"
      log_success "Copied $hook.ts to $hooks_dir"
    fi
  done

  if [[ -d "$src_dir/lib" ]]; then
    mkdir -p "$hooks_dir/lib"
    cp "$src_dir/lib/"*.ts "$hooks_dir/lib/" 2>/dev/null || true
    log_success "Copied hooks/lib/ to $hooks_dir/lib/"
  fi

  local memory_dir="$CLAUDE_DIR/MEMORY"
  mkdir -p "$memory_dir"
  if [[ -f "$src_dir/extract_prompt.md" ]]; then
    cp "$src_dir/extract_prompt.md" "$memory_dir/extract_prompt.md"
    log_success "Copied extraction prompt template to $memory_dir"
  fi
}

# recall_register_hook <event> <hook_name> <command> [timeout_ms]
#
# Registers ONE hook in settings.json if an entry for this hook name is not
# already present. `hook_name` is the substring used to detect an existing
# registration (e.g. "SessionExtract"). `event` is the settings.json key
# (Stop, SessionStart, PreCompact, UserPromptSubmit).
recall_register_hook() {
  local event="$1"
  local hook_name="$2"
  local command="$3"
  local timeout="${4:-}"
  local settings_file="$CLAUDE_DIR/settings.json"

  SETTINGS_FILE="$settings_file" \
    EVENT="$event" \
    HOOK_NAME="$hook_name" \
    COMMAND="$command" \
    TIMEOUT="$timeout" \
    bun -e '
      const fs = require("fs");
      const settingsFile = process.env.SETTINGS_FILE;
      const event = process.env.EVENT;
      const hookName = process.env.HOOK_NAME;
      const command = process.env.COMMAND;
      const timeout = process.env.TIMEOUT;

      let config = {};
      try { config = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch {}
      config.hooks = config.hooks || {};
      config.hooks[event] = config.hooks[event] || [];

      const exists = config.hooks[event].some(e =>
        e.hooks && e.hooks.some(h => h.command && h.command.includes(hookName))
      );
      if (exists) process.exit(0);

      const hookObj = { type: "command", command };
      if (timeout) hookObj.timeout = Number(timeout);
      config.hooks[event].push({ matcher: "", hooks: [hookObj] });

      fs.writeFileSync(settingsFile, JSON.stringify(config, null, 2));
    '
}

# recall_register_all_hooks
#
# Wires up all four runtime hooks that Recall ships. Each registration is
# independent — a failure in one does not prevent the others from landing.
# Always safe to re-run: hooks already present are skipped.
recall_register_all_hooks() {
  local hooks_dir="$CLAUDE_DIR/hooks"
  local bun_path
  bun_path="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

  if [[ -f "$hooks_dir/SessionExtract.ts" ]]; then
    recall_register_hook "Stop" "SessionExtract" \
      "$bun_path run $hooks_dir/SessionExtract.ts"
    log_success "Registered SessionExtract hook in settings.json"
  fi

  if [[ -f "$hooks_dir/TelosSync.ts" ]]; then
    recall_register_hook "SessionStart" "TelosSync" \
      "$bun_path run $hooks_dir/TelosSync.ts" 10000
    log_success "Registered TelosSync hook in settings.json"
  fi

  if [[ -f "$hooks_dir/SessionRecall.ts" ]]; then
    recall_register_hook "SessionStart" "SessionRecall" \
      "$bun_path run $hooks_dir/SessionRecall.ts"
    log_success "Registered SessionRecall hook (SessionStart) in settings.json"
  fi

  if [[ -f "$hooks_dir/SessionPreCompact.ts" ]]; then
    recall_register_hook "PreCompact" "SessionPreCompact" \
      "$bun_path run $hooks_dir/SessionPreCompact.ts" 10000
    log_success "Registered SessionPreCompact hook (PreCompact) in settings.json"
  fi
}

# Back-compat wrapper: preserves the `configure_hooks` entry point that older
# test harnesses awk-extract out of install.sh. New code should call
# _recall_copy_hook_files + recall_register_all_hooks directly.
configure_hooks() {
  _recall_copy_hook_files || return
  recall_register_all_hooks
}

# ── CLAUDE.md ────────────────────────────────────────────────────────────────

recall_configure_claude_md() {
  local claude_md="$CLAUDE_DIR/CLAUDE.md"

  local memory_section="## MEMORY

You have persistent memory via Recall. **Read the full guide:** $CLAUDE_DIR/Recall_GUIDE.md

A SessionStart hook automatically loads recent memory context. Review it before your first response.

Core rules:
1. **Memory-first** → Review SessionStart hook output, then search Recall before falling back to git log
2. Before asking user to repeat anything → search first with \`memory_search\` or \`memory_hybrid_search\`
3. Before spawning agents (Task tool) → call \`context_for_agent\`
4. When decisions are made → record with \`memory_add\`
5. End of session when user says \`/dump\` or \`/Recall:dump\` → call \`memory_dump({ title: \"Descriptive Title\" })\`

Context resolution order:
1. SessionStart hook output (already loaded)
2. \`memory_hybrid_search\` (keyword + semantic search)
3. \`memory_recall\` (recent LoA, decisions, breadcrumbs)
4. Native Claude memory / conversation context
5. \`git log\` / \`git show\` (last resort)

Tool syntax:
- \`memory_search({ query: \"search terms\" })\`
- \`memory_hybrid_search({ query: \"natural language question\" })\`
- \`memory_add({ type: \"decision\", content: \"what\", detail: \"why\" })\`
- \`memory_dump({ title: \"Session title\", skip_fabric: true })\`
- \`context_for_agent({ task_description: \"what the agent will do\" })\`"

  if [[ -f "$claude_md" ]]; then
    if grep -q "## MEMORY" "$claude_md"; then
      log_success "CLAUDE.md already has MEMORY section"
      return
    fi
    echo "" >>"$claude_md"
    echo "$memory_section" >>"$claude_md"
    log_success "Added MEMORY section to existing CLAUDE.md"
  else
    echo "$memory_section" >"$claude_md"
    log_success "Created CLAUDE.md with MEMORY section"
  fi
}

# ── OpenCode ─────────────────────────────────────────────────────────────────

recall_configure_opencode_mcp() {
  local config="$OPENCODE_CONFIG_DIR/opencode.json"
  local mem_mcp_path bun_path
  mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"
  bun_path="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

  local db_path_abs
  db_path_abs="$(eval echo "${MEM_DB_PATH:-$HOME/.claude/memory.db}")"

  mkdir -p "$OPENCODE_CONFIG_DIR"

  if [[ -f "$config" ]] && grep -q "recall-memory" "$config"; then
    log_success "recall-memory already registered in opencode.json"
    return
  fi

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
        environment: { MEM_DB_PATH: process.env.DB_PATH_ABS }
      };
      fs.writeFileSync(path, JSON.stringify(existing, null, 2));
    '
  log_success "Registered recall-memory MCP server in opencode.json"
}

recall_install_opencode_plugins() {
  local plugin_dir="$OPENCODE_CONFIG_DIR/plugins"
  local src_dir="$(pwd)/opencode"

  mkdir -p "$plugin_dir"

  local plugin
  for plugin in recall-extract.ts recall-compaction.ts; do
    if [[ -f "$src_dir/$plugin" ]]; then
      cp "$src_dir/$plugin" "$plugin_dir/"
      log_success "Installed $plugin plugin"
    fi
  done
}

recall_install_opencode_agent() {
  local agent_dir="$OPENCODE_CONFIG_DIR/agents"
  local src_dir="$(pwd)/opencode"

  mkdir -p "$agent_dir"

  if [[ -f "$src_dir/recall-memory.md" ]]; then
    cp "$src_dir/recall-memory.md" "$agent_dir/"
    log_success "Installed recall-memory agent definition"
  fi
}

recall_install_opencode_guide() {
  if [[ -f "$(pwd)/FOR_OPENCODE.md" ]]; then
    cp "$(pwd)/FOR_OPENCODE.md" "$OPENCODE_CONFIG_DIR/Recall_GUIDE.md"
    log_success "Installed Recall guide for OpenCode"
  fi
}

# ── Pi ───────────────────────────────────────────────────────────────────────

recall_install_pi_adapter() {
  log_info "Ensuring pi-mcp-adapter is installed..."
  if pi install npm:pi-mcp-adapter 2>/dev/null; then
    log_success "pi-mcp-adapter ready"
  else
    log_warn "Could not install pi-mcp-adapter automatically"
    log_warn "Install manually: pi install npm:pi-mcp-adapter"
  fi
}

recall_configure_pi_mcp() {
  local config="$PI_CONFIG_DIR/mcp.json"
  local db_path_abs
  db_path_abs="$(eval echo "${MEM_DB_PATH:-$HOME/.claude/memory.db}")"
  local mem_mcp_path
  mem_mcp_path="$(which mem-mcp 2>/dev/null || echo "$HOME/.bun/bin/mem-mcp")"

  mkdir -p "$PI_CONFIG_DIR"

  if [[ -f "$config" ]] && grep -q "recall-memory" "$config"; then
    log_success "recall-memory already registered in Pi mcp.json"
    return
  fi

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
        environment: { MEM_DB_PATH: process.env.DB_PATH_ABS }
      };
      fs.writeFileSync(path, JSON.stringify(existing, null, 2));
    '
  log_success "Registered recall-memory in Pi mcp.json"
}

recall_install_pi_extensions() {
  local ext_dir="$PI_CONFIG_DIR/extensions"
  local src_dir="$(pwd)/pi"

  mkdir -p "$ext_dir"

  local ext
  for ext in recall-extract.ts recall-compaction.ts; do
    if [[ -f "$src_dir/$ext" ]]; then
      cp "$src_dir/$ext" "$ext_dir/"
      log_success "Installed $ext Pi extension"
    fi
  done
}

recall_install_pi_guide() {
  mkdir -p "$PI_CONFIG_DIR"

  if [[ -f "$(pwd)/FOR_PI.md" ]]; then
    cp "$(pwd)/FOR_PI.md" "$PI_CONFIG_DIR/Recall_GUIDE.md"
    log_success "Installed Recall guide for Pi"
  fi

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
3. End of session when user says \`/dump\` → call \`recall-memory_memory_dump({ title: \"Descriptive Title\" })\`
4. Dumped sessions are immediately searchable from new sessions via \`recall-memory_memory_search\`

Tool syntax:
- \`recall-memory_memory_search({ query: \"search terms\" })\`
- \`recall-memory_memory_add({ type: \"decision\", content: \"what\", detail: \"why\" })\`
- \`recall-memory_memory_dump({ title: \"Session title\", skip_fabric: true })\`
- \`recall-memory_context_for_agent({ task_description: \"what the agent will do\" })\`"

  if [[ -f "$agents_md" ]] && [[ -s "$agents_md" ]] \
    && [[ "$(tail -c 1 "$agents_md" | wc -l)" -eq 0 ]]; then
    echo "" >>"$agents_md"
  fi
  echo "$memory_section" >>"$agents_md"
  log_success "Added MEMORY section to AGENTS.md"
}

# ── Runtime file refresh (shared between install.sh and update.sh) ───────────
#
# Copies hooks/, hooks/lib/, commands/Recall/, FOR_CLAUDE.md → Recall_GUIDE.md,
# and extract_prompt.md (with drift preservation). Called by install.sh Step 7+8b
# and update.sh Step 7 to keep runtime artifacts in sync with the source tree.

recall_copy_runtime_files() {
  _recall_copy_hook_files

  # FOR_CLAUDE.md → Recall_GUIDE.md
  if [[ -f "$(pwd)/FOR_CLAUDE.md" ]]; then
    cp "$(pwd)/FOR_CLAUDE.md" "$CLAUDE_DIR/Recall_GUIDE.md"
    log_success "Installed Recall guide at $CLAUDE_DIR/Recall_GUIDE.md"
  fi

  # Slash commands
  local commands_src="$(pwd)/commands/Recall"
  local commands_dest="$CLAUDE_DIR/commands/Recall"
  local commands_legacy="$CLAUDE_DIR/commands/recall"
  if [[ -d "$commands_src" ]]; then
    mkdir -p "$commands_dest"
    cp "$commands_src"/*.md "$commands_dest/" 2>/dev/null || true
    if [[ -d "$commands_legacy" && "$commands_legacy" != "$commands_dest" ]]; then
      rm -rf "$commands_legacy"
      log_info "Removed legacy lowercase slash commands at $commands_legacy"
    fi
    log_success "Installed Recall: slash commands to $commands_dest"
  fi
}

# ── Global link verification ─────────────────────────────────────────────────
#
# Confirm that `bun link` (or `npm link`) actually created the bin-level
# symlinks we need: ~/.bun/bin/mem and ~/.bun/bin/mem-mcp, each pointing at
# a target file that exists and is readable.
#
# 0.7.22 hardening: `bun link` without args REGISTERS the package globally and
# SHOULD create bin symlinks for package.json's `bin` entries, but if that
# symlink step silently no-ops (e.g., a race with an in-use file, an edge
# case in bun's linking semantics, or the bin dir being non-writable at the
# moment of the call), install/update would report "[OK] Re-linked" while
# the bin dir stayed stale. This function catches that failure mode.
#
# Returns 0 if both symlinks exist and resolve to readable targets; non-zero
# otherwise. Prints a diagnostic block on failure.
recall_verify_global_link() {
  local bun_bin_dir="${HOME}/.bun/bin"
  local mem_link="$bun_bin_dir/mem"
  local mcp_link="$bun_bin_dir/mem-mcp"
  local failed=0

  _recall_check_one_link() {
    local link="$1"
    local name="$2"
    if [[ ! -L "$link" ]]; then
      log_error "Missing symlink: $link (expected: $name)"
      failed=1
      return 1
    fi
    local target
    target="$(readlink -f "$link" 2>/dev/null || readlink "$link" 2>/dev/null)"
    if [[ -z "$target" ]] || [[ ! -r "$target" ]]; then
      log_error "Dangling symlink: $link → ${target:-<unresolved>}"
      failed=1
      return 1
    fi
    return 0
  }

  _recall_check_one_link "$mem_link" "mem" || true
  _recall_check_one_link "$mcp_link" "mem-mcp" || true

  if [[ $failed -ne 0 ]]; then
    echo ""
    log_error "Global link verification failed."
    log_error "Expected both of these symlinks to resolve to built dist/ files:"
    log_error "  $mem_link"
    log_error "  $mcp_link"
    log_error ""
    log_error "Current ~/.bun/bin listing for mem*:"
    ls -la "$bun_bin_dir"/mem* 2>&1 | sed 's/^/  /' || true
    return 1
  fi
  return 0
}

# Re-link the global `mem` and `mem-mcp` binaries with verification.
#
# Flow: bun link → verify → (on failure) npm link → verify → (on failure)
# exit 1 with diagnostic. Used by both install.sh Step 4 and update.sh
# step_link_global for consistent behavior.
recall_link_global() {
  log_info "Linking globally (bun link)..."
  if bun link 2>&1 | grep -v '^$' | sed 's/^/  /'; then
    if recall_verify_global_link; then
      log_success "Linked: mem and mem-mcp verified"
      return 0
    fi
    log_warn "bun link reported success but bin symlinks are missing/stale."
  else
    log_warn "bun link exited non-zero."
  fi

  log_warn "Falling back to npm link..."
  local npm_link_ok=false
  if [[ "$RECALL_OS" == "linux" ]]; then
    sudo npm link && npm_link_ok=true
  else
    npm link && npm_link_ok=true
  fi

  if [[ "$npm_link_ok" == "true" ]] && recall_verify_global_link; then
    log_success "Linked via npm: mem and mem-mcp verified"
    return 0
  fi

  log_error "Failed to establish working global link (bun + npm both declined)."
  [[ "$RECALL_OS" != "linux" ]] && log_info "On macOS, try: sudo npm link"
  log_error "Recovery: exit Claude Code / OpenCode / Pi, then run:"
  log_error "  cd $(pwd) && bun install && bun run build && bun link"
  log_error "  ls -la ~/.bun/bin/mem ~/.bun/bin/mem-mcp"
  return 1
}
