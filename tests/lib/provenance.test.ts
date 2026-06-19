// Shared provenanceLabel helper (issue #117, ADR-0001).
//
// provenanceLabel is the single source of truth for the `provenance: <value>`
// display string used by both mcp-server.ts (memory_search / memory_hybrid_search
// / memory_recall) and lib/search-fallback.ts (formatHybridResults). These tests
// pin its output so the two call sites can never silently diverge.

import { describe, test, expect } from 'bun:test';
import { provenanceLabel } from '../../src/lib/provenance';
import { PROVENANCE_VALUES } from '../../src/types/index';

describe('provenanceLabel (issue #117)', () => {
  test('a known provenance value is rendered verbatim', () => {
    expect(provenanceLabel('user_authored')).toBe('provenance: user_authored');
    expect(provenanceLabel('verbatim')).toBe('provenance: verbatim');
    expect(provenanceLabel('extracted')).toBe('provenance: extracted');
    expect(provenanceLabel('derived')).toBe('provenance: derived');
  });

  test('every vocabulary value renders as `provenance: <value>`', () => {
    for (const value of PROVENANCE_VALUES) {
      expect(provenanceLabel(value)).toBe(`provenance: ${value}`);
    }
  });

  test('null and undefined both report as "unknown", never guessed', () => {
    expect(provenanceLabel(null)).toBe('provenance: unknown');
    expect(provenanceLabel(undefined)).toBe('provenance: unknown');
  });
});
