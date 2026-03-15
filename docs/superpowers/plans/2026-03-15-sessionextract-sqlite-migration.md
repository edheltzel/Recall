# SessionExtract SQLite Migration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate SessionExtract's mutable state from race-prone JSON files to SQLite, add concurrency caps, fix 80% quality gate failure rate.

**Architecture:** Replace 3 JSON files + file-based locks with 4 SQLite tables in existing memory.db (WAL mode). Test-first: 66 tests across 8 phases. No real data touched until all tests pass. Logic written as importable modules, then inlined into the self-contained hook at build.

**Tech Stack:** Bun, bun:test, bun:sqlite, SQLite WAL mode

**Design Spec:** `docs/superpowers/specs/2026-03-14-sessionextract-sqlite-migration-design.md`

**Visual Overview:** `~/.agent/diagrams/sessionextract-sqlite-migration.html`

---

## Prerequisites

- [ ] **Create git worktree for isolation**

```bash
cd /Users/ed/Developer/atlas-recall
git worktree add .claude/worktrees/sqlite-migration -b feat/sessionextract-sqlite-migration
cd .claude/worktrees/sqlite-migration
```

---

## File Structure

**New files to create:**

```
hooks/
  lib/
    extraction-db.ts          # SQLite connection for hooks (standalone, no src/ imports)
    extraction-tracker.ts     # Tracker CRUD: markAsExtracted, markAsFailed, wasAlreadyExtracted
    extraction-semaphore.ts   # Counting semaphore: acquire, release, sweep
    extraction-lock.ts        # Lock redesign: childAcquire, parentIsHeld, childRelease
    extraction-quality.ts     # Quality gate: evaluateQuality, shouldSkip, buildAdaptivePrompt
    extraction-migration.ts   # JSON to SQLite migration: migrateAll, per-table functions
src/db/
  schema.ts                   # MODIFY: Add 4 new tables, bump SCHEMA_VERSION to 4
tests/
  fixtures/extraction/
    tracker/
      nominal.json            # 5 entries: extracted, failed x2, pending, retry-elapsed
      empty.json              # {}
      corrupted.json          # Invalid JSON
      missing_fields.json     # Edge cases
    session-index/
      nominal.json            # 4 entries across 2 projects
      empty.json              # []
      corrupted.json          # Truncated array
      missing_fields.json     # No topics, no summary, null timestamp
    error-patterns/
      nominal.json            # 3 error/fix pairs
      empty.json              # { "patterns": [] }
    quality/
      pass.txt                # Valid extraction output
      fail-thin.txt           # Below word count threshold
      fail-no-sections.txt    # Missing required sections
    conversation-tiny.jsonl   # 5 messages, less than 500 chars content
    conversation-adequate.jsonl # 20 messages, over 2000 chars content
  helpers/
    migrationSetup.ts         # Isolated temp DB for migration tests
    concurrency_worker.ts     # Spawnable child for Bun.spawn race tests
  db/
    extraction-schema.test.ts # Phase 1: DDL tests
  lib/
    extraction-tracker.test.ts    # Phase 2: Tracker CRUD tests
    extraction-semaphore.test.ts  # Phase 3: Semaphore tests
    extraction-migration.test.ts  # Phase 4: Migration tests
    extraction-quality.test.ts    # Phase 5: Quality gate tests
    extraction-lock.test.ts       # Phase 6: Lock redesign tests
  integration/
    extraction-sqlite-migration.test.ts  # Phase 7: E2E integration
```

**Key constraint:** All `hooks/lib/*.ts` modules must be standalone. They cannot import from `src/`. They use `bun:sqlite` directly with a DB path parameter. For testing, tests pass a temp DB path. For production, the hook passes the real `~/.claude/memory.db` path.

---

## Chunk 1: Phase 0 — Fixtures and Test Helpers

### Task 1: Create tracker fixtures

**Files:**
- Create: `tests/fixtures/extraction/tracker/nominal.json`
- Create: `tests/fixtures/extraction/tracker/empty.json`
- Create: `tests/fixtures/extraction/tracker/corrupted.json`
- Create: `tests/fixtures/extraction/tracker/missing_fields.json`

- [ ] **Step 1:** Create `tests/fixtures/extraction/tracker/` directory
- [ ] **Step 2:** Write `nominal.json` — 5 entries: one extracted, two failed (one with past retryAfter, one with future), one pending (size only, no timestamps), one extracted with large size
- [ ] **Step 3:** Write `empty.json` as `{}`
- [ ] **Step 4:** Write `corrupted.json` as `{"path": "unterminated` (intentionally invalid)
- [ ] **Step 5:** Write `missing_fields.json` — entries with: no size field, zero size, retryAfter without failedAt, empty extractedAt string, far-future retryAfter
- [ ] **Step 6:** Validate: `for f in tests/fixtures/extraction/tracker/*.json; do bun -e "JSON.parse(require('fs').readFileSync('$f','utf-8'))"; done` — nominal/empty/missing pass, corrupted fails
- [ ] **Step 7:** Commit: `git commit -m "test: add extraction tracker fixtures"`

