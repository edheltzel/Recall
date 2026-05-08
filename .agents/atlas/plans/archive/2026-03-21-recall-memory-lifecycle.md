# Recall Memory Lifecycle — Implementation Plan

> **Origin:** Red team validation of Bifrost comparison (2026-03-21). 8 parallel investigation agents searched the Recall codebase and found that 5 of 8 claimed weaknesses were overstated but revealed real integration gaps. This plan addresses the validated findings.

## Summary

Seven work items ordered by impact and effort. Items 1-2 are integration bugs (code exists but isn't wired). Items 3-4 add missing glue code. Items 5-7 are new capabilities.

---

## Phase 1: Wire Existing Code (1-2 hours)

### 1.1 — Wire Quality Gate Library into SessionExtract

**Status:** Integration bug. Library exists, is tested, but not imported.

**Files:**
- `hooks/lib/extraction-quality.ts` — source of truth (3 functions)
- `hooks/SessionExtract.ts` — has inline duplicates at 4 locations
- `hooks/BatchExtract.ts` — delegates to SessionExtract, checks stdout

**Changes:**

```typescript
// hooks/SessionExtract.ts — ADD at top (near other imports)
import { evaluateQuality, shouldSkipExtraction, buildAdaptivePrompt } from './lib/extraction-quality.js';
```

**Replace inline logic at 4 locations:**

| Location | Current (inline) | Replace with |
|----------|-----------------|-------------|
| Line ~875 (JSONL skip) | `if (messages.length < 500)` | `if (shouldSkipExtraction(messages.length))` |
| Lines ~914-920 (JSONL quality gate) | Manual string check for `ONE SENTENCE SUMMARY` + `MAIN IDEAS` | `const quality = evaluateQuality(extracted); if (!quality.pass) { ... quality.reason ... }` |
| Line ~1022 (markdown skip) | `if (messages.length < 500)` | `if (shouldSkipExtraction(messages.length))` |
| Lines ~1055-1061 (markdown quality gate) | Same manual string check | Same `evaluateQuality(extracted)` call |

**Behavioral note:** The library's `shouldSkipExtraction` threshold is 500 chars. The inline code checks `messages.length < 500` which is also chars. These match. The library's `evaluateQuality` checks word count (50 min) AND section headers — slightly stricter than inline (section headers only). This is intentional and better.

**Also wire `buildAdaptivePrompt`:** Currently the prompt selection is inline (`messages.length > 120000` triggers chunked). Consider using `buildAdaptivePrompt(contentChars)` for the short-session case (< 2000 chars) to get a brief summary instead of the full structured prompt. This is optional but reduces noise from short sessions.

**BatchExtract.ts:** No changes needed. It already detects failure by scanning SessionExtract's stdout for `"QUALITY GATE FAILED"`. The library's error messages should preserve this string.

**Tests:** Already passing — `tests/lib/extraction-quality.test.ts` and `tests/integration/extraction-sqlite-migration.test.ts` both exercise the library.

**Verification:**
- `bun test tests/lib/extraction-quality.test.ts` — passes
- `bun test tests/integration/extraction-sqlite-migration.test.ts` — passes
- Manual: extract a short session (< 500 chars) — should skip
- Manual: extract a normal session — should pass quality gate
- Manual: extract a session that produces garbled output — should fail with `reason`

---

### 1.2 — Add Status Filtering to Decision Queries

**Status:** Schema ready, queries don't use it.

**Files:**
- `src/lib/memory.ts` — `recentDecisions` (line 294) and `search` decisions case (line 197)
- `hooks/SessionRecall.ts` — decision loading queries (lines ~100-130)

**Changes in `src/lib/memory.ts`:**

```typescript
// recentDecisions — ADD WHERE clause
export function recentDecisions(limit = 5, project?: string): Decision[] {
  const db = getDb();
  if (project) {
    return db.prepare(
      `SELECT * FROM decisions WHERE project = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?`
    ).all(project, limit) as Decision[];
  }
  return db.prepare(
    `SELECT * FROM decisions WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as Decision[];
}

