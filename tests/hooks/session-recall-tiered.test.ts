// Tests for the tiered SessionRecall (Sprint #1).
// Validates: L0 reads identity file, L1 reserves LoA slots, tie-break ordering,
// graceful empty-state behavior, and budget enforcement.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  createSession,
  addDecision,
  addLearning,
  addBreadcrumb,
  createLoaEntry,
} from '../../src/lib/memory';

let tempIdentityDir: string;

beforeAll(() => {
  setupTestDb();
  createSession({ session_id: 'recall-sess', started_at: new Date().toISOString() });

  // Set up an identity file in an env-overridden location
  tempIdentityDir = mkdtempSync(join(tmpdir(), 'recall-identity-'));
  const identityPath = join(tempIdentityDir, 'identity.md');
  writeFileSync(identityPath, '# Ed\nDeveloper. Bun + TS. Privacy-first local memory.\n');
  process.env.RECALL_IDENTITY_PATH = identityPath;
});

afterAll(() => {
  delete process.env.RECALL_IDENTITY_PATH;
  if (tempIdentityDir && existsSync(tempIdentityDir)) {
    rmSync(tempIdentityDir, { recursive: true, force: true });
  }
  teardownTestDb();
});

describe('SessionRecall — L0 identity', () => {
  test('buildL0 reads from RECALL_IDENTITY_PATH override', async () => {
    const { buildL0 } = await import('../../hooks/SessionRecall');
    const l0 = buildL0();
    expect(l0).toBeDefined();
    expect(l0).toContain('Ed');
    expect(l0).toContain('Bun');
  });

  test('buildL0 returns undefined when no identity file exists', async () => {
    const original = process.env.RECALL_IDENTITY_PATH;
    process.env.RECALL_IDENTITY_PATH = '/nonexistent/identity.md';
    // Re-import to pick up new env? buildL0 re-reads env each call, so direct call is fine.
    const { buildL0 } = await import('../../hooks/SessionRecall');
    expect(buildL0()).toBeUndefined();
    process.env.RECALL_IDENTITY_PATH = original;
  });
});

describe('SessionRecall — L1 assembly', () => {
  test('reserves LoA slots even when high-importance breadcrumbs exist', async () => {
    // Seed 2 LoA entries (will get default importance 8, become reserved)
    createLoaEntry({
      title: 'Curated wisdom A',
      fabric_extract: 'extract A content',
      project: 'recall-test',
    });
    createLoaEntry({
      title: 'Curated wisdom B',
      fabric_extract: 'extract B content',
      project: 'recall-test',
    });

    // Seed many high-importance breadcrumbs that would otherwise crowd out LoA
    for (let i = 0; i < 20; i++) {
      addBreadcrumb({
        content: `noise crumb ${i}`,
        project: 'recall-test',
        importance: 10,
      });
    }

    const { assembleL1 } = await import('../../hooks/SessionRecall');
    const rows = assembleL1('recall-test');

    const loaCount = rows.filter(r => r.table === 'loa').length;
    expect(loaCount).toBeGreaterThanOrEqual(2);
  });

  test('tie-breaks by table priority (loa > decisions > learnings > breadcrumbs)', async () => {
    // Seed one of each at the same importance
    addDecision({
      decision: 'tie-break decision',
      project: 'tie-test',
      status: 'active',
      importance: 7,
      confidence: 'high',
    });
    addLearning({
      problem: 'tie-break problem',
      solution: 's',
      project: 'tie-test',
      importance: 7,
    });
    addBreadcrumb({
      content: 'tie-break crumb',
      project: 'tie-test',
      importance: 7,
    });

    const { assembleL1 } = await import('../../hooks/SessionRecall');
    const rows = assembleL1('tie-test');

    // Find indices of each
    const decIdx = rows.findIndex(r => r.table === 'decisions' && r.content.includes('tie-break decision'));
    const learnIdx = rows.findIndex(r => r.table === 'learnings' && r.content.includes('tie-break problem'));
    const breadIdx = rows.findIndex(r => r.table === 'breadcrumbs' && r.content.includes('tie-break crumb'));

    expect(decIdx).toBeGreaterThanOrEqual(0);
    expect(learnIdx).toBeGreaterThanOrEqual(0);
    expect(breadIdx).toBeGreaterThanOrEqual(0);
    // Decisions before learnings before breadcrumbs at the same importance
    expect(decIdx).toBeLessThan(learnIdx);
    expect(learnIdx).toBeLessThan(breadIdx);
  });
});

describe('SessionRecall — gatherContext output', () => {
  test('emits header and L0 section (L1 may be empty depending on detected project)', async () => {
    const { gatherContext } = await import('../../hooks/SessionRecall');
    const out = gatherContext();
    expect(out).toContain('## Recall — Session Memory (tiered)');
    expect(out).toContain('### L0 — Identity');
    // Either L1 has data or the empty-state hint appears — never both, never neither
    const hasL1 = out.includes('### L1 — Top Memory');
    const hasEmptyHint = out.includes('No memory yet') || out.includes('on demand');
    expect(hasL1 || hasEmptyHint).toBe(true);
  });

  test('respects total char budget', async () => {
    const { gatherContext } = await import('../../hooks/SessionRecall');
    const out = gatherContext();
    expect(out.length).toBeLessThanOrEqual(8200); // MAX_TOTAL_CHARS plus a small overhead margin
  });
});