### Task 2: Create session index fixtures

**Files:**
- Create: `tests/fixtures/extraction/session-index/nominal.json`
- Create: `tests/fixtures/extraction/session-index/empty.json`
- Create: `tests/fixtures/extraction/session-index/corrupted.json`
- Create: `tests/fixtures/extraction/session-index/missing_fields.json`

- [ ] **Step 1:** Write `nominal.json` — 4 SessionIndexEntry objects across 2 projects, varying timestamps, one with empty topics array
- [ ] **Step 2:** Write `empty.json` as `[]`, `corrupted.json` as truncated array
- [ ] **Step 3:** Write `missing_fields.json` — entries with no topics, no summary, null timestamp
- [ ] **Step 4:** Commit: `git commit -m "test: add session index fixtures"`

### Task 3: Create error patterns, quality, and conversation fixtures

**Files:**
- Create: `tests/fixtures/extraction/error-patterns/nominal.json`
- Create: `tests/fixtures/extraction/error-patterns/empty.json`
- Create: `tests/fixtures/extraction/quality/pass.txt`
- Create: `tests/fixtures/extraction/quality/fail-thin.txt`
- Create: `tests/fixtures/extraction/quality/fail-no-sections.txt`
- Create: `tests/fixtures/extraction/conversation-tiny.jsonl`
- Create: `tests/fixtures/extraction/conversation-adequate.jsonl`

- [ ] **Step 1:** Write error pattern fixtures — `nominal.json` with 3 error/fix pairs, `empty.json` with empty patterns array
- [ ] **Step 2:** Write quality gate fixtures — `pass.txt` with valid extraction output (ONE SENTENCE SUMMARY + MAIN IDEAS headers), `fail-thin.txt` with less than 50 words, `fail-no-sections.txt` with adequate length but no section headers
- [ ] **Step 3:** Write `conversation-tiny.jsonl` — 5 JSONL messages, under 500 chars of actual user/assistant content
- [ ] **Step 4:** Write `conversation-adequate.jsonl` — 20+ JSONL messages, over 2000 chars of content, realistic debugging session
- [ ] **Step 5:** Commit: `git commit -m "test: add error pattern, quality, and conversation fixtures"`

### Task 4: Create test helpers

**Files:**
- Create: `tests/helpers/migrationSetup.ts`
- Create: `tests/helpers/concurrency_worker.ts`

- [ ] **Step 1:** Write `migrationSetup.ts` — creates temp dir via `mkdtempSync`, opens `bun:sqlite` Database with WAL mode, runs extraction DDL only (not full schema), exports `setupMigrationDb()`, `teardownMigrationDb()`, `getMigrationDb()`
- [ ] **Step 2:** Write `concurrency_worker.ts` — standalone Bun script that reads DB_PATH, WORKER_ID, MAX_CONCURRENT, HOLD_MS from env vars. Creates concurrency_results table if not exists. Attempts semaphore acquire, records result, sleeps HOLD_MS if acquired, releases, exits 0 (acquired) or 1 (rejected)
- [ ] **Step 3:** Verify worker runs: `DB_PATH=/tmp/test.db WORKER_ID=w0 bun tests/helpers/concurrency_worker.ts` — should exit 0
- [ ] **Step 4:** Commit: `git commit -m "test: add migration DB helper and concurrency worker"`

---

## Chunk 2: Phases 1-2 — Schema and Tracker

### Task 5: Schema tests and implementation (Phase 1 — 8 tests)

**Files:**
- Create: `tests/db/extraction-schema.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/connection.ts`

- [ ] **Step 1:** Write `tests/db/extraction-schema.test.ts` with 8 tests:
  - extraction_tracker: has all required columns (PRAGMA table_info)
  - extraction_tracker: conversation_path has UNIQUE constraint
  - extraction_sessions: has all required columns
  - extraction_errors: has all required columns
  - extraction_locks: has all required columns
  - extraction_locks: conversation_path has UNIQUE constraint
  - schema version is 4
  - all 4 tables survive WAL checkpoint
- [ ] **Step 2:** Run tests, verify FAIL (tables do not exist yet)
  - Run: `bun test tests/db/extraction-schema.test.ts`
  - Expected: FAIL