// search — ADD status filter in decisions JOIN
// In the 'decisions' case of the search function, add:
//   AND d.status = 'active'
// to the WHERE clause of the FTS5 join query
```

**Changes in `hooks/SessionRecall.ts`:**
- Add `AND status = 'active'` to both the project-scoped and global decision queries

**Verification:**
- `bun test` — all tests pass
- Insert a test decision, manually UPDATE its status to 'superseded' in sqlite3, verify it no longer appears in `mem recent decisions` or `memory_recall`

---

## Phase 2: Add Missing Glue Code (2-3 hours)

### 2.1 — Decision Status Transition Functions

**Status:** Schema defines `active/superseded/reverted` but no code transitions between them.

**File:** `src/lib/memory.ts`

**Add 3 new functions:**

```typescript
/**
 * Mark a decision as superseded by a newer decision.
 * Returns the number of rows updated (0 or 1).
 */
export function supersedeDecision(id: number, supersededBy?: number): number {
  const db = getDb();
  const result = db.prepare(
    `UPDATE decisions SET status = 'superseded' WHERE id = ? AND status = 'active'`
  ).run(id);
  return result.changes;
}

/**
 * Mark a decision as reverted (was wrong, rolled back).
 */
export function revertDecision(id: number): number {
  const db = getDb();
  const result = db.prepare(
    `UPDATE decisions SET status = 'reverted' WHERE id = ? AND status = 'active'`
  ).run(id);
  return result.changes;
}

/**
 * Find active decisions similar to the given text.
 * Uses FTS5 for keyword matching. Returns top N matches.
 */
