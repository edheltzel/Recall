// recall dedup — pure logic (issue #45).
//
// Unit tests over the pure exported functions: normalization, survivor
// selection (provenance > richness > importance > recency > id), exact
// grouping, cross-table matching, and semantic pairing. Property-based
// suites over these functions are issue #44 phase 2 — not here.

import { describe, test, expect } from 'bun:test';
import {
  compareForSurvivor,
  DEFAULT_SEMANTIC_THRESHOLD,
  findCrossTableMatches,
  findExactGroups,
  findSemanticPairs,
  normalizeText,
  provenanceRank,
  selectSurvivor,
  type DedupCandidate,
} from '../../src/lib/dedup';
import { PROVENANCE_VALUES } from '../../src/types/index';

function candidate(overrides: Partial<DedupCandidate> = {}): DedupCandidate {
  return {
    table: 'breadcrumbs',
    id: 1,
    project: null,
    provenance: null,
    importance: 5,
    created_at: '2026-01-01 00:00:00',
    key: 'k',
    textLength: 50,
    ...overrides,
  };
}

describe('normalizeText', () => {
  test('lowercases, strips quotes, collapses whitespace', () => {
    expect(normalizeText(`  Use "Bun"   for\n'everything'  `)).toBe('use bun for everything');
  });

  test('identical meaning with different casing/spacing normalizes equal', () => {
    expect(normalizeText('Ship  THE  feature')).toBe(normalizeText("ship the 'feature'"));
  });
});

describe('provenanceRank', () => {
  test('orders user_authored > verbatim > extracted > derived > unknown', () => {
    const ranks = [...PROVENANCE_VALUES, null].map(p => provenanceRank(p));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(provenanceRank('user_authored')).toBeLessThan(provenanceRank('verbatim'));
    expect(provenanceRank('verbatim')).toBeLessThan(provenanceRank('extracted'));
    expect(provenanceRank('extracted')).toBeLessThan(provenanceRank('derived'));
    expect(provenanceRank('derived')).toBeLessThan(provenanceRank(null));
  });
});

describe('selectSurvivor', () => {
  test('provenance dominates richness, importance, and recency', () => {
    const weakButAuthored = candidate({ id: 1, provenance: 'user_authored', textLength: 10, importance: 1, created_at: '2020-01-01 00:00:00' });
    const richButExtracted = candidate({ id: 2, provenance: 'extracted', textLength: 9999, importance: 10, created_at: '2026-01-01 00:00:00' });
    const { survivor, duplicates } = selectSurvivor([richButExtracted, weakButAuthored]);
    expect(survivor.id).toBe(1);
    expect(duplicates.map(d => d.id)).toEqual([2]);
  });

  test('richness breaks provenance ties', () => {
    const short = candidate({ id: 1, textLength: 10 });
    const long = candidate({ id: 2, textLength: 200 });
    expect(selectSurvivor([short, long]).survivor.id).toBe(2);
  });

  test('importance breaks richness ties', () => {
    const low = candidate({ id: 1, importance: 3 });
    const high = candidate({ id: 2, importance: 8 });
    expect(selectSurvivor([low, high]).survivor.id).toBe(2);
  });

  test('recency breaks importance ties', () => {
    const older = candidate({ id: 1, created_at: '2025-01-01 00:00:00' });
    const newer = candidate({ id: 2, created_at: '2026-01-01 00:00:00' });
    expect(selectSurvivor([older, newer]).survivor.id).toBe(2);
  });

  test('lowest id is the final deterministic tie-break', () => {
    const a = candidate({ id: 7 });
    const b = candidate({ id: 3 });
    expect(selectSurvivor([a, b]).survivor.id).toBe(3);
    // Total order: comparator never reports equality for distinct ids.
    expect(compareForSurvivor(a, b)).toBeGreaterThan(0);
  });

  test('throws on an empty group', () => {
    expect(() => selectSurvivor([])).toThrow();
  });
});

