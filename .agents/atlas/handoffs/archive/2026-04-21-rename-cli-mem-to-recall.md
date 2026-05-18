---
title: Rename CLI — mem → recall (prioritized execution)
parent_plan: 2026-04-20-rename-mem-cli-to-recall.md
phase: Commit 1 — Foundation / fallback
status: Not Started
percent_complete: 0
last_updated: 2026-04-21
blockers: none
next_action: Enter worktree, then modify `getDbPath()` in `src/db/connection.ts` with a silent `RECALL_DB_PATH` → `MEM_DB_PATH` → default fallback chain. Update `tests/helpers/setup.ts` + `teardownTestDb()` to use `RECALL_DB_PATH`. `bun test` must stay green.
---

# Rename CLI — mem → recall (prioritized execution)

**Parent plan:** [Rename CLI: mem → recall](../plans/2026-04-20-rename-mem-cli-to-recall.md) · **Phase:** Commit 1 — Foundation / fallback

## Context

The project is called **Recall** but the CLI binary is `mem` and the MCP server binary is `mem-mcp`. Single-user install (Ed only). Hard-cut rename to **v1.0.0** with a silent env-var fallback for one version.

The plan has been through two rounds of adversarial red-teaming (general-purpose + CodexResearcher) and 19 findings were integrated — including 3 blockers the first draft missed (hooks `SessionRecall.ts` / `SessionPreCompact.ts` reading `MEM_DB_PATH` directly, `uninstall.sh` entirely out of scope, and the `tests/opencode-integration.test.ts` fixture that would have become a false positive).

**Status at handoff:** nothing implemented yet. All tables, visuals, and priority lists are planning artifacts. Commit 1 is the first line of real work.

### Priority-ordered execution

| Priority | Commit | Batch | Files to touch | Why this slot |
|---|---|---|---|---|
| **1** 🟢 | C1 | **Foundation / fallback** | `src/db/connection.ts`<br>`tests/helpers/setup.ts` (and `teardownTestDb`) | Zero risk — adds fallback + updates test harness. Tests stay green. Unlocks the chain |
| **2** 🟢 | C2 | **Hook fallbacks (blocker)** | `hooks/SessionRecall.ts:46`<br>`hooks/SessionPreCompact.ts:74` | Must land before binary rename so hooks survive. Pure additions |
| **3** 🟡 | C3 | **Binary + user strings** | `package.json` (bin + version 1.0.0)<br>`src/index.ts:33`<br>`src/commands/doctor.ts:297,428`<br>All `src/commands/*.ts` user strings | The visible rename. No `bun link` inside the worktree |
| **4** 🟠 | C4 | **Installer surgery (blocker)** | `install.sh` (90-98, 180, 183)<br>`lib/install-lib.sh` (10 sites + new `recall_cleanup_legacy`)<br>`update.sh` (lines 252-340)<br>`uninstall.sh` (108, 303) | `recall_cleanup_legacy` is load-bearing — it migrates the live system safely |
| **5** 🟡 | C5 | **Plugins + slash commands** | `pi/recall-compaction.ts:22`<br>`opencode/recall-compaction.ts:25`<br>`commands/recall/*.md` (8 files) | Mechanical; low risk |
| **6** 🟠 | C6 | **Remaining test fixtures (blocker)** | `tests/opencode-integration.test.ts:484,496`<br>`tests/install/uninstall.test.ts:149`<br>`tests/hooks/SessionRecall.test.ts` (7 occ)<br>`tests/hooks/session-precompact.test.ts` (5)<br>`tests/db/extraction-schema.test.ts` (2)<br>`tests/db/connection.test.ts`<br>`tests/benchmarks/suite-b.test.ts` 🆕 | Plan missed `suite-b.test.ts` — add to scope. Fixture updates keep tests asserting on real behavior |
| **7** 🟢 | C7 | **Documentation sweep** | **Root (6):** `CHANGELOG.md`, `CLAUDE.md`, `FOR_CLAUDE.md`, `FOR_OPENCODE.md`, `FOR_PI.md`, `ACKNOWLEDGMENTS.md`<br>**docs/ (10):** `installation.md`, `cli-reference.md` (89 refs — biggest), `architecture.md`, `mcp-tools.md`, `OPENCODE_INTEGRATION.md`, `PI_INTEGRATION.md`, `slash-commands.md`, `troubleshooting.md`, `upgrading.md`, `releasing.md`<br>**Subdir:** `benchmarks/README.md`, `opencode/recall-memory.md`, `hooks/extract_prompt.md`<br>`README.md` | High volume, low risk, parallelizable |
| **8** 🟢 | C8 | **VHS tapes + CHANGELOG** | `assets/demo-*.tape`<br>`CHANGELOG.md` v1.0.0 entry | GIF re-render deferred |
| **M** 🔴 | Post | **Merge + install + restart** | Merge worktree → main<br>`ExitWorktree action: remove`<br>`./install.sh` **from main**<br>Restart Claude Code | Only destructive step. Worktree-local `bun link` leaves dangling symlinks |