export function findSimilarDecisions(text: string, limit = 3): Decision[] {
  const db = getDb();
  // Extract key terms for FTS5 query (simple approach: first 10 words)
  const terms = text.split(/\s+/).slice(0, 10).join(' OR ');
  try {
    return db.prepare(`
      SELECT d.*, rank
      FROM decisions_fts fts
      JOIN decisions d ON d.id = fts.rowid
      WHERE decisions_fts MATCH ? AND d.status = 'active'
      ORDER BY rank
      LIMIT ?
    `).all(terms, limit) as Decision[];
  } catch {
    return []; // FTS query syntax error — no matches
  }
}
```

### 2.2 — Wire Supersede Logic into `memory_add`

**File:** `src/mcp-server.ts` — `memory_add` handler (line ~491)

**Add pre-insert similarity check:**

```typescript
case "decision":
  // Check for similar active decisions that might be superseded
  const similar = findSimilarDecisions(content, 3);
  const superseded: number[] = [];

  // Auto-supersede if a very similar active decision exists
  // (simple heuristic: shares 3+ significant words)
  for (const existing of similar) {
    const existingWords = new Set(existing.decision.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const newWords = content.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const overlap = newWords.filter(w => existingWords.has(w)).length;
    if (overlap >= 3 && existingWords.size > 0) {
      supersedeDecision(existing.id!);
      superseded.push(existing.id!);
    }
  }

  id = addDecision({
    decision: content,
    reasoning: detail,
    project,
    status: "active",
  });

  if (superseded.length > 0) {
    resultText += ` (superseded decision(s) #${superseded.join(', #')})`;
  }
  break;
```

### 2.3 — Add `mem supersede` and `mem revert` CLI Commands

**File:** New subcommands in `src/index.ts`, logic in `src/commands/add.ts` or new file.

```
mem supersede <id>           # Mark decision as superseded
mem revert <id>              # Mark decision as reverted
mem decisions --status=all   # Show decisions including superseded/reverted
```

**Verification:**
- Add decision A: "Use PostgreSQL for the API"
- Add decision B: "Use SQLite for the API" — should auto-supersede A
- `mem recent decisions` — shows only B
- `mem decisions --status=all` — shows both, A marked superseded
- `mem revert B` — B marked reverted
- `mem recent decisions` — shows nothing (both inactive)

---

## Phase 3: Table Lifecycle Management (2-3 hours)

### 3.1 — Add `mem prune` Command

**File:** New `src/commands/prune.ts`, wire in `src/index.ts`

**Subcommands:**

```
mem prune --dry-run          # Show what would be pruned (DEFAULT — safe)
mem prune --execute          # Actually prune
mem prune --older-than 90d   # Only prune records older than 90 days (default: 180d)
mem prune --keep-decisions   # Skip decision pruning (they have status lifecycle)
```

**What gets pruned:**

| Table | Strategy | Default retention |
|-------|----------|-------------------|
| `messages` | Delete where session older than N days AND session has LoA entry (consolidated) | 180 days |
| `sessions` | Delete orphaned sessions (no messages, no LoA) older than N days | 180 days |
| `breadcrumbs` | Delete where `expires_at < now()` (currently filtered at read but never deleted) | Expired |
| `extraction_tracker` | Delete entries older than N days | 90 days |
| `extraction_sessions` | Cap at 500 rows (matches old SESSION_INDEX.json behavior) | 500 rows |
| `extraction_errors` | Keep all (they're deduplicated and useful) | Never |
| `decisions` | Only prune `status = 'superseded' OR status = 'reverted'` older than N days | 90 days |
| `learnings` | Never auto-prune (small table, high value) | Never |

**Safety:**
- `--dry-run` is the default. Must pass `--execute` to actually delete.
- Print row counts before and after.
- LoA entries are NEVER pruned (they're curated knowledge).
- Run `VACUUM` after pruning to reclaim space.

### 3.2 — Add Expired Breadcrumb Sweep to SessionRecall

**File:** `hooks/SessionRecall.ts`

At session start, before loading context, sweep expired breadcrumbs:

```typescript
// Sweep expired breadcrumbs (they're filtered at read time but never deleted)
db.prepare(`DELETE FROM breadcrumbs WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
```

This is lightweight and prevents accumulation.

### 3.3 — Add `extraction_sessions` Table Cap

**File:** `hooks/SessionExtract.ts` or `hooks/lib/extraction-migration.ts`

After inserting a new `extraction_sessions` row, enforce the 500-row cap that was lost when migrating from SESSION_INDEX.json:

```typescript
// Cap extraction_sessions at 500 rows (matches legacy SESSION_INDEX.json behavior)
db.prepare(`
  DELETE FROM extraction_sessions
  WHERE id NOT IN (
    SELECT id FROM extraction_sessions ORDER BY extracted_at DESC LIMIT 500
  )
`).run();
```

### 3.4 — Expand `mem stats` to Show All Tables

**File:** `src/lib/memory.ts` — `getStats()` function, `src/commands/stats.ts`

Add row counts for `extraction_tracker`, `extraction_sessions`, `extraction_errors`, `embeddings`, and `breadcrumbs` (with count of expired). Add size warnings:

```
  Messages:    12,847     ⚠ Consider `mem prune` (>10K rows)
  Breadcrumbs: 234 (18 expired)
```

**Verification:**
- `mem prune --dry-run` shows accurate counts
- `mem prune --execute --older-than 30d` on a test DB reduces row counts
- `mem stats` shows expanded table list with warnings
- Expired breadcrumbs are swept at session start

---

## Phase 4: Confidence Scoring (2-3 hours)

### 4.1 — Add `confidence` Column to Decisions and Learnings

**File:** `src/db/migrations.ts` — new migration (version 5 → 6)

```typescript
// Migration 5 → 6: Add confidence column to decisions and learnings
(db) => {
  db.prepare(`ALTER TABLE decisions ADD COLUMN confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low'))`).run();
  db.prepare(`ALTER TABLE learnings ADD COLUMN confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low'))`).run();
}
```

### 4.2 — Update Extraction Prompt

**File:** `hooks/extract_prompt.md`

Add confidence guidance to the extraction prompt:

```markdown
## DECISIONS MADE
For each decision, rate confidence: HIGH (explicit, discussed), MEDIUM (implied, reasonable), LOW (speculative, uncertain)
- [Decision]: [reasoning] (confidence: HIGH|MEDIUM|LOW)
```

### 4.3 — Parse Confidence in SessionExtract

**File:** `hooks/SessionExtract.ts` — decision parsing section

Extract the `(confidence: X)` suffix from each decision line. Default to `medium` if not present.

### 4.4 — Use Confidence in Search Ranking

**File:** `src/lib/memory.ts` — `search` function

Add optional confidence filter and use confidence as a tiebreaker in result ordering:

```sql
ORDER BY
  CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
  rank
```

### 4.5 — Use Confidence in SessionRecall

**File:** `hooks/SessionRecall.ts`

Filter out `low` confidence decisions from session start context (they go to DB but don't consume context budget):

```sql
WHERE status = 'active' AND confidence != 'low'
```

**Verification:**
- Migration applies cleanly on existing DB
- Extraction produces confidence-tagged decisions
- `mem recent decisions` shows confidence level
- Low-confidence decisions don't appear in session start context
- High-confidence decisions rank higher in search

---

## Phase 5: Automatic Procedure Detection (3-4 hours)

### 5.1 — Add Learnings to Embedding Pipeline

**File:** `src/commands/embed.ts`

Add `'learnings'` to the `EmbedOptions` type and add the backfill query:

```typescript
// Add to embeddable tables
type EmbeddableTable = 'loa' | 'decisions' | 'messages' | 'learnings';

// Backfill query for learnings
case 'learnings':
  rows = db.prepare(`
    SELECT l.id, l.problem || ' ' || COALESCE(l.solution, '') AS text
    FROM learnings l
    LEFT JOIN embeddings e ON e.source_table = 'learnings' AND e.source_id = l.id
    WHERE e.id IS NULL
    LIMIT ?
  `).all(batchSize);
```

### 5.2 — Add `procedures` Table

**File:** `src/db/schema.ts` and `src/db/migrations.ts`

```sql
CREATE TABLE IF NOT EXISTS procedures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  title TEXT NOT NULL,
  trigger_context TEXT,       -- when to use this procedure
  steps TEXT NOT NULL,         -- the synthesized procedure (markdown)
  source_learnings TEXT,       -- comma-separated learning IDs that fed this
  project TEXT,
  times_observed INTEGER DEFAULT 2,
  confidence TEXT DEFAULT 'medium'
);
```

### 5.3 — Add `mem cluster` Command

**File:** New `src/commands/cluster.ts`

Algorithm:
1. Load all learning embeddings from the `embeddings` table
2. For each learning, find its N nearest neighbors by cosine similarity
3. Group learnings with similarity > 0.85 into clusters
4. For clusters with 3+ members, generate a procedure candidate
5. Use Haiku (via PAI Inference) to synthesize the cluster into a titled procedure
6. Insert into `procedures` table with source learning IDs

```
mem cluster --dry-run        # Show clusters without creating procedures
mem cluster --execute        # Create procedure records
mem cluster --threshold 0.8  # Adjust similarity threshold (default: 0.85)
```

### 5.4 — Surface Procedures in SessionRecall

**File:** `hooks/SessionRecall.ts`

Add a procedures section after learnings:

```typescript
// Load relevant procedures
const procedures = db.prepare(`
  SELECT title, steps FROM procedures
  WHERE project = ? OR project IS NULL
  ORDER BY times_observed DESC, created_at DESC
  LIMIT 3
`).all(project);

