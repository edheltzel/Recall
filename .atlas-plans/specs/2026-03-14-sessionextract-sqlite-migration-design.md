# SessionExtract SQLite Migration — Design Spec

**Date:** 2026-03-14
**Status:** Draft
**Effort:** Advanced (~8-12 hours)
**Approach:** B — Migrate mutable extraction state from JSON files to SQLite

---

## Problem Statement

SessionExtract.ts is a Stop hook that extracts conversation sessions into structured summaries. It has systemic concurrency bugs caused by multiple background processes writing to shared JSON files without mutual exclusion.

**Observed symptoms:**
- Multiple extractions of the same session (duplicate entries)
- Zombie/orphaned background processes accumulating
- Extraction failures and silent data corruption
- High resource usage (84 concurrent extractors observed in logs)
- System destabilization (audio driver becomes unresponsive from resource exhaustion)

**Root cause chain:**
1. No global concurrency cap — unlimited background extractors can spawn simultaneously
2. Non-atomic file writes — all shared JSON files use read-modify-write with plain `writeFileSync`
3. Lock scope mismatch — per-conversation locks don't protect shared output files
4. 80% quality gate failure rate — Haiku fails on short sessions, creating permanent retry backlog
5. Lock not released on multiple crash paths

---

## Investigation Evidence

Four parallel agents analyzed the system:

- **Architect:** Found 9 issues. Key: non-atomic tracker R-M-W (HIGH), unprotected concurrent writes to HOT_RECALL/SESSION_INDEX (HIGH), stale lock TOCTOU (MEDIUM). Recommended SQLite migration.
- **Engineer:** Found 26 issues across lock mechanism, file I/O, API calls, memory usage, and code duplication. Key: 5 HIGH severity file I/O issues, lock mechanism has correctness holes.
- **Intern (Forensics):** 84 concurrent processes observed. 909/1112 extractions failed (81.7%). 12,970 session files (92.1%) never tracked. TOCTOU race captured in log data. Memory files currently intact but structurally at risk.
- **Research:** bun:test is battle-tested and recommended. Vitest on Bun is experimental. Step-through debugging via `bun --inspect-brk` works. Race condition testing uses `Bun.spawn` + `Promise.all`.

---

## Design

### Section 1: SQLite Tables (Replace JSON Files)

Three new tables in `~/.claude/memory.db`:

#### `extraction_tracker` (replaces `.extraction_tracker.json`)

```sql
CREATE TABLE IF NOT EXISTS extraction_tracker (
  conversation_path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  extracted_at TEXT,
  failed_at TEXT,
  retry_after TEXT,
  error TEXT,
  skipped INTEGER DEFAULT 0
);
```

- `INSERT OR REPLACE` for atomic upsert (no read-modify-write)
- `skipped = 1` for sessions too short to extract

#### `extraction_sessions` (replaces `SESSION_INDEX.json`)

```sql
CREATE TABLE IF NOT EXISTS extraction_sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT,
  branch TEXT,
  timestamp TEXT NOT NULL,
  summary TEXT,
  topics TEXT,  -- JSON array
  conversation_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_extraction_sessions_ts ON extraction_sessions(timestamp DESC);
```

- Also replaces `HOT_RECALL.md` — generate on-demand: `SELECT * FROM extraction_sessions ORDER BY timestamp DESC LIMIT 10`
- Concurrent-safe reads/writes via WAL mode

#### `extraction_errors` (replaces `ERROR_PATTERNS.json`)

```sql
CREATE TABLE IF NOT EXISTS extraction_errors (
  error_key TEXT PRIMARY KEY,
  error TEXT NOT NULL,
  fix TEXT,
  context TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
```

- `INSERT OR REPLACE` with `first_seen = MIN(first_seen, new)` handles dedup natively
- No concurrent read-modify-write needed

**Files that remain as-is:**
- `DISTILLED.md` — append-only archive (`appendFileSync`, POSIX-atomic for small writes)
- `DECISIONS.log` — append-only (`appendFileSync`)
- `REJECTIONS.log` — append-only (`appendFileSync`)

**File eliminated:**
- `HOT_RECALL.md` — replaced by on-demand query from `extraction_sessions`

### Section 2: Concurrency Cap

Replace unlimited background spawning with a SQLite-based counting semaphore:

```sql
CREATE TABLE IF NOT EXISTS extraction_locks (
  conversation_path TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL
);
```

**Acquisition:**
1. Count active locks: `SELECT COUNT(*) FROM extraction_locks`
2. If >= `MAX_CONCURRENT_EXTRACTIONS` (default: 3), skip — BatchExtract will pick it up
3. Otherwise: `INSERT OR IGNORE INTO extraction_locks VALUES (?, ?, datetime('now'))`
4. If insert returns 0 changes, another process got it first — skip

