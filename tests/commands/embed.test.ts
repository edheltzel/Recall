import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// Force the embedding service to report unavailable so runHybridSearch takes
// its FTS-only fallback branch — which returns after awaiting
// checkEmbeddingService() and never reaches embed(), so no Ollama is needed.
// Passthrough keeps every other embeddings export real (pattern: migrations.test.ts).
mock.module('../../src/lib/embeddings', () => ({
  ...require('../../src/lib/embeddings'),
  checkEmbeddingService: async () => ({ available: false, model: '', url: 'stub' })
}));

import { runHybridSearch } from '../../src/commands/embed';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { createSession, addDecision, addBreadcrumb } from '../../src/lib/memory';

// Proves r.provenance flows from the FTS search through formatProvenanceTag on
// the hybrid fallback path, guarding the silent-unknown (#67) class across the
// FTS tables — both a known-provenance row and a legacy NULL-provenance row.
describe('runHybridSearch FTS-only fallback provenance display (issue #75, #67)', () => {
  const originalLog = console.log;
  const originalError = console.error;
  let output: string;

  beforeEach(() => {
    setupTestDb();
    output = '';
    console.log = (msg?: unknown) => { output += `${String(msg ?? '')}\n`; };
    console.error = () => {}; // swallow the "service not available / falling back" notices

    createSession({ session_id: 'hyb-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    addDecision({ session_id: 'hyb-1', decision: 'zephyrquux known decision', status: 'active', provenance: 'extracted' });
    addBreadcrumb({ session_id: 'hyb-1', content: 'zephyrquux legacy crumb', importance: 5 }); // provenance NULL
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    teardownTestDb();
  });

  test('default: known provenance stays quiet, unknown is flagged', async () => {
    await runHybridSearch('zephyrquux', {});

    const lines = output.split('\n');
    const knownLine = lines.find(l => l.includes('decisions #'));
    const unknownLine = lines.find(l => l.includes('breadcrumbs #'));

    expect(knownLine).toBeDefined();
    expect(knownLine).not.toContain('provenance');

    expect(unknownLine).toBeDefined();
    expect(unknownLine).toContain('⚠');
    expect(unknownLine).toContain('provenance: unknown');
  });

  test('--show-provenance shows every provenance value', async () => {
    await runHybridSearch('zephyrquux', { showProvenance: true });

    const lines = output.split('\n');
    const knownLine = lines.find(l => l.includes('decisions #'));
    const unknownLine = lines.find(l => l.includes('breadcrumbs #'));

    expect(knownLine).toContain('provenance: extracted');
    expect(unknownLine).toContain('provenance: unknown');
  });
});