if (procedures.length > 0) {
  output += '\n### Known Procedures\n';
  for (const p of procedures) {
    output += `- **${p.title}**: ${p.steps.slice(0, 200)}\n`;
  }
}
```

**Verification:**
- `mem embed backfill learnings` embeds existing learnings
- `mem cluster --dry-run` shows detected clusters
- `mem cluster --execute` creates procedure records
- Procedures appear in session start context

---

## Phase 6: Priority-Based Context Loading (1-2 hours)

### 6.1 — Add Type Weights to SessionRecall

**File:** `hooks/SessionRecall.ts`

Replace flat 8K cap with priority-budgeted loading:

```typescript
const BUDGET = 8000;
const TYPE_BUDGETS = {
  decisions:  0.35,  // 2800 chars — highest priority
  breadcrumbs: 0.20, // 1600 chars — time-sensitive context
  procedures: 0.15,  // 1200 chars — workflow knowledge
  learnings:  0.15,  // 1200 chars — error prevention
  hotRecall:  0.15,  // 1200 chars — last session context
};

// Load each type up to its budget allocation
// If a type underuses its budget, redistribute to next type
```

### 6.2 — Add Configurable Budget

Support env var `RECALL_CONTEXT_BUDGET` to override the 8K default:

```typescript
const BUDGET = parseInt(process.env.RECALL_CONTEXT_BUDGET || '8000', 10);
```

**Verification:**
- Session start context respects priority order
- Decisions always load first regardless of other content volume
- If decisions are small, extra budget flows to breadcrumbs
- `RECALL_CONTEXT_BUDGET=12000` increases total budget

---

## Phase 7: Multi-Machine Sync Exploration (Future — Research Only)

> This phase is research/spike only. No implementation commitment.

### Options to Evaluate

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **Turso (libSQL)** | Replace `bun:sqlite` with Turso client. Primary writer + edge replicas. | Drop-in compatible, managed service | Requires account, network dependency |
| **LiteFS** | Filesystem-level SQLite replication via FUSE | Transparent to application | Requires LiteFS daemon, Linux-only |
| **`mem sync`** | Export → transfer → import cycle | Simple, no dependencies | Manual, no real-time sync |
| **Git-backed export** | `mem export` to markdown, commit to git repo | Bifrost-like, portable | Lossy (no structured queries on remote) |

### Recommended Spike

Build `mem export` and `mem import-archive` as a v0 — dump the full DB to a portable JSON archive, import on another machine. This is the simplest path that solves the core need (memory portability) without architectural changes.

---

## Execution Order

```
Phase 1 (1-2h)  → Wire quality gate + status filtering     [DONE 2026-03-23]
Phase 2 (2-3h)  → Decision lifecycle transitions            [DONE 2026-03-23]
Phase 3 (2-3h)  → Prune command + table lifecycle           [DONE 2026-03-23]
Phase 4 (2-3h)  → Confidence scoring                        [DONE 2026-03-23]
Phase 5 (3-4h)  → Procedure detection                       [NEW CAPABILITY]
Phase 6 (1-2h)  → Priority context loading                  [OPTIMIZATION]
Phase 7 (spike) → Sync exploration                          [RESEARCH]
```

**Total estimated effort:** 12-18 hours across 6 implementation phases + 1 research spike.

**Each phase is independently shippable.** No phase depends on a later phase. Phase 1 can ship today.

---

## Testing Strategy

- Each phase adds tests to `tests/` covering the new functions
- Integration tests verify end-to-end (extract → quality gate → store → recall)
- `mem doctor` should be extended to check for:
  - Quality gate library import (Phase 1)
  - Superseded decisions without replacements (Phase 2)
  - Tables exceeding row thresholds (Phase 3)
  - Learnings without embeddings (Phase 5)

---

*Generated: 2026-03-21 | Source: Red team validation of Bifrost comparison*
*Plan location: `.atlas-plans/2026-03-21-recall-memory-lifecycle.md`*
