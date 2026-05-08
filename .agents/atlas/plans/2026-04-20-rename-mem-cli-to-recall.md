---
title: "Rename CLI: mem → recall (and mem-mcp → recall-mcp)"
status: Not Started
percent_complete: 5
last_updated: 2026-04-28
phase: Plan + handoff written; no execution yet — bin still mem/mem-mcp, MEM_DB_PATH still in src/db/connection.ts
blockers: none — ready to start in a worktree per the handoff
next_action: Pick up handoff 2026-04-21-rename-cli-mem-to-recall.md → execute Phase 1 package.json bin rename in a worktree
---

# Rename CLI: `mem` → `recall` (and `mem-mcp` → `recall-mcp`)

> Filename is system-generated. Suggested rename on first commit per CLAUDE.md conventions: `2026-04-20-rename-mem-cli-to-recall.md`.

## Context

The project is called **Recall** but the CLI is `mem` and the MCP server is `mem-mcp`. This asymmetry pre-dates v0.7.0's "v2 foundation" release (decisions#49). Ed is the only install — there is no external user base. The goal is a clean atomic rename so the external-facing surface matches the project name.

**Scope** (user-selected): binaries + env vars.
**Out of scope**: MCP tool names (`memory_search`, `memory_add`, …) and the MCP server ID (`recall-memory`). Tool names are the stable public API — agents call them by bare name, not server-namespaced. Server ID is cosmetic and the `recall-memory` name is still semantically accurate ("Recall is the project, `memory` is what it stores"). Renaming these is cosmetic churn for zero user-visible value.

## Strategy

Hard cut in a single version bump to **v1.0.0** (the v2 foundation already shipped in v0.7.0; this rename is the name catching up).

- Silent backward-compat read of `MEM_DB_PATH` for one version, **no deprecation console.warn** (no call site reads `getDbPath()` more than once per process, so the "once per process" guard adds zero value; a silent fallback is simpler and avoids test/CLI stderr pollution)
- `install.sh` gains `recall_cleanup_legacy()` — removes stale `~/.bun/bin/mem`/`mem-mcp` symlinks and rewrites `mem-mcp` → `recall-mcp` in `~/.claude/settings.json` and any OpenCode/Pi config present
- Worktree → merge → install flow explicitly documented (see "Execution" — the naive `bun link` from inside a worktree leaves dangling symlinks after `ExitWorktree`)

## What changes

### 1. `package.json`

```json
"bin": {
  "recall": "./dist/index.js",
  "recall-mcp": "./dist/mcp-server.js"
}
```
Version bumps to `1.0.0`. `tsup` output paths unchanged; `scripts.build` shebang replacement keeps working.

### 2. Source code

- `src/index.ts:33` — `.name('mem')` → `.name('recall')`
- `src/db/connection.ts:15-17` — modify **the existing** `getDbPath()` in place. Silent fallback, no new file:
  ```ts
  export function getDbPath(): string {
    return (
      process.env.RECALL_DB_PATH ||
      process.env.MEM_DB_PATH ||          // one-version compat; remove in v1.1.0
      DEFAULT_DB_PATH
    );
  }
  ```
  **Do not create `src/lib/env.ts`** — `getDbPath()` already exists as a named, exported function with exactly one caller; a new module would add indirection for no reuse.
- `src/commands/doctor.ts:297` — `spawnSync('mem-mcp', …)` → `spawnSync('recall-mcp', …)`
- `src/commands/doctor.ts:427-429` — runtime banner `mem doctor — Memory Subsystem Health Check` → `recall doctor — …` (NOT just "help text" — this is runtime stdout)
- All user-visible strings in `src/commands/*.ts` (`stats.ts`, `embed.ts`, `loa.ts`, `cluster.ts`, `benchmark.ts`, `onboard.ts`, `import-telos.ts`, plus comments) — mechanical `mem ` → `recall ` in quoted strings
- Sweep at the end: `rg 'mem\s+(stats|init|search|add|doctor|dump|onboard|embed|import|loa|pin|unpin|benchmark|decision|prune|hybrid|semantic)' src/` should return empty

### 3. Hooks (BLOCKER — missed in prior draft)

Two self-contained hook files carry `MEM_DB_PATH` reads independently of `src/`:

- `hooks/SessionRecall.ts:46` — `if (process.env.MEM_DB_PATH) return process.env.MEM_DB_PATH;`
- `hooks/SessionPreCompact.ts:74` — identical pattern

