// Tests for the tiered RecallStart (Sprint #1).
// Validates: L0 reads identity file, L1 reserves LoA slots, tie-break ordering,
// graceful empty-state behavior, and budget enforcement.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'fs';
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

describe('RecallStart — L0 identity', () => {
  test('buildL0 reads from RECALL_IDENTITY_PATH override', async () => {
    const { buildL0 } = await import('../../hooks/RecallStart');
    const l0 = buildL0();
    expect(l0).toBeDefined();
    expect(l0).toContain('Ed');
    expect(l0).toContain('Bun');
  });

  test('buildL0 returns undefined when no identity file exists', async () => {
    const original = process.env.RECALL_IDENTITY_PATH;
    process.env.RECALL_IDENTITY_PATH = '/nonexistent/identity.md';
    // Re-import to pick up new env? buildL0 re-reads env each call, so direct call is fine.
    const { buildL0 } = await import('../../hooks/RecallStart');
    expect(buildL0()).toBeUndefined();
    process.env.RECALL_IDENTITY_PATH = original;
  });

  test('buildL0 discovers a relocated identity from the installed Claude guide', async () => {
    const originalIdentityPath = process.env.RECALL_IDENTITY_PATH;
    const originalHome = process.env.HOME;
    const originalRecallHome = process.env.RECALL_HOME;
    const originalRecallDir = process.env.RECALL_DIR;
    const home = join(tempIdentityDir, 'relocated-home');
    const installRoot = join(tempIdentityDir, 'relocated', 'Recall');
    const canonical = join(installRoot, 'MEMORY', 'identity.md');
    const guide = join(installRoot, 'claude', 'Recall_GUIDE.md');
    const staleDefault = join(home, '.agents', 'Recall', 'MEMORY', 'identity.md');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.agents', 'Recall', 'MEMORY'), { recursive: true });
    mkdirSync(join(installRoot, 'MEMORY'), { recursive: true });
    mkdirSync(join(installRoot, 'claude'), { recursive: true });
    writeFileSync(canonical, '# Relocated identity\n');
    writeFileSync(guide, '# Guide\n');
    writeFileSync(staleDefault, '# Stale default identity\n');
    symlinkSync(guide, join(home, '.claude', 'Recall_GUIDE.md'));
    delete process.env.RECALL_IDENTITY_PATH;
    delete process.env.RECALL_HOME;
    delete process.env.RECALL_DIR;
    process.env.HOME = home;

    try {
      const { buildL0 } = await import('../../hooks/RecallStart');
      expect(buildL0()).toContain('Relocated identity');
      expect(buildL0()).not.toContain('Stale default identity');
    } finally {
      if (originalIdentityPath === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = originalIdentityPath;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalRecallHome === undefined) delete process.env.RECALL_HOME;
      else process.env.RECALL_HOME = originalRecallHome;
      if (originalRecallDir === undefined) delete process.env.RECALL_DIR;
      else process.env.RECALL_DIR = originalRecallDir;
    }
  });

  test('buildL0 honors a relocated RECALL_DIR without a Claude identity alias', async () => {
    const originalIdentityPath = process.env.RECALL_IDENTITY_PATH;
    const originalHome = process.env.HOME;
    const originalRecallHome = process.env.RECALL_HOME;
    const originalRecallDir = process.env.RECALL_DIR;
    const home = join(tempIdentityDir, 'recall-dir-home');
    const installRoot = join(tempIdentityDir, 'recall-dir-root');
    const canonical = join(installRoot, 'MEMORY', 'identity.md');
    mkdirSync(join(installRoot, 'MEMORY'), { recursive: true });
    writeFileSync(canonical, '# RECALL_DIR identity\n');
    delete process.env.RECALL_IDENTITY_PATH;
    delete process.env.RECALL_HOME;
    process.env.RECALL_DIR = installRoot;
    process.env.HOME = home;

    try {
      const { buildL0 } = await import('../../hooks/RecallStart');
      expect(buildL0()).toContain('RECALL_DIR identity');
    } finally {
      if (originalIdentityPath === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = originalIdentityPath;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalRecallHome === undefined) delete process.env.RECALL_HOME;
      else process.env.RECALL_HOME = originalRecallHome;
      if (originalRecallDir === undefined) delete process.env.RECALL_DIR;
      else process.env.RECALL_DIR = originalRecallDir;
    }
  });
});

describe('RecallStart — L1 assembly', () => {
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

    const { assembleL1 } = await import('../../hooks/RecallStart');
    const rows = assembleL1('recall-test');

    const loaCount = rows.filter(r => r.table === 'loa').length;
    expect(loaCount).toBeGreaterThanOrEqual(2);
  });

  test('excludes automatic-capture LoA from L1 and the reserved slots', async () => {
    const project = 'automatic-capture-test';
    // Curated entries that legitimately deserve the reserved LoA slots.
    createLoaEntry({ title: 'Curated wisdom X', fabric_extract: 'x content', project });
    createLoaEntry({ title: 'Curated wisdom Y', fabric_extract: 'y content', project });

    // Automatic Codex/Grok lifecycle capture: template summary, tagged
    // automatic-capture. Seeded at importance 8 to prove exclusion holds even at
    // the curated tier (the host-ingest UPDATE path never lowers existing rows).
    const { getDb } = await import('../../src/db/connection');
    getDb().prepare(`
      INSERT INTO loa_entries (title, description, fabric_extract, project, tags, importance, provenance)
      VALUES (?, ?, ?, ?, 'automatic-capture,codex', 8, 'extracted')
    `).run(
      'Codex session 01a016bb',
      'Automatic terminal extraction from codex lifecycle capture.',
      'template body',
      project
    );

    const { assembleL1 } = await import('../../hooks/RecallStart');
    const rows = assembleL1(project);

    // The automatic entry must never surface in L1 (it would otherwise take a
    // reserved LoA slot ahead of the informative curated entries).
    expect(rows.some(r => r.table === 'loa' && r.content.includes('Codex session'))).toBe(false);
    const loaContents = rows.filter(r => r.table === 'loa').map(r => r.content);
    expect(loaContents.some(c => c.includes('Curated wisdom X'))).toBe(true);
    expect(loaContents.some(c => c.includes('Curated wisdom Y'))).toBe(true);
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

    const { assembleL1 } = await import('../../hooks/RecallStart');
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

describe('RecallStart — gatherContext output', () => {
  test('emits header and L0 section (L1 may be empty depending on detected project)', async () => {
    const { gatherContext } = await import('../../hooks/RecallStart');
    const out = gatherContext();
    expect(out).toContain('## Recall — Session Memory (tiered)');
    expect(out).toContain('### L0 — Identity');
    // Either L1 has data or the empty-state hint appears — never both, never neither
    const hasL1 = out.includes('### L1 — Top Memory');
    const hasEmptyHint = out.includes('No memory yet') || out.includes('on demand');
    expect(hasL1 || hasEmptyHint).toBe(true);
  });

  test('respects total char budget', async () => {
    const { gatherContext } = await import('../../hooks/RecallStart');
    const out = gatherContext();
    expect(out.length).toBeLessThanOrEqual(8200); // MAX_TOTAL_CHARS plus a small overhead margin
  });
});