- [ ] **Step 3:** Add 4 CREATE TABLE statements to `CREATE_TABLES` in `src/db/schema.ts`
- [ ] **Step 4:** Add indexes to `CREATE_INDEXES` in `src/db/schema.ts`
- [ ] **Step 5:** Bump `SCHEMA_VERSION` from 3 to 4
- [ ] **Step 6:** Add v3-to-v4 migration in `initDb()` in `src/db/connection.ts`
- [ ] **Step 7:** Run tests, verify PASS
  - Run: `bun test tests/db/extraction-schema.test.ts`
  - Expected: 8 PASS
- [ ] **Step 8:** Run full test suite, verify no regressions
  - Run: `bun test`
  - Expected: all existing tests still pass
- [ ] **Step 9:** Commit: `git commit -m "feat: add extraction SQLite tables (tracker, sessions, errors, locks)"`

### Task 6: Tracker logic tests and implementation (Phase 2 — 11 tests)

**Files:**
- Create: `tests/lib/extraction-tracker.test.ts`
- Create: `hooks/lib/extraction-tracker.ts`

- [ ] **Step 1:** Write `tests/lib/extraction-tracker.test.ts` with 11 tests:
  - getExtractionRecord: returns null for unknown path
  - getExtractionRecord: returns record after markAsExtracted
  - getExtractionRecord: returns record after markAsFailed (with retry_after ~24h from now)
  - wasAlreadyExtracted: returns false for unknown path
  - wasAlreadyExtracted: returns true for extracted with same size
  - wasAlreadyExtracted: returns false when file grew over 50%
  - wasAlreadyExtracted: returns false when retry window has elapsed
  - wasAlreadyExtracted: returns true when within retry cooldown
  - markAsExtracted: upserts on second call (count still 1)
  - markAsFailed: upserts on second call
  - getAllTrackerRecords: returns all rows
- [ ] **Step 2:** Run tests, verify FAIL (module does not exist)
- [ ] **Step 3:** Write `hooks/lib/extraction-tracker.ts` — standalone module using `bun:sqlite` directly. All functions take `dbPath` as first parameter. Exports: `getExtractionRecord`, `markAsExtracted`, `markAsFailed`, `wasAlreadyExtracted`, `getAllTrackerRecords`
- [ ] **Step 4:** Run tests, verify PASS (11 tests)
- [ ] **Step 5:** Commit: `git commit -m "feat: extraction tracker CRUD with SQLite"`

---

## Chunk 3: Phases 3-4 — Semaphore and Migration

### Task 7: Semaphore tests and implementation (Phase 3 — 9 tests)

**Files:**
- Create: `tests/lib/extraction-semaphore.test.ts`
- Create: `hooks/lib/extraction-semaphore.ts`

- [ ] **Step 1:** Write test file with 9 tests:
  - acquireSemaphore: returns true when below max
  - acquireSemaphore: returns false when at max (3 active)
  - acquireSemaphore: returns true when one of 3 has expired
  - releaseSemaphore: removes own row
  - releaseSemaphore: does not throw when lock not found
  - sweepExpiredLocks: removes all expired rows
  - getActiveLockCount: returns correct count
  - concurrency: 4 Bun.spawn workers race, max 3 acquire (uses concurrency_worker.ts)
  - concurrency: SIGKILL crash recovery (spawn, kill, verify new acquire succeeds after sweep)
- [ ] **Step 2:** Run tests, verify FAIL
- [ ] **Step 3:** Write `hooks/lib/extraction-semaphore.ts` — exports: `acquireSemaphore(dbPath, convPath, pid, maxConcurrent?, ttlSeconds?)`, `releaseSemaphore(dbPath, convPath)`, `sweepExpiredLocks(dbPath, ttlSeconds?)`, `getActiveLockCount(dbPath)`. TTL configurable via `EXTRACTION_LOCK_TTL_SECONDS` env var (default 600)
- [ ] **Step 4:** Run tests, verify PASS (9 tests)
- [ ] **Step 5:** Commit: `git commit -m "feat: extraction counting semaphore (max 3 concurrent)"`

### Task 8: Migration tests and implementation (Phase 4 — 14 tests)

**Files:**
- Create: `tests/lib/extraction-migration.test.ts`
- Create: `hooks/lib/extraction-migration.ts`

