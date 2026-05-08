---
title: "Publish Recall as npm Package (recall-memory)"
status: Not Started
percent_complete: 0
last_updated: 2026-04-28
phase: Phase 1 (package.json rename) not started; package still named "recall" with bin mem/mem-mcp
blockers: Should be sequenced AFTER CLI rename plan (2026-04-20-rename-mem-cli-to-recall) so npm package ships with recall/recall-mcp bins, not legacy mem/mem-mcp
next_action: Land CLI rename first, then execute Phase 1 (package.json — name → recall-memory, bin → recall/recall-mcp, files allowlist)
---

# Plan: Publish Recall as npm Package (`recall-memory`)

## Context

Recall is currently install-from-source only (`git clone` + `./install.sh`). Ed wants it installable as an npm package so users can `bun install -g recall-memory` and get a working install. This is Ed's first npm package.

**Key constraint:** Recall uses `bun:sqlite` (a Bun built-in) — it cannot run under Node.js. The package is Bun-native, distributed via npm as a delivery channel.

**Two-step UX:**
```bash
bun install -g recall-memory    # primary (recommended)
npm install -g recall-memory    # also works (requires bun on PATH)
mem setup                       # configures hooks, MCP, DB, etc.
```

### Red Team Findings (incorporated)

The plan was red-teamed by 32 parallel agents. Five critical findings are incorporated below:

1. **First-run guard (MUST-FIX)** — Users will skip `mem setup`. Every `mem` command must check for configured state and print "Run `mem setup` first" if unconfigured.
2. **`files` field (MUST-FIX)** — Without it, `npm publish` ships `.claude/settings.local.json` and 4.4MB of test/asset bloat. Non-negotiable before any publish.
3. **hooks/lib/ directory (MUST-FIX)** — Hooks import from `hooks/lib/*.ts`. `mem setup` must copy the full `hooks/` directory tree, not just flat `.ts` files.
4. **MCP command name, not absolute path** — Register `mem-mcp` as a command (on PATH after global install) instead of hardcoding `/absolute/path/to/mem-mcp`. Survives reinstalls.
5. **Recommend `bun install -g` as primary** — `npm install -g` with `#!/usr/bin/env bun` shebang has known PATH fragility (nvm, fnm, etc.). `bun install -g` resolves this by ensuring the installing runtime matches the executing runtime.

Additional notes:
- **CLAUDE.md injection risk**: Writing to `~/.claude/CLAUDE.md` is a supply chain vector if the npm package is compromised. Mitigate by making the CLAUDE.md append auditable (print what will be added, require `--yes` on first run).
- **`--update` versioning**: For v1, `--update` does a full overwrite of hooks/commands/guides. Version-aware diffing is v2 scope.
- **Schema compatibility**: Ship as 0.x (pre-1.0) to signal schema may change. Current version is 0.5.0 which is already correct.

---

## Phase 1: package.json Changes

**File:** `package.json`

1. **name**: `"recall"` → `"recall-memory"`
2. **files** (CRITICAL — prevents publishing local config):
   ```json
   "files": [
     "dist/",
     "hooks/",
     "commands/",
     "FOR_CLAUDE.md",
     "FOR_OPENCODE.md",
     "FOR_PI.md",
     "README.md"
   ]
   ```
3. **engines**: `"node": ">=18"` → `"bun": ">=1.0.0"`
4. **scripts** additions:
   - `"prepublishOnly": "bun run build"` — ensures fresh dist before publish
5. **publishConfig**: `{ "access": "public" }`
6. **repository/homepage/bugs** (npm best practice):
   ```json
   "repository": { "type": "git", "url": "https://github.com/edheltzel/Recall.git" },
   "homepage": "https://github.com/edheltzel/Recall",
   "bugs": "https://github.com/edheltzel/Recall/issues"
   ```
7. **keywords**: `["claude-code", "memory", "mcp", "persistent-memory", "recall", "sqlite", "bun"]`

---

## Phase 2: First-Run Guard

**File:** `src/index.ts` (or new `src/lib/setup-check.ts`)

Before any `mem` command except `setup` and `init`, check if Recall is configured:
```typescript
function isSetupComplete(): boolean {
  const dbPath = join(homedir(), '.claude', 'memory.db');
  return existsSync(dbPath);
}
```

If not configured, print:
```
Recall is not configured yet. Run: mem setup
```

This prevents the silent failure mode where users install but never run setup.

---

## Phase 3: Create `mem setup` Command

**New file:** `src/commands/setup.ts`

### Package root resolution
```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..'); // dist/ → package root
```

