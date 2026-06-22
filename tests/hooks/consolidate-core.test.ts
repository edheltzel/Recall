// recall consolidate — hook-side engine (hooks/lib/consolidate-core.ts), issue #141.
//
// Behavior under test (the --execute APPLY half):
// - writes a derived LoA with provenance='derived', populated source_ids
//   lineage, and SCRUBBED text (the mandatory #51 guard runs before any write);
// - DEMOTES source records' importance (not deletes — rows still exist);
// - a quality-gate failure skips the cluster without writing;
// - a null model result skips the cluster without writing.
//
// The model cascade is injected as a fake, so no real `claude`/Ollama is invoked.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { addDecision } from '../../src/lib/memory';
import {
  applyConsolidation,
  type ConsolidateInputCluster,
} from '../../hooks/lib/consolidate-core';

// A clearly-fake Anthropic key matching write-safety's `anthropic-key` pattern
// (`sk-ant-` + 20+ chars). Never a real credential.
const SECRET = 'sk-ant-FAKEKEYFORTESTINGONLY0000000000000000';

// A quality-passing summary (strict gate: needs the two headers + >= 50 words),
// with a secret embedded so we can prove scrub runs before the write.
const VALID_SUMMARY = `## ONE SENTENCE SUMMARY
These decisions collectively converge on a single durable approach to the recurring configuration problem the team kept rediscovering across many separate sessions over time.

## MAIN IDEAS
- Prefer the shared helper over bespoke per-call wiring every single time
- The leaked token ${SECRET} should never have been pasted into a record
- Consolidation compresses low value clutter while preserving the durable signal
- Demotion lets the aging engine retire the originals gradually and safely later`;

let dbPath: string;

beforeEach(() => { dbPath = setupTestDb(); });
afterEach(() => { teardownTestDb(); });

function seedDecisions(texts: string[], importance = 3): number[] {
  return texts.map((t) => addDecision({ decision: t, status: 'active', project: 'p', importance }));
}
function clusterFor(ids: number[]): ConsolidateInputCluster {
  return {
    table: 'decisions',
    project: 'p',
    window: '2020-01-01',
    records: ids.map((id) => ({ id, text: `decision ${id}`, newImportance: 1 })),
  };
}
function loaRows(): Array<{ provenance: string | null; source_ids: string | null; fabric_extract: string; importance: number }> {
  return getDb().prepare(
    'SELECT provenance, source_ids, fabric_extract, importance FROM loa_entries'
  ).all() as any[];
}
function importanceOf(id: number): number {
  return (getDb().prepare('SELECT importance AS i FROM decisions WHERE id = ?').get(id) as { i: number }).i;
}

describe('applyConsolidation — write + demote', () => {
  test('writes a scrubbed derived LoA with source_ids lineage and demotes (not deletes) sources', async () => {
    const ids = seedDecisions(['decision one', 'decision two', 'decision three']);
    let calls = 0;
    const summarize = async () => { calls++; return VALID_SUMMARY; };

    const result = await applyConsolidation(dbPath, [clusterFor(ids)], { summarize });

    expect(calls).toBe(1);
    expect(result.written).toBe(1);
    expect(result.demoted).toBe(3);

    const rows = loaRows();
    expect(rows.length).toBe(1);
    const row = rows[0];
    // provenance set via the maintenance path (not MCP) — ADR-0001.
    expect(row.provenance).toBe('derived');
    // source_ids lineage references exactly the cluster's source records.
    expect(JSON.parse(row.source_ids!)).toEqual(ids.map((id) => ({ table: 'decisions', id })));
    // Scrub ran BEFORE the write: the secret is gone, a marker is present.
    expect(row.fabric_extract).not.toContain(SECRET);
    expect(row.fabric_extract).toContain('[REDACTED:anthropic-key]');
    expect(result.redactions).toContain('anthropic-key');
    // Derived summaries land at the LoA neutral floor.
    expect(row.importance).toBe(5);

    // Sources DEMOTED, not deleted — rows still exist at the clamped floor.
    for (const id of ids) {
      expect(importanceOf(id)).toBe(1);
      expect(getDb().prepare('SELECT 1 FROM decisions WHERE id = ?').get(id)).not.toBeNull();
    }
  });

  test('a quality-gate failure skips the cluster without writing or demoting', async () => {
    const ids = seedDecisions(['decision one', 'decision two', 'decision three']);
    // Too short + missing required sections → evaluateQuality fails.
    const summarize = async () => 'nope';

    const result = await applyConsolidation(dbPath, [clusterFor(ids)], { summarize });

    expect(result.written).toBe(0);
    expect(result.demoted).toBe(0);
    expect(result.skipped).toEqual([{ table: 'decisions', window: '2020-01-01', reason: 'quality_failed' }]);
    expect(loaRows().length).toBe(0);
    for (const id of ids) expect(importanceOf(id)).toBe(3); // untouched
  });

  test('a null model result skips the cluster (extraction_failed) without writing', async () => {
    const ids = seedDecisions(['decision one', 'decision two', 'decision three']);
    const summarize = async () => null;

    const result = await applyConsolidation(dbPath, [clusterFor(ids)], { summarize });

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([{ table: 'decisions', window: '2020-01-01', reason: 'extraction_failed' }]);
    expect(loaRows().length).toBe(0);
    for (const id of ids) expect(importanceOf(id)).toBe(3);
  });
});
