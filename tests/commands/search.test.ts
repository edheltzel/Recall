import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { runSearch } from '../../src/commands/search.js';

describe('runSearch --bias-type guard', () => {
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    console.error = originalError;
    process.exitCode = originalExitCode ?? 0;
  });

  test('rejects an invalid bias-type before searching', () => {
    let errorOutput = '';
    console.error = (msg?: unknown) => {
      errorOutput += String(msg);
    };

    runSearch('anything', { biasType: 'decsion' });

    expect(errorOutput).toContain('Invalid --bias-type "decsion"');
    expect(errorOutput).toContain('messages, loa, decisions, learnings, breadcrumbs');
    expect(process.exitCode).toBe(1);
  });
});

import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { createSession, addDecision, addBreadcrumb } from '../../src/lib/memory';

describe('runSearch provenance display contract (issue #42)', () => {
  const originalLog = console.log;
  let output: string;

  beforeEach(() => {
    setupTestDb();
    output = '';
    console.log = (msg?: unknown) => {
      output += `${String(msg ?? '')}\n`;
    };

    createSession({ session_id: 'disp-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    addDecision({ session_id: 'disp-1', decision: 'quizzacious known decision', status: 'active', provenance: 'user_authored' });
    addBreadcrumb({ session_id: 'disp-1', content: 'quizzacious legacy crumb', importance: 5 }); // provenance NULL
  });

  afterEach(() => {
    console.log = originalLog;
    teardownTestDb();
  });

  test('default display stays quiet for known provenance and flags unknown', () => {
    runSearch('quizzacious', {});

    const lines = output.split('\n');
    const knownLine = lines.find(l => l.includes('decisions#'));
    const unknownLine = lines.find(l => l.includes('breadcrumbs#'));

    expect(knownLine).toBeDefined();
    expect(knownLine).not.toContain('provenance');

    expect(unknownLine).toBeDefined();
    expect(unknownLine).toContain('⚠');
    expect(unknownLine).toContain('provenance: unknown');
  });

  test('--show-provenance shows every provenance value', () => {
    runSearch('quizzacious', { showProvenance: true });

    const lines = output.split('\n');
    const knownLine = lines.find(l => l.includes('decisions#'));
    const unknownLine = lines.find(l => l.includes('breadcrumbs#'));

    expect(knownLine).toContain('provenance: user_authored');
    expect(unknownLine).toContain('provenance: unknown');
  });
});