### Key design decisions already locked (from red-team)

- **No new `src/lib/env.ts`** — modify `getDbPath()` in place at `src/db/connection.ts:15-17`. Single call site, no reuse justifies a new module.
- **Silent fallback** — no `console.warn` deprecation. Guard-once-per-process is complexity for zero value because no call site calls `getDbPath()` more than once.
- **Version → 1.0.0** (not 0.8.0). The v2 foundation (decisions#49) already shipped; this is the name catching up.
- **MCP tool names unchanged** (`memory_search`, `memory_add`, …) — they are the stable public API, agents call them by bare name.
- **MCP server ID unchanged** (`recall-memory`) — cosmetic rename, zero user value.
- **Worktree → merge → install from main** — `bun link` inside the worktree leaves dangling symlinks after `ExitWorktree`.
- **Test harness (`setup.ts` + `teardownTestDb`) moves into Commit 1**, not Commit 5. Ensures the fallback is never exercised during test runs → zero stderr noise.

### Critical evidence (pre-migration baseline, verified 2026-04-21)

```
package.json       "mem" / "mem-mcp"  · version 0.7.22
src/index.ts:33    .name('mem')
src/db/connection.ts:15-17  process.env.MEM_DB_PATH || DEFAULT_DB_PATH
src/commands/doctor.ts:297   spawnSync('mem-mcp', …)
src/commands/doctor.ts:428   'mem doctor — Memory Subsystem Health Check'
hooks/SessionRecall.ts:46    raw process.env.MEM_DB_PATH read
hooks/SessionPreCompact.ts:74  raw process.env.MEM_DB_PATH read
lib/install-lib.sh           10 mem-mcp refs · 0 recall-mcp · no recall_cleanup_legacy
commands/recall/*.md         7 files still call `mem …`
pi/recall-compaction.ts:22   execFileSync("mem", …)
opencode/recall-compaction.ts:25  execFileSync("mem", …)
tests/ files with MEM_DB_PATH: 7 (setup.ts, connection.test.ts, extraction-schema.test.ts,
                                  SessionRecall.test.ts, session-precompact.test.ts,
                                  opencode-integration.test.ts, suite-b.test.ts)
uninstall.sh                 2 mem/mem-mcp refs remain
~/.bun/bin/mem               → ../install/global/node_modules/recall/dist/index.js (live)
~/.bun/bin/mem-mcp           → .../dist/mcp-server.js (live)
~/.claude/settings.json      "recall-memory".args still points at /Users/ed/.bun/bin/mem-mcp
```

### Supporting artifacts

- **Plan:** `.atlas/plans/2026-04-20-rename-mem-cli-to-recall.md`
- **Red-team visual:** `.atlas/reviews/2026-04-21-red-team-rename-cli.html` (19 findings, filterable)

## Next action

**Start Commit 1** — zero-risk foundation:

1. `EnterWorktree` with name `rename-mem-to-recall`
2. Open `src/db/connection.ts:15-17` and replace `getDbPath()` body with:
   ```ts
   return (
     process.env.RECALL_DB_PATH ||
     process.env.MEM_DB_PATH ||   // removed in v1.1.0
     DEFAULT_DB_PATH
   );
   ```
3. Open `tests/helpers/setup.ts:12` — set `process.env.RECALL_DB_PATH = dbPath;`
4. Open `tests/helpers/setup.ts:22` (or wherever `teardownTestDb` lives) — delete BOTH `RECALL_DB_PATH` and `MEM_DB_PATH`
5. `bun test` — must be all green
6. `bun run lint` — clean
7. Commit with a message like `feat: getDbPath fallback for RECALL_DB_PATH; update test harness`

Then proceed to Commit 2 (hooks).

## Blockers

None. Plan is fully red-teamed and every blocker-class finding has been integrated.

## Resume

After `/clear`, run `/Standup` — this handoff will surface in the next standup board and be archived on pickup.