- [ ] **Step 1:** Write test file with 14 tests:
  - migrateTrackerJson: imports all records from nominal fixture (5 rows)
  - migrateTrackerJson: preserves extractedAt values
  - migrateTrackerJson: preserves failedAt and retryAfter values
  - migrateTrackerJson: is idempotent (run twice, count still 5)
  - migrateTrackerJson: handles empty.json gracefully (0 rows, no throw)
  - migrateTrackerJson: handles corrupted.json with error (throws, 0 rows)
  - migrateTrackerJson: handles missing_fields.json (entries with no size get size=0)
  - migrateSessionIndex: imports all records (4 rows)
  - migrateSessionIndex: is idempotent
  - migrateErrorPatterns: imports all records (3 rows)
  - migrateErrorPatterns: is idempotent
  - migrateAll: runs all three in transaction
  - migrateAll: does not touch source files (hash comparison before/after)
  - migrateAll: writes to temp DB not real memory.db
- [ ] **Step 2:** Run tests, verify FAIL
- [ ] **Step 3:** Write `hooks/lib/extraction-migration.ts` — exports: `migrateTrackerJson(jsonPath, dbPath)`, `migrateSessionIndex(jsonPath, dbPath)`, `migrateErrorPatterns(jsonPath, dbPath)`, `migrateAll(sourceDir, dbPath)`. All take explicit paths, never hardcode ~/.claude
- [ ] **Step 4:** Run tests, verify PASS (14 tests)
- [ ] **Step 5:** Commit: `git commit -m "feat: JSON to SQLite migration for extraction state"`

---

## Chunk 4: Phases 5-6 — Quality Gate and Lock Redesign

### Task 9: Quality gate tests and implementation (Phase 5 — 8 tests)

**Files:**
- Create: `tests/lib/extraction-quality.test.ts`
- Create: `hooks/lib/extraction-quality.ts`

- [ ] **Step 1:** Write test file with 8 tests:
  - evaluateQuality: returns pass for valid extraction output
  - evaluateQuality: returns fail for thin output (below_word_count)
  - evaluateQuality: returns fail for output missing sections
  - shouldSkipExtraction: returns true for tiny conversation (under 500 chars)
  - shouldSkipExtraction: returns false for adequate conversation
  - buildAdaptivePrompt: short-conversation variant for under 2000 chars
  - buildAdaptivePrompt: full prompt for over 2000 chars
  - evaluateQuality: relaxed gate passes output that strict gate fails
- [ ] **Step 2:** Run tests, verify FAIL
- [ ] **Step 3:** Write `hooks/lib/extraction-quality.ts` — pure functions, no I/O, no LLM calls. Exports: `evaluateQuality(text, options?)`, `shouldSkipExtraction(contentChars)`, `buildAdaptivePrompt(contentChars, templatePath)`
- [ ] **Step 4:** Run tests, verify PASS (8 tests)
- [ ] **Step 5:** Commit: `git commit -m "feat: adaptive quality gate for extraction (fixes 80% failure rate)"`

### Task 10: Lock redesign tests and implementation (Phase 6 — 10 tests)

**Files:**
- Create: `tests/lib/extraction-lock.test.ts`
- Create: `hooks/lib/extraction-lock.ts`

- [ ] **Step 1:** Write test file with 10 tests:
  - childAcquireLock: inserts row into extraction_locks
  - childAcquireLock: returns false if row exists for same path
  - childAcquireLock: returns true if existing row is expired
  - parentIsLockHeld: returns true when active lock exists
  - parentIsLockHeld: returns false when no row
  - parentIsLockHeld: returns false when row is expired
  - childReleaseLock: removes own row
  - childReleaseLock: does not remove another process lock (different PID)
  - cross-process: child acquires, parent sees lock held (Bun.spawn)
  - cross-process: parent skips spawning when lock held
- [ ] **Step 2:** Run tests, verify FAIL
- [ ] **Step 3:** Write `hooks/lib/extraction-lock.ts` — exports: `childAcquireLock(dbPath, convPath, pid, ttlSeconds?)`, `childReleaseLock(dbPath, convPath, pid)`, `parentIsLockHeld(dbPath, convPath)`. Uses INSERT OR IGNORE for atomic acquisition
- [ ] **Step 4:** Run tests, verify PASS (10 tests)
- [ ] **Step 5:** Commit: `git commit -m "feat: SQLite-based extraction lock (replaces file-based locks)"`

---

## Chunk 5: Phases 7-8 — Integration and Real Data

### Task 11: E2E integration tests (Phase 7 — 6 tests)

**Files:**
- Create: `tests/integration/extraction-sqlite-migration.test.ts`

- [ ] **Step 1:** Write test file with 6 tests:
  - full migration: fixture JSON files imported into clean DB (all rows present, source files unchanged)
  - extraction flow: new session runs through SQLite tracker not JSON
  - concurrency: 4 hook invocations, 3 succeed, 1 blocked
  - quality gate: thin conversation skipped cleanly (extraction_tracker row has skipped=1)
  - failed extraction: retry logic reads from SQLite
  - no real files touched: mtime assertion on ~/.claude/memory.db unchanged
