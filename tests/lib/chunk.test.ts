import { describe, test, expect } from 'bun:test';
import { chunked, SQLITE_SAFE_CHUNK_SIZE } from '../../src/lib/chunk';

describe('chunked', () => {
  test('default chunk size is the conservative 500', () => {
    expect(SQLITE_SAFE_CHUNK_SIZE).toBe(500);
  });

  // Issue #41 boundary matrix: chunk counts at and around the default size.
  const boundaries: Array<{ items: number; chunks: number }> = [
    { items: 0, chunks: 0 },
    { items: 1, chunks: 1 },
    { items: 499, chunks: 1 },
    { items: 500, chunks: 1 },
    { items: 501, chunks: 2 },
    { items: 999, chunks: 2 },
    { items: 1000, chunks: 2 },
    { items: 1001, chunks: 3 },
  ];

  for (const { items, chunks } of boundaries) {
    test(`${items} items → ${chunks} chunk(s), order preserved, exactly once`, () => {
      const input = Array.from({ length: items }, (_, i) => i);
      const result = chunked(input);

      expect(result.length).toBe(chunks);
      for (const chunk of result) {
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(SQLITE_SAFE_CHUNK_SIZE);
      }
      // Flattening reproduces the input exactly: order preserved, no item
      // dropped or duplicated across chunks.
      expect(result.flat()).toEqual(input);
    });
  }

  test('respects a custom chunk size', () => {
    const result = chunked([1, 2, 3, 4, 5], 2);
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('rejects non-positive and non-integer sizes', () => {
    expect(() => chunked([1], 0)).toThrow(RangeError);
    expect(() => chunked([1], -1)).toThrow(RangeError);
    expect(() => chunked([1], 1.5)).toThrow(RangeError);
  });

  test('does not mutate the input array', () => {
    const input = [1, 2, 3];
    chunked(input, 2);
    expect(input).toEqual([1, 2, 3]);
  });
});
