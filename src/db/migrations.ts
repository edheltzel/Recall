// Ordered migration system using PRAGMA user_version.
//
// Each migration is a function that receives an open Database handle.
// The runner applies migrations[current..target] sequentially, each in its
// own transaction. PRAGMA user_version is bumped after each successful migration.
//
// To add a new migration: append a function to the MIGRATIONS array.
// The index IS the version number. Migration at index N brings the DB from N → N+1.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { FTS_SCHEMA } from './schema';

export type Migration = (db: Database) => void;

// When set (to anything other than '0'/'false'), migration 4 → 5 skips its
// one-shot import of legacy ~/.claude/MEMORY/*.json into the extraction_*
// tables. Used by tests/CI/sandboxes so a fresh DB is never seeded from the
// host's real home dir (issue #29).
// WARNING: never set this in a real/persistent environment — the skipped
// import is one-shot and does not re-run once user_version advances past 5,
// so a DB created with the flag set will permanently lack the legacy data.
function skipLegacyDataMigrations(): boolean {
  const v = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
  return !!v && v !== '0' && v !== 'false';
}

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

export const MIGRATIONS: Migration[] = [
  // Migration 0 → 1: Bridge from schema_meta to PRAGMA user_version.
  // Existing installs have schema_meta.version = "4" but user_version = 0.
  // Fresh installs have neither. CREATE TABLE IF NOT EXISTS handles DDL.
  // This migration is a no-op — it exists so the runner advances user_version to 1.
  (_db) => {},

  // Migration 1 → 2: No-op (historical — initial tables created by CREATE TABLE IF NOT EXISTS)
  (_db) => {},

  // Migration 2 → 3: Add source column for multi-platform support
  (db) => {
    try {
      db.prepare("ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code'").run();
    } catch {
      // Column already exists on fresh installs — safe to ignore
    }
  },

  // Migration 3 → 4: Extraction tables (created by CREATE TABLE IF NOT EXISTS in schema DDL)
  // No-op — tables are brand new, handled by the DDL that runs before migrations.
  (_db) => {},

  // Migration 4 → 5: JSON → SQLite data migration for extraction state.
  // Migrates .extraction_tracker.json, SESSION_INDEX.json, ERROR_PATTERNS.json
  // into extraction_tracker, extraction_sessions, extraction_errors tables.
  //
  // This is the one migration that reaches into the user's real filesystem
  // (~/.claude/MEMORY/*.json). Tests, CI, and sandboxes create fresh DBs that
  // would each be seeded from whatever happens to live in the host's home dir,
  // breaking isolation (issue #29). RECALL_SKIP_LEGACY_DATA_MIGRATIONS skips the
  // JSON ingestion entirely; the runner still bumps user_version, so the
  // migration chain stays intact — only the legacy import is suppressed.
  (db) => {
    if (skipLegacyDataMigrations()) return;

    const memoryDir = join(homedir(), '.claude', 'MEMORY');

    const trackerPath = join(memoryDir, '.extraction_tracker.json');
    const sessionPath = join(memoryDir, 'SESSION_INDEX.json');
    const errorPath = join(memoryDir, 'ERROR_PATTERNS.json');

    // Migrate tracker
    if (existsSync(trackerPath)) {
      try {
        const data = JSON.parse(readFileSync(trackerPath, 'utf-8')) as Record<string, any>;
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO extraction_tracker
            (conversation_path, size, extracted_at, failed_at, retry_after, error, skipped)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [path, entry] of Object.entries(data)) {
          stmt.run(
            path,
            entry.size ?? 0,
            entry.extractedAt ?? null,
            entry.failedAt ?? null,
            entry.retryAfter ?? null,
            entry.error ?? null,
            entry.skipped ?? 0
          );
        }
      } catch { /* corrupted file — skip, don't block migration */ }
    }

    // Migrate session index
    if (existsSync(sessionPath)) {
      try {
        const data = JSON.parse(readFileSync(sessionPath, 'utf-8')) as any[];
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO extraction_sessions
            (session_id, project, branch, timestamp, summary, topics, conversation_path)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const entry of data) {
          if (!entry.timestamp) continue;
          stmt.run(
            entry.sessionId,
            entry.project ?? null,
            entry.branch ?? null,
            entry.timestamp,
            entry.summary ?? null,
            JSON.stringify(entry.topics ?? []),
            entry.conversationPath ?? null
          );
        }
      } catch { /* corrupted — skip */ }
    }

    // Migrate error patterns
    if (existsSync(errorPath)) {
      try {
        const data = JSON.parse(readFileSync(errorPath, 'utf-8'));
        const patterns = data.patterns ?? [];
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO extraction_errors
            (error_key, error, fix, context, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const p of patterns) {
          const firstSeen = p.firstSeen ?? p.date ?? new Date().toISOString();
          const lastSeen = p.lastSeen ?? p.date ?? new Date().toISOString();
          const context = p.context ?? p.cause ?? null;
          stmt.run(p.error, p.error, p.fix ?? null, context, firstSeen, lastSeen);
        }
      } catch { /* corrupted — skip */ }
    }
  },

  // Migration 5 → 6: Add confidence column to decisions and learnings
  (db) => {
    try {
      db.prepare(`ALTER TABLE decisions ADD COLUMN confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low'))`).run();
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      db.prepare(`ALTER TABLE learnings ADD COLUMN confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low'))`).run();
    } catch {
      // Column already exists — safe to ignore
    }
  },

  // Migration 6 → 7: Create procedures table
  (db) => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS procedures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        title TEXT NOT NULL,
        trigger_context TEXT,
        steps TEXT NOT NULL,
        source_learnings TEXT,
        project TEXT,
        times_observed INTEGER DEFAULT 2,
        confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low'))
      )
    `).run();
  },

  // Migration 7 → 8: Importance scoring on all memory tables.
  // Enables tiered context loading (L0 identity + L1 top-N by importance).
  // Breadcrumbs already has importance (integer 1-10); we unify the other tables
  // on the same type/scale. LoA defaults to 8 — it is the curated tier and
  // must not be demoted by later rescoring (see importance backfill command).
  //
  // SQLite limitation: ALTER TABLE ... ADD COLUMN cannot express a CHECK
  // constraint that references the new column on an existing table. The
  // constraint is present in CREATE TABLE for fresh installs (schema.ts) and
  // is enforced in application code for upgraded installs.
  (db) => {
    const adds: Array<[string, string, number]> = [
      ['messages', 'importance', 5],
      ['decisions', 'importance', 5],
      ['learnings', 'importance', 5],
      ['loa_entries', 'importance', 8],
    ];
    for (const [table, column, def] of adds) {
      try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER DEFAULT ${def}`).run();
      } catch {
        // Column already exists — safe to ignore (fresh install case)
      }
    }
    // Importance indexes for efficient L1 assembly
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_importance ON messages(importance)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_decisions_importance ON decisions(importance)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_learnings_importance ON learnings(importance)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_loa_importance ON loa_entries(importance)').run();
  },

  // Migration 8 → 9: Record Provenance (ADR-0001, issue #42).
  // Additive nullable column on all memory tables. Provenance is automatic
  // write-path metadata; legacy rows stay NULL ("unknown") until explicitly
  // backfilled via `recall provenance backfill` — never guessed, no default.
  // The CHECK constraint passes for NULL (IN() evaluates to NULL → allowed),
  // so unknown remains representable.
  (db) => {
    const tables = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'];
    for (const table of tables) {
      try {
        db.prepare(
          `ALTER TABLE ${table} ADD COLUMN provenance TEXT CHECK (provenance IN ('verbatim', 'user_authored', 'extracted', 'derived'))`
        ).run();
      } catch {
        // Column already exists — safe to ignore (fresh install case)
      }
    }
  },

  // Migration 9 → 10: Dedup lineage table (issue #45).
  // No-op — dedup_lineage and its indexes are brand new, handled by the
  // CREATE TABLE IF NOT EXISTS DDL that runs before migrations (same
  // precedent as migration 3 → 4 for the extraction tables).
  (_db) => {},

  // Migration 10 → 11: Create session_progress table (issue #51).
  // Per-session turn/tool counters + the incremental-extraction cursor for the
  // mid-session learning loop. Hooks run as stateless processes, so this state
  // must persist in the DB. Mirrors the procedures precedent (6 → 7): the table
  // is created here for upgrades AND declared in schema.ts for fresh installs,
  // so both paths stay in parity. CRUD lives in hooks/lib/session-progress.ts.
  (db) => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS session_progress (
        session_id        TEXT PRIMARY KEY,
        conversation_path TEXT,
        turns_seen        INTEGER DEFAULT 0,
        tools_seen        INTEGER DEFAULT 0,
        last_offset       INTEGER DEFAULT 0,
        runs_this_session INTEGER DEFAULT 0,
        updated_at        TEXT
      )
    `).run();
  },

  // Migration 11 → 12: Correction rate-limit state on session_progress (issue #52).
  // Correction detection writes verbatim user text on a UserPromptSubmit cadence
  // and must rate-limit to 1 save per 3 prompts. The per-window turns_seen RESETS
  // to 0 on every in-session cadence run (resetWindow), so it CANNOT back a
  // monotonic "prompts since last correction" gap. We add a MONOTONIC prompts_seen
  // (incremented every UserPromptSubmit, never reset) plus last_correction_turn
  // (the prompts_seen value at the last save); the gate is
  // prompts_seen - last_correction_turn >= 3, provably robust to the turns_seen
  // reset. Mirrors the 7 → 8 importance pattern: ALTER for upgrades, declared in
  // schema.ts for fresh installs; the try/catch absorbs the column-exists case.
  (db) => {
    const adds: Array<[string, number]> = [
      ['prompts_seen', 0],
      ['last_correction_turn', 0],
    ];
    for (const [column, def] of adds) {
      try {
        db.prepare(
          `ALTER TABLE session_progress ADD COLUMN ${column} INTEGER DEFAULT ${def}`
        ).run();
      } catch {
        // Column already exists — safe to ignore (fresh install via schema.ts).
      }
    }
  },

  // Migration 12 → 13: Source-lineage column on loa_entries (issue #140,
  // Phase B prereq of #53; provenance lineage per ADR-0001 / issue #42).
  // parent_loa_id chains LoA→LoA only; this adds a generic record-of-origin so
  // a future 'derived' consolidation summary can record the records it was
  // built from. Free-form JSON text — a serialized array of {table, id}
  // references (e.g. [{"table":"loa_entries","id":3},{"table":"decisions","id":9}]).
  // Additive NULLABLE column with NO CHECK, so the SQLite ALTER-cannot-add-a-
  // referencing-CHECK limitation that constrains migration 7 → 8 does not apply
  // here. Legacy and non-derived rows stay NULL — never guessed (ADR-0001).
  // Mirrors the 8 → 9 provenance pattern: ALTER for upgrades, declared in
  // schema.ts for fresh installs; the try/catch absorbs the column-exists case.
  (db) => {
    try {
      db.prepare('ALTER TABLE loa_entries ADD COLUMN source_ids TEXT').run();
    } catch {
      // Column already exists — safe to ignore (fresh install via schema.ts).
    }
  },

  // Migration 13 → 14: Access-tracking columns for frecency ranking (issue #152,
  // B0 of Workstream B). The additive foundation for #153 (bump-on-use) and #154
  // (frecency score) — this migration adds the columns ONLY: no bump logic and no
  // ranking change. access_count defaults to 0; last_accessed is nullable (NULL
  // until a row is first surfaced/used — never guessed). Applied to all five
  // memory tables, the same set the provenance migration (8 → 9) established as
  // surfaced in recall results, so every rankable row can carry a frecency signal.
  // No indexes yet — deferred to #154, which defines how frecency is queried
  // (YAGNI). FTS5 sync triggers are untouched: they reference only content/project
  // columns, not these. Mirrors the 8 → 9 pattern: ALTER for upgrades, declared in
  // schema.ts for fresh installs; the try/catch absorbs the column-exists case.
  (db) => {
    const tables = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'];
    for (const table of tables) {
      try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN access_count INTEGER DEFAULT 0`).run();
      } catch {
        // Column already exists — safe to ignore (fresh install via schema.ts).
      }
      try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN last_accessed DATETIME`).run();
      } catch {
        // Column already exists — safe to ignore (fresh install via schema.ts).
      }
    }
  },

  // Migration 14 → 15: Scope the FTS5 `AFTER UPDATE` triggers to indexed columns
  // (issue #153, B1 bump-on-use). The bump-on-use write increments
  // access_count / sets last_accessed on the five memory tables every time a row
  // is surfaced in recall results. Those tables' FTS `*_au` triggers were
  // un-scoped (`AFTER UPDATE ON <table>`), so a bump would re-fire a full FTS
  // delete+reinsert per surfaced row on the hot read path — unacceptable write
  // amplification. We rescope each `*_au` to `AFTER UPDATE OF <indexed source
  // columns>` so an access-only UPDATE no longer reindexes, while a real edit to
  // any indexed column still does.
  //
  // No drift: the scoped `*_au` text is extracted from the SAME FTS_SCHEMA
  // createTriggers strings that fresh installs (schema.ts DDL) and `recall
  // repair`/`doctor` use. For each of the five memory tables we DROP the old
  // `*_au` trigger and recreate ONLY it (the `*_ai`/`*_ad` triggers are
  // untouched — they already exist on real installs, and recreating them would
  // break a base-table write on any DB whose FTS virtual tables aren't present).
  // Per-table try/catch tolerates a DB missing a base table (the migration may
  // run standalone on a partial schema); CREATE TRIGGER requires the ON-table.
  // Only the five bumped tables are touched — telos/documents are not bumped, so
  // rescoping them would be speculative.
  (db) => {
    const memoryFtsKeys = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'];
    for (const key of memoryFtsKeys) {
      const schema = FTS_SCHEMA[key];
      // Trigger name prefix = the FTS table name without its `_fts` suffix
      // (e.g. loa_fts → loa_au), which differs from the map key for loa_entries.
      const auTrigger = `${schema.ftsTable.replace(/_fts$/, '')}_au`;
      // Slice out just this table's `*_au` CREATE statement from its canonical
      // createTriggers block (single source of truth → no drift). The block ends
      // each trigger with `END;`; the `*_au` body has no nested `END;`.
      const start = schema.createTriggers.indexOf(`CREATE TRIGGER IF NOT EXISTS ${auTrigger} `);
      const end = schema.createTriggers.indexOf('END;', start);
      if (start < 0 || end < 0) continue; // canonical shape changed — leave triggers alone
      const auStatement = schema.createTriggers.slice(start, end + 'END;'.length);
      try {
        db.prepare(`DROP TRIGGER IF EXISTS ${auTrigger}`).run();
        db.exec(auStatement);
      } catch {
        // Base table absent on a partial schema — nothing to rescope here.
      }
    }
  },

  // Migration 15 → 16: Native code knowledge graph (epic #196, issue #197).
  // Base tables (code_files, code_nodes, code_edges) are declared in CREATE_TABLES
  // for fresh installs — initDb runs CREATE_TABLES before this migration on every
  // init, so re-creating them here would be redundant. This migration's job is:
  // (a) advance user_version to 16 — the capability gate scout/doctor check for
  // "native KG present" — and (b) ensure the code_nodes_fts virtual table and its
  // sync triggers exist on existing installs, sliced from FTS_SCHEMA.code_nodes
  // so fresh-install DDL, this migration, and repair/doctor never drift (same
  // idiom as 14 → 15). The runner wraps each migration in its own transaction;
  // this body must not open one.
  (db) => {
    const schema = FTS_SCHEMA.code_nodes;
    if (!schema) return; // FTS_SCHEMA entry absent — nothing to ensure
    try {
      db.exec(schema.createTable);
      db.exec(schema.createTriggers);
    } catch {
      // Content table absent on a partial schema — initDb's CREATE_TABLES +
      // CREATE_FTS will establish it on the next init. Never block the chain.
    }
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export interface MigrationResult {
  from: number;
  to: number;
  applied: number;
}

/**
 * Apply pending migrations to the database.
 *
 * Reads PRAGMA user_version to determine current state, then applies
 * each migration in order within its own transaction. On failure,
 * the failing migration is rolled back and an error is thrown.
 */
export function applyMigrations(db: Database): MigrationResult {
  const current = (db.prepare('PRAGMA user_version').get() as any).user_version as number;
  const target = MIGRATIONS.length;

  if (current >= target) {
    return { from: current, to: target, applied: 0 };
  }

  let applied = 0;
  for (let i = current; i < target; i++) {
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      // Concurrency safety (#202): `current` was read once, outside any lock,
      // before this loop. Now that getDb applies migrations on every open, two
      // processes can both observe version i and race here. BEGIN IMMEDIATE
      // takes the write lock (the loser waits out busy_timeout), so re-read
      // user_version under it: if a concurrent migrator already advanced past
      // i, skip this iteration — never double-apply migration i.
      const live = (db.prepare('PRAGMA user_version').get() as any).user_version as number;
      if (live > i) {
        db.prepare('COMMIT').run();
        continue;
      }
      MIGRATIONS[i](db);
      db.prepare(`PRAGMA user_version = ${i + 1}`).run();
      db.prepare('COMMIT').run();
      applied++;
    } catch (e) {
      try { db.prepare('ROLLBACK').run(); } catch { /* already rolled back */ }
      throw new Error(`Migration ${i} → ${i + 1} failed: ${e}`);
    }
  }

  return { from: current, to: target, applied };
}

/**
 * Get the current migration version from the database.
 */
export function getMigrationVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as any).user_version as number;
}