- [ ] **Step 2:** Run tests, verify PASS (6 tests)
- [ ] **Step 3:** Run ALL tests to confirm 66 pass
  - Run: `bun test`
  - Expected: 66 new tests PASS + all existing tests PASS
- [ ] **Step 4:** Commit: `git commit -m "test: E2E integration tests for extraction SQLite migration"`

### Task 12: Real data migration (Phase 8)

- [ ] **Step 1:** Back up JSON files

```bash
cp ~/.claude/MEMORY/.extraction_tracker.json ~/.claude/MEMORY/.extraction_tracker.json.bak
cp ~/.claude/MEMORY/SESSION_INDEX.json ~/.claude/MEMORY/SESSION_INDEX.json.bak
cp ~/.claude/MEMORY/ERROR_PATTERNS.json ~/.claude/MEMORY/ERROR_PATTERNS.json.bak
```

- [ ] **Step 2:** Apply schema migration: `mem init`
- [ ] **Step 3:** Run migration: `bun run hooks/lib/extraction-migration.ts migrate ~/.claude/MEMORY ~/.claude/memory.db`
- [ ] **Step 4:** Verify: `mem doctor` and `mem stats`
- [ ] **Step 5:** Red Team validation of all findings
- [ ] **Step 6:** Manual test: end a real Claude Code session, verify extraction uses SQLite

### Task 13: Wire new modules into SessionExtract.ts

- [ ] **Step 1:** Replace `loadExtractionTracker`/`saveExtractionTracker` with `hooks/lib/extraction-tracker.ts`
- [ ] **Step 2:** Replace `tryAcquireExtractLock`/`releaseExtractLock` with `hooks/lib/extraction-lock.ts`
- [ ] **Step 3:** Add semaphore check before spawning from `hooks/lib/extraction-semaphore.ts`
- [ ] **Step 4:** Update quality gate to use `hooks/lib/extraction-quality.ts`
- [ ] **Step 5:** Remove JSON file writes for tracker, session index, error patterns
- [ ] **Step 6:** Keep append-only: DISTILLED.md, DECISIONS.log, REJECTIONS.log
- [ ] **Step 7:** Run full test suite: `bun test`
- [ ] **Step 8:** Commit: `git commit -m "feat: wire SQLite modules into SessionExtract hook"`

### Task 14: Update supporting code and finalize

- [ ] **Step 1:** Update `mem doctor` to check new tables exist and have data
- [ ] **Step 2:** Update `install.sh` if needed (remove JSON tracker references)
- [ ] **Step 3:** Update `BatchExtract.ts` to use new SQLite modules
- [ ] **Step 4:** Run full test suite one final time: `bun test`
- [ ] **Step 5:** Commit: `git commit -m "feat: complete SessionExtract SQLite migration"`
- [ ] **Step 6:** PR from worktree branch or merge to main

---

## Phase Summary

| Phase | Tests | Gate |
|---|---|---|
| 0. Fixtures | n/a | All parse as valid JSON |
| 1. Schema | 8 | PRAGMA + constraints pass |
| 2. Tracker | 11 | CRUD + wasAlreadyExtracted pass |
| 3. Semaphore | 9 | Acquire/release + Bun.spawn race pass |
| 4. Migration | 14 | JSON to SQLite + idempotency + no source mutation |
| 5. Quality | 8 | Skip/adaptive/relaxed gate pass |
| 6. Lock | 10 | SQLite lock + cross-process pass |
| 7. Integration | 6 | E2E + no real files touched |
| 8. Real data | n/a | mem doctor + manual extraction |
| **Total** | **66** | |

---

## Key Design Decisions

1. **Test-first ratchet:** Each phase writes tests FIRST, tests must pass, THEN implementation. No real data until Phase 7 passes.
2. **Temp-file databases, not :memory::** WAL mode needs real filesystem paths; concurrency tests need cross-process shared access.
3. **Self-contained hook constraint:** New logic written as importable modules for testing, then used by SessionExtract.ts directly via relative imports (hooks are Bun scripts that can import local files).
4. **Counting semaphore via SQLite:** Max 3 concurrent extractors. INSERT OR IGNORE is atomic. Stale cleanup via PID validation.
5. **Git worktree for isolation:** All work happens in a worktree branch. Rollback by reverting the branch.
6. **All functions take explicit paths:** Never hardcode `~/.claude` inside migration/tracker/lock functions. Testability requires path injection.
