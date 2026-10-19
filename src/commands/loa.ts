// recall loa command - Library of Alexandria capture

import { createLoaEntryFromMessages, getMessagesSinceLastLoa, getLastLoaEntry, getLoaEntry, getLoaMessages, replaceLoaMessagePins } from '../lib/memory.js';
import { detectProject } from '../lib/project.js';
import { embed, embeddingToBlob, checkEmbeddingService } from '../lib/embeddings.js';
import { getDb } from '../db/connection.js';
import { formatMessagesForExtraction, runFabricExtract } from '../lib/extraction.js';
import { getRecallHome } from '../lib/runtime-paths.js';
import { unlinkSync } from 'fs';
import { join } from 'path';
import type { Message } from '../types/index.js';

interface LoaOptions {
  continues?: number;
  project?: string;
  tags?: string;
  limit?: number;
  since?: string; // ISO timestamp to start from
}

/**
 * Auto-embed a new LoA entry for semantic search (Phase 3)
 * Runs asynchronously after LoA creation - non-blocking
 */
async function autoEmbedLoaEntry(id: number, title: string, fabricExtract: string): Promise<void> {
  try {
    const serviceStatus = await checkEmbeddingService();
    if (!serviceStatus.available) {
      console.log(`  ⚠ Embedding skipped (service unavailable)`);
      return;
    }

    const content = `${title}\n\n${fabricExtract}`;
    const result = await embed(content);
    const blob = embeddingToBlob(result.embedding);

    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
      VALUES (?, ?, ?, ?, ?)
    `).run('loa_entries', id, result.model, result.dimensions, blob);

    console.log(`  ✓ Auto-embedded for semantic search (${result.dimensions}d)`);
  } catch (err) {
    // Non-fatal - LoA is saved, embedding is optional enhancement
    console.log(`  ⚠ Embedding failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function runLoa(title: string, options: LoaOptions): Promise<void> {
  const project = options.project || detectProject();

  // Get messages since last LoA (with optional limit)
  const { messages, startId, endId } = getMessagesSinceLastLoa(options.limit);

  if (messages.length === 0) {
    console.log('No new messages since last LoA entry.');

    const lastLoa = getLastLoaEntry();
    if (lastLoa) {
      console.log(`\nLast LoA: #${lastLoa.id} "${lastLoa.title}" (${lastLoa.created_at})`);
    }
    return;
  }

  console.log(`Processing ${messages.length} messages through the fabric Extractor...`);

  // Format messages for Fabric
  const fabricInput = formatMessagesForExtraction(messages);

  // Run Fabric (MANDATORY)
  let fabricExtract: string;
  try {
    fabricExtract = runFabricExtract(fabricInput);
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : err}`);
    console.error('\nFabric is MANDATORY for LoA entries. Please ensure fabric is installed and working.');
    process.exit(1);
  }

  // Create LoA entry — Fabric extract_wisdom output is generated from the
  // session messages, so the record is extracted (ADR-0001).
  const id = createLoaEntryFromMessages({
    title,
    description: `Captured ${messages.length} messages`,
    fabric_extract: fabricExtract,
    message_range_start: startId || undefined,
    message_range_end: endId || undefined,
    snapshot_max_message_id: endId,
    parent_loa_id: options.continues,
    project,
    tags: options.tags,
    message_count: messages.length,
    provenance: 'extracted'
  }, messages);

  console.log(`\n✓ LoA #${id} captured: "${title}"`);
  console.log(`  Messages: ${messages.length} (IDs ${startId}-${endId})`);
  console.log(`  Project: ${project || 'N/A'}`);

  // Auto-embed for semantic search (Phase 3)
  await autoEmbedLoaEntry(id, title, fabricExtract);

  if (options.continues) {
    const parent = getLoaEntry(options.continues);
    if (parent) {
      console.log(`  Continues: LoA #${options.continues} "${parent.title}"`);
    }
  }

  console.log(`\n--- Extract Preview ---`);
  const preview = fabricExtract.slice(0, 500);
  console.log(preview + (fabricExtract.length > 500 ? '...' : ''));
}

export function runLoaQuote(loaId: number): void {
  const loa = getLoaEntry(loaId);

  if (!loa) {
    console.error(`LoA #${loaId} not found`);
    process.exit(1);
  }

  const messages = getLoaMessages(loaId);

  // The id range is fixed at capture, but interior messages can be pruned by
  // `recall age` (#139) — their content survives in the fabric_extract summary.
  // Report what actually still exists rather than asserting the captured count.
  // `present > expected` (cross-session ids in the span, see getLoaMessages)
  // collapses to a plain present-count so the line never claims a fake prune.
  const present = messages.length;
  const expected = loa.message_count ?? present;
  const pruned = Math.max(0, expected - present);
  const countLabel = pruned > 0
    ? `Messages: ${present} of ${expected} present (${pruned} pruned)`
    : `Messages: ${present}`;

  console.log(`LoA #${loaId}: "${loa.title}"`);
  console.log(`Created: ${loa.created_at}`);
  console.log(`${countLabel} (IDs ${loa.message_range_start}-${loa.message_range_end})`);
  console.log(`\n${'='.repeat(60)}\n`);

  for (const m of messages) {
    const time = m.timestamp.split('T')[1]?.slice(0, 8) || '';
    console.log(`[${m.role.toUpperCase()} ${time}]`);
    console.log(m.content);
    console.log('\n---\n');
  }
}

export function runLoaShow(loaId: number): void {
  const loa = getLoaEntry(loaId);

  if (!loa) {
    console.error(`LoA #${loaId} not found`);
    process.exit(1);
  }

  console.log('Library of Alexandria Entry');
  console.log('===========================\n');

  console.log(`ID:         ${loa.id}`);
  console.log(`Title:      ${loa.title}`);
  console.log(`Created:    ${loa.created_at}`);
  console.log(`Project:    ${loa.project || 'N/A'}`);
  console.log(`Messages:   ${loa.message_count || 0} (IDs ${loa.message_range_start}-${loa.message_range_end})`);

  if (loa.parent_loa_id) {
    const parent = getLoaEntry(loa.parent_loa_id);
    console.log(`Continues:  LoA #${loa.parent_loa_id}${parent ? ` "${parent.title}"` : ''}`);
  }

  if (loa.tags) {
    console.log(`Tags:       ${loa.tags}`);
  }

  console.log(`\n--- Extract ---\n`);
  console.log(loa.fabric_extract);
}

export function runLoaList(limit: number = 10): void {
  const { recentLoaEntries } = require('../lib/memory.js');
  const entries = recentLoaEntries(limit);

  if (entries.length === 0) {
    console.log('No LoA entries yet. Use "recall loa <title>" to create one.');
    return;
  }

  console.log(`Recent ${entries.length} LoA entries:\n`);

  for (const e of entries) {
    const date = e.created_at?.split('T')[0] || 'unknown';
    const projectTag = e.project ? ` [${e.project}]` : '';
    const parentTag = e.parent_loa_id ? ` → #${e.parent_loa_id}` : '';

    console.log(`#${e.id}${projectTag} ${date}${parentTag}`);
    console.log(`  ${e.title}`);
    console.log(`  ${e.message_count || 0} messages`);
    console.log('');
  }
}

const OMP_CURATED_DESCRIPTION = 'Curated fabric extraction from omp session end.';

function releaseOmpLoaLock(sessionId: string): void {
  try {
    unlinkSync(join(getRecallHome(), `omp-loa-${sessionId}.pid`));
  } catch {
    // absent on a hand start
  }
}

function loadOmpLifecycleMessages(sessionId: string): Message[] {
  return getDb().prepare(`
    SELECT m.id, m.session_id, m.timestamp, m.role, m.content, m.project, m.importance, m.provenance
    FROM published_messages m
    WHERE EXISTS (
      SELECT 1 FROM active_host_ingest_messages h
      WHERE h.message_id = m.id AND h.source = 'omp' AND h.session_id = ?
    )
    ORDER BY m.id
  `).all(sessionId) as Message[];
}

function ompLifecycleHighWater(sessionId: string): number | null {
  const row = getDb().prepare(`
    SELECT MAX(message_id) AS id FROM active_host_ingest_messages
    WHERE source = 'omp' AND session_id = ?
  `).get(sessionId) as { id: number | null };
  return row.id;
}

function writeOmpCurated(
  sessionId: string,
  messages: Message[],
  text: string,
  highWater: number,
): boolean {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (ompLifecycleHighWater(sessionId) !== highWater) {
      db.exec('ROLLBACK');
      return false;
    }
    const session = db.prepare('SELECT project FROM sessions WHERE session_id = ?')
      .get(sessionId) as { project: string | null } | undefined;
    const existing = db.prepare(`
      SELECT id FROM loa_entries WHERE session_id = ? AND description = ?
      ORDER BY id DESC LIMIT 1
    `).get(sessionId, OMP_CURATED_DESCRIPTION) as { id: number } | undefined;
    if (!existing) {
      createLoaEntryFromMessages({
        title: `Omp session ${sessionId}`,
        description: OMP_CURATED_DESCRIPTION,
        fabric_extract: text,
        snapshot_max_message_id: highWater,
        session_id: sessionId,
        project: session?.project || undefined,
        tags: 'curated,omp',
        message_count: messages.length,
        provenance: 'extracted',
      }, messages);
    } else {
      db.prepare(`
        UPDATE loa_entries
        SET fabric_extract = ?, message_count = ?, snapshot_max_message_id = ?
        WHERE id = ?
      `).run(text, messages.length, highWater, existing.id);
      replaceLoaMessagePins(existing.id, messages, db);
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw error;
  }
}

function loadedHighWater(messages: readonly Message[]): number | null {
  const id = messages[messages.length - 1]?.id;
  return Number.isSafeInteger(id) ? id! : null;
}

export async function runLoaOmpEnd(
  sessionId: string,
  deps: {
    extract?: typeof runFabricExtract;
    afterLoad?: () => void;
    beforeWrite?: () => void;
  } = {},
): Promise<number> {
  const extract = deps.extract ?? runFabricExtract;
  try {
    let messages = loadOmpLifecycleMessages(sessionId);
    if (messages.length === 0) return 0;
    deps.afterLoad?.();
    let highWater = loadedHighWater(messages);
    if (highWater == null) return 0;
    let text: string;
    try {
      text = extract(formatMessagesForExtraction(messages));
      if (ompLifecycleHighWater(sessionId) !== highWater) {
        messages = loadOmpLifecycleMessages(sessionId);
        highWater = loadedHighWater(messages);
        if (messages.length === 0 || highWater == null) return 0;
        text = extract(formatMessagesForExtraction(messages));
        if (ompLifecycleHighWater(sessionId) !== highWater) return 0;
      }
    } catch {
      return 0;
    }
    deps.beforeWrite?.();
    if (!writeOmpCurated(sessionId, messages, text, highWater)) return 0;
    return 0;
  } finally {
    releaseOmpLoaLock(sessionId);
  }
}