**Release:**
- `DELETE FROM extraction_locks WHERE conversation_path = ?`
- Called in `finally` block to guarantee release on all paths

**Stale cleanup:**
- On every acquisition attempt: `DELETE FROM extraction_locks WHERE started_at < datetime('now', '-10 minutes')`
- Additionally validate PID liveness: `kill(pid, 0)` — if process doesn't exist, remove lock

**This replaces:** Per-conversation `.lock` files, stale lock detection via mtime, lock filename collision issues, parent/child PID mismatch. One mechanism instead of two.

### Section 3: Quality Gate Fix

Current: 80.1% failure rate because Haiku doesn't produce `ONE SENTENCE SUMMARY` / `MAIN IDEAS` headers for short sessions.

**Changes:**

1. **Skip threshold:** Sessions with < 500 chars of actual content (after stripping tool results/thinking blocks) are marked `skipped = 1` in tracker. No API call, no retry, no cost.

2. **Adaptive prompt:** For sessions with 500-2,000 chars, use a simplified prompt that asks for a brief summary without requiring specific section headers. Full structured prompt only for sessions > 2,000 chars.

3. **Relaxed quality gate:** Accept extractions that contain *any* meaningful content (> 100 chars of non-whitespace output). The current rigid header check rejects valid summaries that simply use different formatting.

4. **Failure categorization:** Track `error` field in tracker to distinguish between:
   - `quality_gate` — output didn't meet quality threshold
   - `api_error` — Claude/Ollama API failure
   - `timeout` — extraction timed out
   - `skipped` — session too short

### Section 4: Lock Mechanism Redesign

The entire file-based lock system is replaced by the `extraction_locks` table (Section 2). Specific fixes:

- **TOCTOU eliminated:** `INSERT OR IGNORE` is atomic — no read-then-check-then-write gap
- **No filename collision:** Primary key is the full path string, not a munged filename
- **No stale lock TOCTOU:** Cleanup is a single `DELETE WHERE` with PID validation
- **Crash-safe:** If process dies without releasing, stale cleanup handles it on next attempt
- **No parent/child PID mismatch:** The child process acquires its own lock (parent no longer acquires)

**Changed flow:**
1. Parent receives Stop event
2. Parent checks `extraction_tracker` — if already extracted, exit
3. Parent spawns detached child with `--extract`
4. Child acquires lock via `extraction_locks` INSERT (not parent)
5. Child performs extraction
6. Child updates `extraction_tracker`, releases lock in `finally` block

### Section 5: Test Harness

Using **bun:test** (already in project, battle-tested, fastest).

**New test files:**

1. **`tests/hooks/extraction-tracker.test.ts`** — Unit tests for tracker CRUD operations against SQLite. Insert, update, query, skip threshold, failure categorization.

2. **`tests/hooks/extraction-locks.test.ts`** — Lock acquire/release, concurrency cap enforcement, stale lock cleanup, PID validation.

3. **`tests/hooks/extraction-concurrency.test.ts`** — Integration tests using `Bun.spawn` to simulate multiple concurrent extractors. Assert only N proceed, no data corruption, proper lock cleanup on crash (SIGKILL a child mid-extraction).

4. **`tests/hooks/quality-gate.test.ts`** — Verify skip threshold, adaptive prompt selection, relaxed quality gate acceptance/rejection.

5. **`tests/hooks/migration.test.ts`** — Verify JSON-to-SQLite migration produces correct data. Round-trip test: export from JSON, import to SQLite, verify row counts and values match.

**Testing race conditions:**
```typescript
// Spawn 10 concurrent extractors for the same session
const children = Array.from({ length: 10 }, () =>
  Bun.spawn(['bun', 'run', 'SessionExtract.ts', '--extract', convPath, cwd])
);
await Promise.all(children.map(c => c.exited));
// Assert: exactly 1 extraction succeeded, 9 were blocked by lock
```

**Debugging:** `bun --inspect-brk test` for step-through when needed (WebKit Inspector at `debug.bun.sh`).

### Section 6: Migration Path

1. **Schema update:** Add `CREATE TABLE IF NOT EXISTS` for all 4 new tables in `src/db/schema.ts`
2. **Migrate tracker:** Read `.extraction_tracker.json` → bulk `INSERT` 1,112 entries into `extraction_tracker`
3. **Migrate session index:** Read `SESSION_INDEX.json` → bulk `INSERT` 208 entries into `extraction_sessions`
4. **Migrate error patterns:** Read `ERROR_PATTERNS.json` → bulk `INSERT` into `extraction_errors`
5. **Backup originals:** Rename `.extraction_tracker.json` → `.extraction_tracker.json.bak`, etc.
6. **Update HOT_RECALL consumers:** Any code reading `HOT_RECALL.md` now queries `extraction_sessions` table instead
7. **Update `mem doctor`:** Check new tables exist and have data, remove checks for old JSON files
8. **Update `install.sh`:** Remove any references to creating/copying JSON tracker files