describe('findExactGroups', () => {
  test('groups same table + project + key; singletons excluded', () => {
    const groups = findExactGroups([
      candidate({ id: 1, key: 'a' }),
      candidate({ id: 2, key: 'a' }),
      candidate({ id: 3, key: 'b' }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].map(c => c.id).sort()).toEqual([1, 2]);
  });

  test('identical text in different projects is not grouped', () => {
    const groups = findExactGroups([
      candidate({ id: 1, key: 'a', project: 'alpha' }),
      candidate({ id: 2, key: 'a', project: 'beta' }),
    ]);
    expect(groups.length).toBe(0);
  });
});

describe('findCrossTableMatches', () => {
  test('reports same text across tables, ignores single-table matches', () => {
    const matches = findCrossTableMatches([
      candidate({ id: 1, key: 'a', table: 'breadcrumbs' }),
      candidate({ id: 2, key: 'a', table: 'messages' }),
      candidate({ id: 3, key: 'b', table: 'breadcrumbs' }),
      candidate({ id: 4, key: 'b', table: 'breadcrumbs' }),
    ]);
    expect(matches.length).toBe(1);
    expect(matches[0].members.map(m => m.table).sort()).toEqual(['breadcrumbs', 'messages']);
  });
});

describe('findSemanticPairs', () => {
  const unit = (x: number, y: number, z: number) => [x, y, z];

  test('pairs at/above threshold; orthogonal vectors never pair', () => {
    const near = Math.sqrt(1 - 0.97 * 0.97);
    const pairs = findSemanticPairs(
      [
        { candidate: candidate({ id: 1, key: 'a' }), embedding: unit(1, 0, 0) },
        { candidate: candidate({ id: 2, key: 'b' }), embedding: unit(0.97, near, 0) },
        { candidate: candidate({ id: 3, key: 'c' }), embedding: unit(0, 0, 1) },
      ],
      DEFAULT_SEMANTIC_THRESHOLD
    );
    expect(pairs.length).toBe(1);
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual([1, 2]);
    expect(pairs[0].similarity).toBeCloseTo(0.97, 5);
  });

  test('below-threshold pairs are never produced', () => {
    const near = Math.sqrt(1 - 0.97 * 0.97);
    const pairs = findSemanticPairs(
      [
        { candidate: candidate({ id: 1, key: 'a' }), embedding: unit(1, 0, 0) },
        { candidate: candidate({ id: 2, key: 'b' }), embedding: unit(0.97, near, 0) },
      ],
      0.99
    );
    expect(pairs.length).toBe(0);
  });

  test('same-table pairs across projects are ignored; cross-table pairs are flagged', () => {
    const pairs = findSemanticPairs(
      [
        { candidate: candidate({ id: 1, key: 'a', project: 'alpha' }), embedding: unit(1, 0, 0) },
        { candidate: candidate({ id: 2, key: 'b', project: 'beta' }), embedding: unit(1, 0, 0) },
        { candidate: candidate({ id: 3, key: 'c', table: 'messages', project: 'alpha' }), embedding: unit(1, 0, 0) },
      ],
      0.95
    );
    // 1↔2: same table, different projects — ignored.
    // 1↔3 and 2↔3: cross-table — report-only pairs.
    expect(pairs.every(p => !p.sameTable)).toBe(true);
    expect(pairs.length).toBe(2);
  });

  test('identical normalized keys are left to the exact pass', () => {
    const pairs = findSemanticPairs(
      [
        { candidate: candidate({ id: 1, key: 'same' }), embedding: unit(1, 0, 0) },
        { candidate: candidate({ id: 2, key: 'same' }), embedding: unit(1, 0, 0) },
      ],
      0.95
    );
    expect(pairs.length).toBe(0);
  });

  test('results are sorted strongest-first', () => {
    const mid = Math.sqrt(1 - 0.96 * 0.96);
    const near = Math.sqrt(1 - 0.99 * 0.99);
    const pairs = findSemanticPairs(
      [
        { candidate: candidate({ id: 1, key: 'a' }), embedding: unit(1, 0, 0) },
        { candidate: candidate({ id: 2, key: 'b' }), embedding: unit(0.99, near, 0) },
        { candidate: candidate({ id: 3, key: 'c' }), embedding: unit(0.96, mid, 0) },
      ],
      0.95
    );
    const sims = pairs.map(p => p.similarity);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
  });
});
