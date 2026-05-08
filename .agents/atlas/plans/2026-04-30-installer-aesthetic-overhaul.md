# Installer Aesthetic Overhaul (Option 3 — bash polish + auto-install gum)

**Status:** Draft
**Date:** 2026-04-30
**Owner:** Ed
**Touches:** `install.sh`, `lib/install-lib.sh`, `update.sh`, `uninstall.sh`, `tests/install/`

---

## 1. Feature Specification

### 1.1 Goal

Transform Recall's `install.sh` from functional-but-bland into a polished install experience by combining a **bash-only baseline polish** with an **auto-installing `gum` enhancement layer**. Users with `gum` available (or who let us install it) get a modern Charm-style TUI; everyone else gets a polished bash fallback that already looks better than today.

### 1.2 Why this approach

- **No npm runtime dependency** — installer remains pure bash, deployable via `curl|bash`.
- **No bootstrap deadlock** — gum is an optional Go binary, not a Bun package, so it doesn't depend on `bun install` having run first.
- **Graceful degradation guaranteed** — if gum auto-install fails, we silently fall back to the bash baseline. Install never blocks on gum.
- **Universal style system** — every UX primitive is a wrapper function (`_confirm`, `_choose`, `_spin`, `_style`, `_banner`) that dispatches based on `HAS_GUM=true|false`. Touch the wrapper once, every call site benefits.

### 1.3 Constraints

| Constraint | How met |
|------------|---------|
| Must work in `curl \| bash` (no TTY on stdin) | Wrappers detect `[[ -t 0 ]]`, skip prompts non-interactively |
| Must work in CI | `RECALL_NO_GUM=1` opt-out + non-TTY detection |
| Must not slow install when gum is missing | gum auto-install capped at 30s, async fallback |
| Existing tests must pass | `*_DETECTED` flag names preserved; test grep patterns unchanged |
| Same UX across `install.sh` / `update.sh` / `uninstall.sh` | All three source `lib/install-lib.sh`; wrappers central |

### 1.4 Out of Scope (deferred follow-ups)

- Diff preview for config-file edits (CLAUDE.md, settings.json, MCP).
- Inline terminal images (iTerm/sixel banner).
- Localized / translated install strings.
- Compiled-binary installer (Bun `--compile` route — explicitly rejected).
- Node/npm runtime UX (e.g., `@clack/prompts`) — explicitly rejected.

### 1.5 Success Criteria

1. Fresh install on macOS + Linux (Ubuntu, Alpine) produces visually consistent output.
2. With `gum` present: animated spinner during `bun install`, multi-select platform picker, styled bordered banners.
3. Without `gum` (or with `RECALL_NO_GUM=1`): glyph-prefixed lines, fixed-alignment ASCII banners, captured-output for noisy steps.
4. Existing `bun test tests/install/ tests/opencode-integration.test.ts tests/pi-integration.test.ts` still passes.
5. `bash -n install.sh lib/install-lib.sh update.sh uninstall.sh` succeeds.
6. Failed installs produce a structured error panel with last 10 lines of failing command output + restore command.

---

## 2. Sub-Agent Roster

The plan executes via three colored sub-agents, one per phase, plus a parallel cross-cutting validator. The **primary (orchestrator) agent** coordinates and emits heartbeat updates.

| Color | Agent name | Scope |
|-------|-----------|-------|
| 🔵 Cyan | `cyan-foundation` | Phase 1 — bash polish baseline |
| 🟢 Green | `green-gum-integration` | Phase 2 — auto-install gum + wrapper functions |
| 🟡 Yellow | `yellow-trust-layer` | Phase 3 — pre-flight, post-flight, error panel |
| 🟣 Purple | `purple-validator` | Cross-cutting — runs after every action item in every phase |

**Each colored sub-agent owns its phase's action items end-to-end** — implementation, local syntax check, commit-sized diff. The purple validator runs the test suite and cross-platform smoke tests against each sub-agent's output before it merges.

---

## 3. Heartbeat Protocol

The primary (orchestrator) agent emits a heartbeat to the user **every 3 minutes** during active execution AND whenever a sub-agent reports an action-item completion. Sub-agents send progress updates via `SendMessage` to the orchestrator; the orchestrator aggregates and emits to the user.

### Heartbeat format

```
═══ HEARTBEAT  @ 14:23:05  (elapsed 00:08:14) ═══
🔵 cyan-foundation:        [████████░░] 80%  cyan-1.4 in progress (capture bun install stdout)
🟢 green-gum-integration:  [░░░░░░░░░░]  0%  blocked on Phase 1
🟡 yellow-trust-layer:     [░░░░░░░░░░]  0%  blocked on Phase 2
🟣 purple-validator:       [██████░░░░] 60%  re-running tests on cyan-1.3 patch
─── last completion: cyan-1.3 banner alignment (2m ago, validated ✓)
─── next milestone:  cyan-1.4 expected ~3m
```

