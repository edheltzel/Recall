// recall export — pure helper functions (issue #43).
//
// Behavior under test:
// - sqlQuote produces valid SQL literals (NULL, numbers, escaped strings, blobs)
// - resolveNonClobbering never returns an existing path
// - toExportRow renders NULL provenance as explicit 'unknown' on
//   provenance-bearing tables and invents nothing on sessions
// - timestampSlug yields filesystem-safe UTC slugs

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveNonClobbering,
  sqlQuote,
  timestampSlug,
  toExportRow,
} from '../../src/lib/export';

describe('sqlQuote', () => {
  test('renders NULL for null and undefined', () => {
    expect(sqlQuote(null)).toBe('NULL');
    expect(sqlQuote(undefined)).toBe('NULL');
  });

  test('renders numbers bare and non-finite as NULL', () => {
    expect(sqlQuote(42)).toBe('42');
    expect(sqlQuote(4.5)).toBe('4.5');
    expect(sqlQuote(Infinity)).toBe('NULL');
  });

  test('escapes single quotes in strings', () => {
    expect(sqlQuote("it's a 'test'")).toBe("'it''s a ''test'''");
  });

  test('renders blobs as hex literals', () => {
    expect(sqlQuote(new Uint8Array([0xde, 0xad]))).toBe("X'dead'");
  });
});

describe('resolveNonClobbering', () => {
  test('returns the path unchanged when free, suffixed when taken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-export-'));
    try {
      const path = join(dir, 'backup.sql');
      expect(resolveNonClobbering(path)).toBe(path);

      writeFileSync(path, '');
      expect(resolveNonClobbering(path)).toBe(join(dir, 'backup-1.sql'));

      writeFileSync(join(dir, 'backup-1.sql'), '');
      expect(resolveNonClobbering(path)).toBe(join(dir, 'backup-2.sql'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toExportRow', () => {
  test('renders NULL provenance as explicit unknown', () => {
    const row = toExportRow('messages', { id: 1, content: 'hi', provenance: null });
    expect(row.provenance).toBe('unknown');
  });

  test('preserves known provenance values', () => {
    const row = toExportRow('decisions', { id: 1, decision: 'x', provenance: 'user_authored' });
    expect(row.provenance).toBe('user_authored');
  });

  test('does not invent provenance on sessions', () => {
    const row = toExportRow('sessions', { id: 1, session_id: 's1' });
    expect('provenance' in row).toBe(false);
  });
});

describe('timestampSlug', () => {
  test('produces a filesystem-safe UTC slug', () => {
    expect(timestampSlug(new Date('2026-06-10T19:22:33.456Z'))).toBe('20260610-192233');
  });
});