These are copied verbatim to `~/.claude/hooks/` by `_recall_copy_hook_files`. Update each to match `getDbPath()`'s fallback chain:
```ts
const dbPath = process.env.RECALL_DB_PATH || process.env.MEM_DB_PATH || `${homedir()}/.claude/memory.db`;
```
After source change, `./install.sh` re-copies these into `~/.claude/hooks/`.

Also verify `hooks/SessionExtract.ts` and `hooks/BatchExtract.ts` for any `mem`-binary-name references (earlier grep came up empty but reconfirm during implementation).

### 4. Env var `MEM_DB_PATH` → `RECALL_DB_PATH`

**User-facing env var** — `MEM_DB_PATH` is the only one (verified: `MEM_MCP_PATH` / `INSTALL_MCP_PATH` in `install-lib.sh` are shell-local variables inside `bun -e` calls, not user env).

Write sites (install-time MCP environment blocks):
- `lib/install-lib.sh:613` (OpenCode)
- `lib/install-lib.sh:698` (Pi)
- `lib/install-lib.sh:585, 669` — shell-local `db_path_abs` resolution (rename for clarity)

Tests — **actual count: 6 files** with direct `MEM_DB_PATH` references, ~34 occurrences (plan's prior "29 test files" was wrong):
- `tests/helpers/setup.ts:12, 22` (**central harness — fix here first**)
- `tests/hooks/SessionRecall.test.ts` (7 occurrences)
- `tests/hooks/session-precompact.test.ts` (5 occurrences)
- `tests/db/extraction-schema.test.ts` (2)
- `tests/opencode-integration.test.ts:487` (1 — a fixture string)
- `tests/db/connection.test.ts:21-36` (test descriptions + setup)

**Update `setup.ts` + `teardownTestDb()` in Commit 1**, not Commit 5:
- Set `RECALL_DB_PATH` instead of `MEM_DB_PATH` in setup
- Teardown must also `delete process.env.RECALL_DB_PATH` alongside `MEM_DB_PATH` (otherwise test isolation breaks when one test sets the new var and the next expects a clean env)

Doing the harness update in Commit 1 means the silent fallback is never exercised in tests → zero noise.

### 5. `install.sh` / `update.sh` / `uninstall.sh` / `lib/install-lib.sh`

**`install.sh`:**
- Lines 90-98 — `local mem_bin="$HOME/.bun/bin/mem"` → `recall_bin="$HOME/.bun/bin/recall"`. Tight dependency with `recall_cleanup_legacy` removal of `~/.bun/bin/mem` (both land in the same commit, no intermediate state)
- Lines 180, 183 — "Test: mem stats" / "mem onboard" → `recall`

**`lib/install-lib.sh`:** rename `mem` / `mem-mcp` at:
- Lines 126, 348, 581, 671, 788, 802-803, 824-825, 834-835, 841, 850, 867, 875

**Add `recall_cleanup_legacy`** — called from `do_install` immediately after `recall_check_prerequisites`, before `recall_link_global`. Rewrites `settings.json`, `~/.config/opencode/opencode.json`, and `~/.pi/agent/mcp.json` (each guarded by `[[ -f "$file" ]]`). Uses the `SETTINGS_FILE=... bun -e '...'` pattern already used by `_recall_write_mcp_settings` for JSON isolation. Keep `bun -e` (rest of the file already uses it in most write blocks; `node -e` usage is mixed — pick one style in a follow-up).

```bash
recall_cleanup_legacy() {
  local bun_bin_dir="${HOME}/.bun/bin"
  for legacy in "$bun_bin_dir/mem" "$bun_bin_dir/mem-mcp"; do
    [[ -L "$legacy" ]] && { rm -f "$legacy"; log_success "Removed legacy symlink: $(basename "$legacy")"; }
  done

  _recall_rewrite_mem_mcp_paths() {
    local file="$1"
    [[ ! -f "$file" ]] && return 0
    grep -q 'mem-mcp' "$file" || return 0
    FILE="$file" bun -e '
      const fs = require("fs");
      const cfg = JSON.parse(fs.readFileSync(process.env.FILE, "utf8"));
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (typeof v === "string" && v.includes("mem-mcp")) o[k] = v.replace(/mem-mcp/g, "recall-mcp");
          else if (Array.isArray(v)) o[k] = v.map(x => typeof x === "string" ? x.replace(/mem-mcp/g, "recall-mcp") : (walk(x), x));
          else if (typeof v === "object") walk(v);
        }
      };
      walk(cfg);
      fs.writeFileSync(process.env.FILE, JSON.stringify(cfg, null, 2));
    '
    log_success "Rewrote mem-mcp → recall-mcp in $(basename "$file")"
  }

  _recall_rewrite_mem_mcp_paths "$CLAUDE_DIR/settings.json"
  _recall_rewrite_mem_mcp_paths "$OPENCODE_CONFIG_DIR/opencode.json"
  _recall_rewrite_mem_mcp_paths "$PI_CONFIG_DIR/mcp.json"
}
```

**Ordering note:** `recall_configure_mcp` (Step 6) has a `grep -q "recall-memory"` early-return. That's fine — the MCP server *ID* is still `recall-memory`; `recall_cleanup_legacy` (Step 1) already fixed the stale command path. Re-registration is correctly skipped because the config is already valid.

**Idempotency:** re-running `./install.sh` is safe — `recall_cleanup_legacy` no-ops if no legacy symlinks exist and no `mem-mcp` strings remain in configs.

**`update.sh`:** rename at lines 252, 258, 268, 271, 286, 288, 292-297, 335, 339-340.

**`uninstall.sh` (BLOCKER — was missing from prior draft):** lines 108, 303, and any fixture/assertion strings. Test fixture `tests/install/uninstall.test.ts:149` hardcodes `mem-mcp` — update to `recall-mcp` to keep the test asserting on real behavior (otherwise it becomes a false positive: passes a stale fixture through and silently stops testing the real installer path).

**`tests/opencode-integration.test.ts:484, 496` (BLOCKER):** fixture constructs mock MCP config with `command: 'mem-mcp'` and asserts `toBe('mem-mcp')`. Update both fixture string and assertion.

### 6. Slash commands (`commands/recall/*.md`)

Mechanical `mem ` → `recall ` in bash blocks: `add.md`, `dump.md`, `search.md`, `recent.md`, `stats.md`, `doctor.md`, `loa.md`, `update.md`.

### 7. Plugins / extensions

- `pi/recall-compaction.ts:25` — `execFileSync("mem", [...])` → `execFileSync("recall", [...])`
- `opencode/recall-compaction.ts:25` — same

### 8. Documentation

`README.md`, `CLAUDE.md`, `FOR_CLAUDE.md`, `FOR_PI.md`, `FOR_OPENCODE.md`, `ACKNOWLEDGMENTS.md`, `docs/cli-reference.md` (89 — biggest file), `docs/installation.md`, `docs/upgrading.md`, `docs/troubleshooting.md`, `docs/slash-commands.md`, `docs/PI_INTEGRATION.md`, `docs/OPENCODE_INTEGRATION.md`, `benchmarks/README.md`.

Final sweep: `rg -l '\bmem(-mcp)?\b' -g '!node_modules' -g '!dist' -g '!bun.lock' -g '!.git' -g '!*.gif' -g '!*.tape' -g '!CHANGELOG.md'`. Expected empty except: word "memory", MCP tool prefix `memory_`, `MEMORY/` directory name, `memory.db` filename, and intentional historical references in CHANGELOG.

### 9. Demo GIFs (`assets/demo-*.tape`)

Tape scripts reference `mem stats` / `mem search` / etc. Rendered `.gif` artifacts must be regenerated via `vhs`. **Deferred to a follow-up** — not blocking migration. Tapes themselves get mechanical update at commit-8 (below).

### 10. CHANGELOG

v1.0.0 entry: "**BREAKING**: Renamed CLI `mem` → `recall` and MCP binary `mem-mcp` → `recall-mcp`. Renamed env var `MEM_DB_PATH` → `RECALL_DB_PATH` (old name still read silently through v1.0.x — removed in v1.1.0). After pulling, run `./install.sh` to migrate. **Restart Claude Code** before first use to refresh the MCP server registration."

## Critical files

| File | Role |
|---|---|
| `/Users/ed/Developer/atlas-recall/package.json` | Bin names + version 1.0.0 |
| `/Users/ed/Developer/atlas-recall/src/index.ts` | `.name()` + comments |
| `/Users/ed/Developer/atlas-recall/src/db/connection.ts` | `getDbPath()` fallback (modify in place) |
| `/Users/ed/Developer/atlas-recall/src/commands/doctor.ts` | `spawnSync('mem-mcp')` + runtime banner |
| `/Users/ed/Developer/atlas-recall/src/commands/*.ts` | User-facing strings |
| `/Users/ed/Developer/atlas-recall/hooks/SessionRecall.ts` | **MEM_DB_PATH read (BLOCKER)** |
| `/Users/ed/Developer/atlas-recall/hooks/SessionPreCompact.ts` | **MEM_DB_PATH read (BLOCKER)** |
| `/Users/ed/Developer/atlas-recall/lib/install-lib.sh` | Path resolution + `recall_cleanup_legacy` |
| `/Users/ed/Developer/atlas-recall/install.sh` | `recall_bin` lookup + messages |
| `/Users/ed/Developer/atlas-recall/update.sh` | Lookups + messages |
| `/Users/ed/Developer/atlas-recall/uninstall.sh` | **Not in prior draft (BLOCKER)** |
| `/Users/ed/Developer/atlas-recall/commands/recall/*.md` | 8 slash commands |
| `/Users/ed/Developer/atlas-recall/pi/recall-compaction.ts` | `execFileSync("mem", …)` |
| `/Users/ed/Developer/atlas-recall/opencode/recall-compaction.ts` | Same |
| `/Users/ed/Developer/atlas-recall/tests/helpers/setup.ts` | Test harness — update in Commit 1 |
| `/Users/ed/Developer/atlas-recall/tests/hooks/SessionRecall.test.ts` | 7 MEM_DB_PATH refs |
| `/Users/ed/Developer/atlas-recall/tests/hooks/session-precompact.test.ts` | 5 refs |
| `/Users/ed/Developer/atlas-recall/tests/db/extraction-schema.test.ts` | 2 refs |
| `/Users/ed/Developer/atlas-recall/tests/db/connection.test.ts` | Test descriptions + setup |
| `/Users/ed/Developer/atlas-recall/tests/opencode-integration.test.ts` | **Fixture + assertion on mem-mcp (BLOCKER)** |
| `/Users/ed/Developer/atlas-recall/tests/install/uninstall.test.ts` | Fixture at line 149 |

## Reused existing patterns

- `lib/install-lib.sh` already uses `SETTINGS_FILE=... bun -e '...'` pattern for JSON writes — re-use for `_recall_rewrite_mem_mcp_paths`
- `recall_verify_global_link()` (install-lib.sh:800-839) catches `bun link` silent no-ops; just needs name updates — no new verification logic needed
- Existing `getDbPath()` in `connection.ts:15-17` is the right place for the fallback (don't invent `src/lib/env.ts`)

## Execution order

**Worktree + install flow (HIGH — corrected from prior draft):**

`bun link` from inside `.claude/worktrees/rename-mem-to-recall/` symlinks `~/.bun/bin/recall` to the worktree's `dist/index.js`. `ExitWorktree` then removes the worktree, leaving `recall` as a dangling symlink. **The install MUST happen from main, not from the worktree.**

Correct sequence:

1. `EnterWorktree` — branch `rename-mem-to-recall`
2. **Commits 1–8 inside the worktree**, below
3. **Before live install:** merge branch to main (or fast-forward), `ExitWorktree` with `action: remove`
4. **From main tree**, run `./install.sh` — this is the moment the live system migrates

### Commits (all inside the worktree)

1. **Commit 1** — Modify `getDbPath()` in `src/db/connection.ts` with silent fallback. Update `tests/helpers/setup.ts` + `teardownTestDb()` to use `RECALL_DB_PATH`. No binary rename yet. Run `bun test` — all green, zero deprecation noise.
2. **Commit 2** — Update hooks: `hooks/SessionRecall.ts`, `hooks/SessionPreCompact.ts` (both read the new var first, old var as fallback).
3. **Commit 3** — `package.json` bin rename + version 1.0.0. `src/index.ts` `.name()`. User-facing strings in `src/commands/*.ts`. `src/commands/doctor.ts` including runtime banner. No `bun link` in the worktree (see note above).
4. **Commit 4** — `lib/install-lib.sh` + `install.sh` + `update.sh` + `uninstall.sh` rename; add `recall_cleanup_legacy` with 3-config rewriter.
5. **Commit 5** — Slash commands + `pi/recall-compaction.ts` + `opencode/recall-compaction.ts`.
6. **Commit 6** — Remaining tests: `opencode-integration.test.ts` fixture+assertion, `uninstall.test.ts` fixture, rename remaining `MEM_DB_PATH` → `RECALL_DB_PATH` in test bodies. (setup.ts already done in Commit 1.)
7. **Commit 7** — Docs sweep.
8. **Commit 8** — VHS tape scripts in `assets/*.tape` get the mechanical rename (GIF re-render deferred).

Then: merge → `ExitWorktree remove` → from main tree: `./install.sh` → restart Claude Code.

**Awareness of in-flight MCP breakage:** `bun run build` (implicit in `./install.sh` Step 3) uses `tsup --clean`, which wipes `dist/` before rebuilding. The currently-running Claude Code session has an MCP server process holding `dist/mcp-server.js` open — most OSes keep the file alive for the running process, but the new build creates a new inode. When Claude Code is restarted, it starts a new process against the new file. During the install → restart window, the live `memory_*` tools will fail with connection errors. For single-user local install this is a ~10-second inconvenience, not a crisis, but document it in the migration note: "Finish any in-progress `memory_dump` calls before running `./install.sh`."

## Verification (end-to-end)

```bash
# Pre-checks (in worktree)
bun install
bun test                # all green; zero deprecation warnings in stderr
bun run lint            # tsc --noEmit clean
bun run build           # dist/ recreated

# Migrate to main and install
# (merge, ExitWorktree remove, cd back to main)
./install.sh            # expect log lines:
                        #   "Removed legacy symlink: mem"
                        #   "Removed legacy symlink: mem-mcp"
                        #   "Rewrote mem-mcp → recall-mcp in settings.json"

# Binary verification
which recall recall-mcp                      # both resolve under ~/.bun/bin
which mem                                    # empty (legacy cleaned)
ls -la ~/.bun/bin/recall ~/.bun/bin/recall-mcp   # symlinks resolve to main-tree dist/

# CLI verification
recall --version        # 1.0.0
recall stats            # same record counts as before (DB unchanged)
recall doctor           # MCP reachable, hooks registered, embeddings OK

# MCP registration
grep -A3 '"recall-memory"' ~/.claude/settings.json   # args ends in /recall-mcp (not /mem-mcp)

# Env var compat (manual)
MEM_DB_PATH=/tmp/test.db recall stats        # still works (silent fallback)
RECALL_DB_PATH=/tmp/test.db recall stats     # works
# No deprecation warning on stderr — silent by design

# Restart Claude Code → verify memory_search, memory_add, memory_dump still callable
# Session-start hook still loads L0/L1 tiered context (decisions#49 intact)

# Residual-reference sweep
rg -l '\bmem(-mcp)?\b' -g '!node_modules' -g '!dist' -g '!bun.lock' -g '!.git' -g '!*.gif' -g '!CHANGELOG.md'
# Expected empty except intentional: word "memory", MCP tool prefix "memory_", "MEMORY/" dir, memory.db filename

# Hook verification
grep -l RECALL_DB_PATH ~/.claude/hooks/SessionRecall.ts ~/.claude/hooks/SessionPreCompact.ts
# Both files should contain the new var name (installed copies were refreshed by ./install.sh)
```

## Follow-ups (non-blocking)

- Re-render VHS demo GIFs
- v1.1.0: remove the `MEM_DB_PATH` fallback from `getDbPath()` + both hooks
- Optionally reconcile `node -e` vs `bun -e` inconsistency in `lib/install-lib.sh` (cosmetic)
- Defer: rename MCP server ID `recall-memory` → `recall` and tool prefix `memory_` → `recall_`. Both intentionally skipped (see Scope note).

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| `bun link` from worktree creates dangling symlinks after `ExitWorktree` | Migrate workflow: commits in worktree → merge to main → remove worktree → install from main. Documented above as a required step, not a style choice |
| Live MCP server dies when `tsup --clean` wipes `dist/` | Single-user; accepted 10-second gap; CHANGELOG flags "finish in-progress memory_dump first, then install, then restart" |
| Hooks already in `~/.claude/hooks/` keep reading `MEM_DB_PATH` → work silently until v1.1.0 removes it | `./install.sh` re-copies the updated hook files; verification step greps for `RECALL_DB_PATH` in the installed copies |
| `recall_configure_mcp` early-returns on seeing `recall-memory` before the path is fixed | `recall_cleanup_legacy` runs first and rewrites the path; re-registration is correctly skipped because config is already valid |
| `setupTestDb()` still sets `MEM_DB_PATH` → every test emits a deprecation warn | No deprecation warn at all; silent fallback. Setup.ts updated in Commit 1 anyway, so fallback never fires in tests |
| `bun unlink` from a pre-rename checkout would remove `mem`/`mem-mcp`; from post-rename removes `recall`/`recall-mcp` | `recall_cleanup_legacy` is idempotent — safe to re-run. Users only run `uninstall.sh` intentionally |
| 29-vs-6 confusion delays implementation | Plan now lists the 6 files explicitly |
| Dangling `~/.bun/bin/mem` survives a partial install failure | `recall_cleanup_legacy` runs before `recall_link_global`; if link fails, the symlink is already gone — `uninstall.sh` + re-run `install.sh` is the recovery |