### Sub-agent → orchestrator status message format

```json
{
  "agent": "cyan-foundation",
  "task": "cyan-1.3",
  "status": "completed" | "in_progress" | "blocked" | "failed",
  "elapsed_ms": 142000,
  "notes": "banner widths now match content; validated visually",
  "validated_by_purple": true
}
```

### Heartbeat triggers

- Every 3 minutes (wall clock) while any sub-agent is `in_progress`.
- Immediately when any sub-agent emits `completed` or `failed`.
- On phase transition (Phase 1 → 2, etc.).
- On user interrupt or course correction.

---

## 4. Phase 1 — 🔵 Cyan Foundation

**Purpose:** Lay down the visual baseline. No `gum` dependency yet — but the wrapper-function shape is established so Phase 2 just slots gum in. After Phase 1, the installer already looks better even when `gum` is unavailable. This is the work that ships value even if Phase 2/3 are abandoned.

### Action items

| ID | To-do | Files |
|----|-------|-------|
| `cyan-1.1` | Replace `[INFO]/[OK]/[WARN]/[ERROR]` with glyph functions: `→` (info), `✓` (success), `⚠` (warn), `✗` (error). Add `_step()` for numbered steps with right-aligned 12-char action labels (Volta-style). | `lib/install-lib.sh` |
| `cyan-1.2` | TTY-gate all color escape codes: define color vars inside `if [[ -t 1 ]]` block, set to empty string otherwise. Verify CI/non-TTY output is plain text. | `lib/install-lib.sh` |
| `cyan-1.3` | Fix banner alignment in 3 places: `install.sh:41-44` (header), `install.sh:153-155` (footer), `lib/install-lib.sh:320-322` (restore). Re-pad to actual content width. Standardize on "Recall" casing. | `install.sh`, `lib/install-lib.sh` |
| `cyan-1.4` | Quiet noisy steps: capture `bun install` / `bun run build` / `bun link` stdout to a temp file. Show single status line. On failure dump captured log + exit. | `install.sh`, `lib/install-lib.sh` |
| `cyan-1.5` | Replace hardcoded `Step 1/2/...8b/9/10/11` numbering with a counter that increments based on what actually runs. Total step count rendered up front. | `install.sh` |

**Owner:** 🔵 cyan-foundation
**Dependencies:** none
**Validated by:** 🟣 purple-validator after each task
**Estimated effort:** 1 working session (~2 hrs)

---

## 5. Phase 2 — 🟢 Green Gum Integration

**Purpose:** Layer `gum` on top of the polished bash foundation. `gum` is auto-installed if missing; if every install path fails, we silently fall back to Phase 1 bash output. The user never sees a gum error — they just get the lower-fidelity experience.

### Action items

| ID | To-do | Files |
|----|-------|-------|
| `green-2.1` | Add gum detection: `_detect_gum()` sets `HAS_GUM=true` iff `command -v gum` succeeds AND `gum --version` parses to ≥0.14. | `lib/install-lib.sh` |
| `green-2.2` | Auto-install fallback chain: `brew install gum` (mac) → Charm APT repo install (linux) → direct GitHub release tarball download with SHA256 verification. Cap install at 30s; on timeout/failure set `HAS_GUM=false` and continue silently. Skipped entirely if `RECALL_NO_GUM=1`. | `lib/install-lib.sh` |
| `green-2.3` | Implement wrapper functions in `lib/install-lib.sh`: `_confirm`, `_choose`, `_spin`, `_style`, `_banner`. Each branches on `$HAS_GUM`. | `lib/install-lib.sh` |
| `green-2.4` | Replace existing UX call sites: banners → `_banner`; `recall_select_platforms` Y/n loop → single multi-select `_choose`; `bun install / bun run build / bun link` → `_spin "..." -- command`; restore confirmation → `_confirm`. | `install.sh`, `lib/install-lib.sh` |
| `green-2.5` | Honor `RECALL_NO_GUM=1` env override and `--no-gum` flag. Document in `--help` and `docs/installation.md`. | `install.sh`, `docs/installation.md` |

**Owner:** 🟢 green-gum-integration
**Dependencies:** Phase 1 complete
**Validated by:** 🟣 purple-validator with both `HAS_GUM=true` and `HAS_GUM=false` snapshots
**Estimated effort:** 1 working session (~3 hrs — auto-install path is the longest)

---

## 6. Phase 3 — 🟡 Yellow Trust Layer

