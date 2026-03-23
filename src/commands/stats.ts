// mem stats command

import { getStats } from '../lib/memory.js';
import { getDbPath } from '../db/connection.js';
import { DISPLAY_NAME } from '../version.js';

export function runStats(): void {
  const stats = getStats();
  const dbPath = getDbPath();

  const sizeKb = (stats.db_size_bytes / 1024).toFixed(1);
  const sizeMb = (stats.db_size_bytes / (1024 * 1024)).toFixed(2);

  console.log(`${DISPLAY_NAME} Statistics`);
  console.log('===========================\n');

  console.log(`Database: ${dbPath}`);
  console.log(`Size: ${sizeMb} MB (${sizeKb} KB)\n`);

  console.log('Record Counts:');
  console.log(`  Sessions:    ${stats.sessions.toLocaleString()}`);

  const msgWarn = stats.messages > 10000 ? '  ** Consider mem prune' : '';
  console.log(`  Messages:    ${stats.messages.toLocaleString()}${msgWarn}`);

  console.log(`  LoA Entries: ${stats.loa_entries.toLocaleString()}`);
  console.log(`  TELOS:       ${stats.telos.toLocaleString()}`);
  console.log(`  Documents:   ${stats.documents.toLocaleString()}`);

  const decDetail = ` (${stats.decisions_active} active, ${stats.decisions_superseded} superseded, ${stats.decisions_reverted} reverted)`;
  console.log(`  Decisions:   ${stats.decisions.toLocaleString()}${decDetail}`);

  console.log(`  Learnings:   ${stats.learnings.toLocaleString()}`);

  const bcExpired = stats.breadcrumbs_expired > 0 ? ` (${stats.breadcrumbs_expired} expired)` : '';
  console.log(`  Breadcrumbs: ${stats.breadcrumbs.toLocaleString()}${bcExpired}`);

  console.log(`  Embeddings:  ${stats.embeddings.toLocaleString()}`);
  console.log('');

  console.log('Extraction:');
  console.log(`  Tracker:     ${stats.extraction_tracker.toLocaleString()}`);
  console.log(`  Errors:      ${stats.extraction_errors.toLocaleString()}`);
  console.log('');

  const total = stats.sessions + stats.messages + stats.loa_entries + stats.telos + stats.documents + stats.decisions + stats.learnings + stats.breadcrumbs + stats.extraction_tracker + stats.extraction_errors + stats.embeddings;
  console.log(`Total Records: ${total.toLocaleString()}`);
}
