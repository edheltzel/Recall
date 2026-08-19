// recall prune command — table lifecycle management

import { getDb } from '../db/connection.js';
import { tableExists } from '../db/introspection.js';
import { fkProtectedIds, notRecordedSurvivorSql } from '../lib/dedup.js';
import { deleteRecordEmbeddingsBySelectionInTransaction } from '../lib/embedding-store.js';

interface PruneOptions {
  execute?: boolean;
  olderThan?: string;
  keepDecisions?: boolean;
}

interface PruneResult {
  table: string;
  description: string;
  count: number;
  /** Rows matching the prune criteria but withheld as recorded dedup survivors (#80). */
  protected?: number;
  protectedReason?: string;
}

function parseDays(value: string): number {
  const match = value.match(/^(\d+)d$/);
  if (!match) {
    console.error(`Error: Invalid duration format '${value}'. Use format like '90d' or '180d'.`);
    process.exit(1);
  }
  return parseInt(match[1], 10);
}

function countRows(db: any, sql: string, params: any[] = []): number {
  const result = db.prepare(sql).get(...params) as { count: number };
  return result.count;
}

export function runPrune(options: PruneOptions): void {
  const db = getDb();
  const lifecyclePruneReady = [
    'host_ingest_state',
    'host_ingest_messages',
    'host_ingest_generation_messages',
  ].every(table => tableExists(db, table));
  const dryRun = !options.execute;
  const days = parseDays(options.olderThan || '180d');
  const decisionDays = Math.min(days, 90);
  const keepDecisions = options.keepDecisions || false;

  const cutoff = `datetime('now', '-${days} days')`;
  const decisionCutoff = `datetime('now', '-${decisionDays} days')`;

  const results: PruneResult[] = [];

  // Survivor guard (#80, ADR-0003): a record recorded as a dedup survivor must
  // never be pruned — deleting it orphans the duplicates marked under it (they
  // stay hidden from search while their visible representative is gone). Each
  // guard is appended to BOTH the count and the DELETE so the reported count
  // matches what is actually removed; withheld rows are surfaced as `protected`
  // so the exclusion is never silent (mirroring PR #79's destructive guard).

  // 1. Messages: delete where session has LoA entry AND older than N days
  const messageWhere =
    `WHERE session_id IN (SELECT DISTINCT session_id FROM loa_entries WHERE session_id IS NOT NULL)
     AND timestamp < ${cutoff}`;
  const messageGuard = `AND ${notRecordedSurvivorSql("'messages'", 'messages.id')}`;
  const messageFkProtectedIds = fkProtectedIds(db, 'messages');
  const messageMatched = countRows(db, `SELECT COUNT(*) as count FROM published_messages AS messages ${messageWhere}`);
  let messageCount = countRows(db, `SELECT COUNT(*) as count FROM published_messages AS messages ${messageWhere} ${messageGuard}`);
  for (const id of messageFkProtectedIds) {
    messageCount -= countRows(
      db,
      `SELECT COUNT(*) as count FROM published_messages AS messages ${messageWhere} ${messageGuard} AND messages.id = ?`,
      [id]
    );
  }
  results.push({
    table: 'messages',
    description: `Consolidated messages older than ${days}d`,
    count: messageCount,
    protected: messageMatched - messageCount,
    protectedReason: 'kept as dedup survivors/FK references',
  });

  // 2. Sessions: delete orphaned sessions (no messages, no LoA) older than N days
  const sessionWhere =
    `WHERE session_id NOT IN (SELECT DISTINCT session_id FROM published_messages WHERE session_id IS NOT NULL)
     AND session_id NOT IN (SELECT DISTINCT session_id FROM loa_entries WHERE session_id IS NOT NULL)
     ${lifecyclePruneReady
       ? `AND NOT EXISTS (
         SELECT 1 FROM host_ingest_state WHERE host_ingest_state.session_id = sessions.session_id
       )`
       : 'AND 0'}
     AND started_at < ${cutoff}`;
  const sessionCount = countRows(
    db,
    `SELECT COUNT(*) as count FROM sessions ${sessionWhere}`
  );
  results.push({
    table: 'sessions',
    description: lifecyclePruneReady
      ? `Orphaned sessions older than ${days}d`
      : 'Deferred until lifecycle schema is ready',
    count: sessionCount,
  });

  // 3. Breadcrumbs: delete expired
  const breadcrumbWhere = `WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`;
  const breadcrumbGuard = `AND ${notRecordedSurvivorSql("'breadcrumbs'", 'breadcrumbs.id')}`;
  const breadcrumbMatched = countRows(db, `SELECT COUNT(*) as count FROM breadcrumbs ${breadcrumbWhere}`);
  const breadcrumbCount = countRows(db, `SELECT COUNT(*) as count FROM breadcrumbs ${breadcrumbWhere} ${breadcrumbGuard}`);
  results.push({ table: 'breadcrumbs', description: 'Expired breadcrumbs', count: breadcrumbCount, protected: breadcrumbMatched - breadcrumbCount });

  // 4. Decisions: superseded/reverted older than N days
  const decisionWhere =
    `WHERE status IN ('superseded', 'reverted')
     AND created_at < ${decisionCutoff}`;
  const decisionGuard = `AND ${notRecordedSurvivorSql("'decisions'", 'decisions.id')}`;
  let decisionCount = 0;
  if (!keepDecisions) {
    const decisionMatched = countRows(db, `SELECT COUNT(*) as count FROM decisions ${decisionWhere}`);
    decisionCount = countRows(db, `SELECT COUNT(*) as count FROM decisions ${decisionWhere} ${decisionGuard}`);
    results.push({ table: 'decisions', description: `Inactive decisions older than ${decisionDays}d`, count: decisionCount, protected: decisionMatched - decisionCount });
  } else {
    results.push({ table: 'decisions', description: 'Skipped (--keep-decisions)', count: 0 });
  }

  // 5. Extraction tracker: older than N days
  const trackerCount = countRows(db,
    `SELECT COUNT(*) as count FROM extraction_tracker
     WHERE extracted_at < ${cutoff}`
  );
  results.push({ table: 'extraction_tracker', description: `Tracker entries older than ${days}d`, count: trackerCount });

  // 6. Extraction sessions: cap at 500 rows (matches legacy SESSION_INDEX.json behavior)
  const totalExtSessions = countRows(db, `SELECT COUNT(*) as count FROM extraction_sessions`);
  const extSessionOverflow = Math.max(0, totalExtSessions - 500);
  results.push({ table: 'extraction_sessions', description: `Rows exceeding 500-row cap (${totalExtSessions} total)`, count: extSessionOverflow });

  // Never prune: loa_entries, learnings, extraction_errors

  const totalPrunable = results.reduce((sum, r) => sum + r.count, 0);

  if (dryRun) {
    console.log('DRY RUN - no data will be deleted\n');
  } else {
    console.log('EXECUTING PRUNE\n');
  }

  console.log(`Retention: ${days} days (decisions: ${decisionDays} days)\n`);

  for (const r of results) {
    const icon = r.count > 0 ? '[prune]' : '[ok]';
    const protectedNote = r.protected && r.protected > 0
      ? ` (${r.protected.toLocaleString()} ${r.protectedReason ?? 'kept as dedup survivors'})`
      : '';
    console.log(`  ${icon} ${r.table}: ${r.count.toLocaleString()} rows - ${r.description}${protectedNote}`);
  }

  console.log(`\n  Total: ${totalPrunable.toLocaleString()} rows to prune`);

  if (!lifecyclePruneReady) {
    console.error("RETRYABLE: Lifecycle prune schema is not ready; run 'recall init' and retry.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    if (totalPrunable > 0) {
      console.log('\nRun with --execute to perform the prune.');
    } else {
      console.log('\nNothing to prune.');
    }
    return;
  }

  if (totalPrunable === 0) {
    console.log('\nNothing to prune.');
    return;
  }

  // Execute deletes
  if (messageCount > 0) {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS temp.prune_message_selection;
        CREATE TEMP TABLE prune_message_selection (
          id INTEGER PRIMARY KEY,
          host_ingest_token TEXT
        );
      `);
      db.prepare(`
        INSERT INTO temp.prune_message_selection (id, host_ingest_token)
        SELECT id, host_ingest_token FROM published_messages AS messages
        ${messageWhere} ${messageGuard}
      `).run();
      const removeFkProtected = db.prepare(`
        DELETE FROM temp.prune_message_selection WHERE id = ?
      `);
      for (const id of messageFkProtectedIds) removeFkProtected.run(id);
      deleteRecordEmbeddingsBySelectionInTransaction(
        db,
        'messages',
        'SELECT id FROM temp.prune_message_selection'
      );
      db.prepare(`UPDATE host_ingest_generation_messages SET content = NULL
        WHERE message_id IN (SELECT id FROM temp.prune_message_selection)`).run();
      db.prepare(`DELETE FROM messages
        WHERE id IN (SELECT id FROM temp.prune_message_selection)
        AND (host_ingest_token IS NULL OR EXISTS (
          SELECT 1 FROM host_ingest_messages WHERE message_id = messages.id
        ))`).run();
      db.prepare(`DELETE FROM messages WHERE EXISTS (
        SELECT 1 FROM temp.prune_message_selection AS selected
        WHERE selected.id = messages.id
          AND selected.host_ingest_token IS NOT NULL
          AND selected.host_ingest_token = messages.host_ingest_token
      )`).run();
      db.exec('DROP TABLE temp.prune_message_selection;');
    })();
  }

  if (sessionCount > 0) {
    db.prepare(`DELETE FROM sessions ${sessionWhere}`).run();
  }

  if (breadcrumbCount > 0) {
    db.transaction(() => {
      deleteRecordEmbeddingsBySelectionInTransaction(
        db,
        'breadcrumbs',
        `SELECT id FROM breadcrumbs ${breadcrumbWhere} ${breadcrumbGuard}`
      );
      db.prepare(`DELETE FROM breadcrumbs ${breadcrumbWhere} ${breadcrumbGuard}`).run();
    })();
  }

  if (!keepDecisions && decisionCount > 0) {
    db.transaction(() => {
      deleteRecordEmbeddingsBySelectionInTransaction(
        db,
        'decisions',
        `SELECT id FROM decisions ${decisionWhere} ${decisionGuard}`
      );
      db.prepare(`DELETE FROM decisions ${decisionWhere} ${decisionGuard}`).run();
    })();
  }

  if (trackerCount > 0) {
    db.prepare(
      `DELETE FROM extraction_tracker
       WHERE extracted_at < ${cutoff}`
    ).run();
  }

  if (extSessionOverflow > 0) {
    db.prepare(
      `DELETE FROM extraction_sessions
       WHERE session_id NOT IN (
         SELECT session_id FROM extraction_sessions ORDER BY timestamp DESC LIMIT 500
       )`
    ).run();
  }

  console.log('\nRunning VACUUM to reclaim space...');
  db.exec('VACUUM');
  console.log('Prune complete.');
}