**Purpose:** Ship the high-leverage UX polish that separates "looks nice" from "feels trustworthy" — pre-flight summary, post-flight self-check, structured error panel. These work identically whether gum is present or not because they use the wrappers from Phase 2.

### Action items

| ID | To-do | Files |
|----|-------|-------|
| `yellow-3.1` | Pre-flight summary panel: before Step 1 (backup), render a `_style`-bordered summary listing target dir, platforms to configure, backup destination, total step count. Confirm with `_confirm` to proceed (skipped on `--yes`). | `install.sh` |
| `yellow-3.2` | Post-flight self-check: after install completion, run `mem stats` + `mem doctor --quiet`. Surface result inline (✓ / ✗ summary line). | `install.sh` |
| `yellow-3.3` | Restructure error trap (`install.sh:22-32`): on failure, render `_style`-bordered error panel with failing step name, last 10 lines of captured log (from cyan-1.4), exact restore command, link to `docs/troubleshooting.md`. | `install.sh`, `lib/install-lib.sh` |
| `yellow-3.4` | Apply Phase 1+2 styling consistently to `update.sh` and `uninstall.sh`. Most propagates via shared lib; verify visual parity. | `update.sh`, `uninstall.sh` |
| `yellow-3.5` | Update `--help` output to document `--yes`, `--no-gum`, `RECALL_NO_GUM=1`. Link to docs. | `install.sh`, `update.sh`, `uninstall.sh` |

**Owner:** 🟡 yellow-trust-layer
**Dependencies:** Phases 1 + 2 complete
**Validated by:** 🟣 purple-validator end-to-end on macOS + Ubuntu + Alpine, with and without gum
**Estimated effort:** 1 working session (~2 hrs)

---

## 7. 🟣 Purple Validator (cross-cutting, runs continuously)

**Purpose:** Ensures every phase ships test-clean. Runs in parallel with all three colored phases; gates each action item before merge.

### Validator action items (run after every colored to-do)

| ID | To-do |
|----|-------|
| `purple-V.1` | `bash -n install.sh lib/install-lib.sh update.sh uninstall.sh` syntax check |
| `purple-V.2` | `bun test tests/install/ tests/opencode-integration.test.ts tests/pi-integration.test.ts` |
| `purple-V.3` | Smoke test in `docker run -it ubuntu:22.04` and `docker run -it alpine:edge` |
| `purple-V.4` | Force `HAS_GUM=false` snapshot on every Phase 2+3 task |
| `purple-V.5` | Force `RECALL_NO_GUM=1` env snapshot on Phase 2+3 |
| `purple-V.6` | Final test grep: confirm `tests/opencode-integration.test.ts:314-315` and `tests/pi-integration.test.ts:187` (which assert presence of `*_DETECTED` flags) still pass |

---

## 8. Risk Register

| Risk | Mitigation | Owner |
|------|-----------|-------|
| gum auto-install hangs on slow network | 30s timeout, async fallback to `HAS_GUM=false` | 🟢 green |
| Charm APT repo signature key rotates and breaks Linux install | Make GitHub releases binary download the **primary** path; APT is opt-in | 🟢 green |
| Captured stdout hides progress on very large `bun install` | Show "Installing dependencies (NNs elapsed)" updated every 5s via background timer | 🔵 cyan |
| Boxes look ugly on narrow terminals (<70 cols) | Detect `tput cols`, drop borders below 70 | 🔵 cyan |
| Existing test grep patterns break on log refactor | Preserve `*_DETECTED` flag names verbatim — already verified | 🟣 purple |
| Auto-install gum on shared/CI runners writes to system PATH | Always default to per-user `$HOME/.local/bin` install location | 🟢 green |

---

## 9. Output Mockups

See companion HTML visual at `2026-04-30-installer-aesthetic-overhaul.html` for side-by-side `gum` vs. bash-fallback previews of:

- Banner header
- Platform selection (multi-select vs Y/n loop)
- Spinner during `bun install`
- Pre-flight summary panel
- Post-flight self-check
- Error panel

---

## 10. Acceptance Checklist

- [ ] All Phase 1 to-dos closed, validated 🟣
- [ ] All Phase 2 to-dos closed, validated 🟣
- [ ] All Phase 3 to-dos closed, validated 🟣
- [ ] `bun test` green
- [ ] Manual install on macOS works with and without gum present
- [ ] Manual install on Ubuntu 22.04 works with and without gum present
- [ ] Manual install on Alpine edge works with and without gum present
- [ ] `RECALL_NO_GUM=1` opt-out verified
- [ ] `--yes` non-interactive verified
- [ ] curl|bash path still works (no TTY on stdin)
- [ ] Update plan moved to `.atlas/plans/archive/` after merge