**Rollback:** If migration fails, `.bak` files remain. Old code paths can be restored by reverting the git worktree branch.

---

## Execution Plan (Test-First)

All work happens in a **git worktree** for isolation. **No real data is touched until Phase 7 passes.** Each phase is a ratchet — tests must pass before implementation, implementation must pass tests before proceeding.

**66 tests across 8 phases. Real data migration happens ONLY after all 66 pass.**

### Phase 0 — Fixture Infrastructure (no code, no tests)
- Create `tests/fixtures/extraction/` with synthetic JSON fixtures
- Tracker fixtures: `nominal.json` (5 entries, all status variants), `empty.json`, `corrupted.json`, `missing_fields.json`
- Session index fixtures: `nominal.json` (4 entries), `empty.json`, `corrupted.json`, `missing_fields.json`
- Error patterns fixture, sample conversation JSONL
- Create `tests/helpers/migrationSetup.ts` (isolated temp DB helper)
- Create `tests/helpers/concurrency_worker.ts` (spawnable child for race tests)
- **Gate:** All fixture files exist and parse as valid JSON

### Phase 1 — Schema Tests (8 tests)
- **TEST FIRST:** `tests/db/extraction-schema.test.ts`
- Tests: PRAGMA table_info for all 4 tables, UNIQUE constraints, WAL checkpoint survival
- **Gate:** 8 tests pass → THEN write DDL in `src/db/schema.ts`

### Phase 2 — Tracker Logic Tests (11 tests)
- **TEST FIRST:** `tests/lib/extraction-tracker.test.ts`
- Tests: getRecord, markAsExtracted, markAsFailed, wasAlreadyExtracted (same size, growth >50%, retry elapsed, within cooldown), upsert idempotency
- **Gate:** 11 tests pass → THEN implement tracker CRUD functions

### Phase 3 — Semaphore Tests (9 tests)
- **TEST FIRST:** `tests/lib/extraction-semaphore.test.ts`
- Tests: acquire below/at max, expired lock cleanup, release, active count
- Concurrency tests: 4 Bun.spawn workers racing (3 acquire, 1 rejected), SIGKILL crash recovery
- **Gate:** 9 tests pass → THEN implement semaphore functions

### Phase 4 — Migration Tests (14 tests)
- **TEST FIRST:** `tests/lib/extraction-migration.test.ts`
- Tests: row count integrity, field preservation, idempotency (run twice = same rows), empty file handling, corrupted JSON handling, source files never modified
- **Gate:** 14 tests pass → THEN write migration script

### Phase 5 — Quality Gate Tests (8 tests)
- **TEST FIRST:** `tests/lib/extraction-quality.test.ts`
- Tests: pass/fail evaluation, skip threshold (<500 chars), adaptive prompt selection, relaxed gate acceptance
- **Gate:** 8 tests pass → THEN implement quality gate logic

### Phase 6 — Lock Redesign Tests (10 tests)
- **TEST FIRST:** `tests/lib/extraction-lock.test.ts`
- Tests: child acquire/release, parent read lock state, expired lock replacement, cross-process Bun.spawn tests
- **Gate:** 10 tests pass → THEN implement SQLite lock functions

### Phase 7 — End-to-End Integration (6 tests)
- **TEST FIRST:** `tests/integration/extraction-sqlite-migration.test.ts`
- Tests: full migration of fixtures, extraction flow through SQLite (not JSON), concurrency (4 hooks → 3 succeed), thin conversation skip, retry logic, **no real files touched** (mtime assertion on ~/.claude/memory.db)
- **Gate:** 6 tests pass → ONLY THEN safe to touch real data

### Phase 8 — Real Data Migration
- Back up all JSON files as `.bak`
- Run `mem init` to apply schema migration to real `memory.db`
- Run `migrateAll` against real JSON files
- Verify with `mem doctor`
- Red Team validation of all findings
- Manual extraction test (end a real session)

---

## Anti-Goals

- No daemon/service architecture (Approach C was rejected)
- No vitest migration (bun:test stays)
- No changes to MCP server or CLI commands
- No changes to the extraction prompt content (only the gate logic)
- No backfilling the 12,970 untracked historical sessions (separate effort if desired)