### Setup steps (all idempotent)
1. **Check Bun** — verify `bun` is available, print version
2. **Detect platforms** — Claude Code (`~/.claude/`), OpenCode (`opencode` in PATH), Pi (`pi` in PATH)
3. **Create backup** — `~/.claude/backups/recall/<timestamp>/`
4. **Initialize DB** — call existing `runInit()` from `src/commands/init.ts`
5. **Configure MCP** — try `claude mcp add`, fallback to settings.json write. **Use `mem-mcp` command name, NOT absolute path** (survives reinstalls since it's on PATH after global install)
6. **Deploy hooks** — copy **entire `hooks/` directory tree** (including `hooks/lib/`) to `~/.claude/hooks/recall/`. This preserves relative imports.
7. **Register hooks** — add Stop + SessionStart entries to settings.json, pointing to `~/.claude/hooks/recall/SessionExtract.ts` etc.
8. **Deploy slash commands** — copy `commands/recall/*.md` → `~/.claude/commands/recall/`
9. **Deploy guide** — copy `FOR_CLAUDE.md` → `~/.claude/Recall_GUIDE.md`
10. **Configure CLAUDE.md** — print the section that will be appended, append only if not present
11. **OpenCode setup** (if detected) — MCP, plugins, guide
12. **Pi setup** (if detected) — adapter, MCP, extensions, guide

### Key design choice: hooks go to `~/.claude/hooks/recall/`
Instead of copying flat files to `~/.claude/hooks/`, copy the full hooks directory to `~/.claude/hooks/recall/`. This preserves the `lib/` subdirectory and all relative imports. Hook registrations in settings.json point to `~/.claude/hooks/recall/SessionExtract.ts`.

### CLI options
```
mem setup                    # Full setup, all detected platforms
mem setup --platform claude  # Only Claude Code
mem setup --no-backup        # Skip backup step
mem setup --update           # Re-deploy hooks/commands/guide (for upgrades)
```

---

## Phase 4: Wire `setup` into CLI

**File:** `src/index.ts`

```typescript
import { runSetup } from './commands/setup.js';

program
  .command('setup')
  .description('Configure Recall in your AI coding environment')
  .option('--platform <platform>', 'Target platform: claude, opencode, pi, all', 'all')
  .option('--no-backup', 'Skip backup step')
  .option('--update', 'Update hooks and commands only (for upgrades)')
  .action(async (options) => { await runSetup(options); });
```

---

## Phase 5: Update README

**File:** `README.md`

Update Quick Start — `bun install -g` as primary:
```markdown
## Quick Start

### Install from npm
```bash
bun install -g recall-memory   # recommended
mem setup                      # configure hooks, MCP, database
```

Alternatively: `npm install -g recall-memory` (requires Bun on PATH).

### Install from source
```bash
git clone https://github.com/edheltzel/Recall.git
cd Recall && ./install.sh
```
```

---

## Phase 6: Update docs

- `docs/installation.md` — add npm/bun install section, document Bun requirement
- `docs/upgrading.md` — add `bun install -g recall-memory && mem setup --update`
- `CLAUDE.md` — note the dual install paths

---

## Phase 7: Retain install.sh

Keep install.sh as-is for source installs. Both paths coexist, producing identical configured state. `install.sh` also retains the `restore` subcommand.

---

## Phase 8: Test + Publish

1. `bun run build` — fresh dist
2. `npm pack --dry-run` — **MANDATORY: verify no `.claude/` files, no `tests/`, no `assets/`**
3. `npm pack` — create tarball
4. Test locally: `bun install -g ./recall-memory-0.5.0.tgz`
5. Verify first-run guard: `mem stats` → should print "Run `mem setup` first"
6. `mem setup` → completes all steps
7. Verify: `mem stats`, `mem doctor`, hooks registered
8. `bun test` — all existing tests pass
9. `npm publish` (requires npm account + `npm login`)

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `package.json` | Modify — name, files, engines, scripts, publishConfig, metadata |
| `src/commands/setup.ts` | Create — main setup logic (~300-400 lines, ports install.sh) |
| `src/index.ts` | Modify — wire setup command + first-run guard |
| `README.md` | Modify — bun install -g as primary Quick Start |
| `docs/installation.md` | Modify — add npm/bun install section |
| `docs/upgrading.md` | Modify — add npm upgrade path |

---

## Verification

1. `npm pack --dry-run` — shows only `dist/`, `hooks/`, `commands/`, guides, README
2. No `.claude/` files in tarball
3. Local tarball install: `bun install -g ./recall-memory-*.tgz`
4. `which mem` — resolves to global install path
5. `mem stats` (before setup) — prints "Run `mem setup` first"
6. `mem setup` — completes all steps, hooks deployed to `~/.claude/hooks/recall/`, MCP registered with `mem-mcp` command name
7. `mem stats` — DB initialized, shows record counts
8. `mem doctor` — health check passes
9. New Claude Code session loads SessionRecall context
10. `bun test` — all 228+ tests pass
