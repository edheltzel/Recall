// Property-based tests for the shared SQLite-safe chunking helper (issue #44).
//
// The example-based boundary matrix lives in tests/lib/chunk.test.ts; these
// properties generalize the same invariants over arbitrary inputs and sizes.
// Generator sizes are bounded (arrays ≤ 2,500 elements) so the suite stays
// practical under normal `bun test` runs.

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { chunked, SQLITE_SAFE_CHUNK_SIZE } from '../../src/lib/chunk';

// Issue #41/#44 boundary lengths around the default chunk size, plus room for
// larger N via the integer arbitrary they are combined with below.
const BOUNDARY_LENGTHS = [0, 1, 499, 500, 501, 999, 1000, 1001];

const lengthArb = fc.oneof(
  fc.constantFrom(...BOUNDARY_LENGTHS),
  fc.integer({ min: 0, max: 2500 })
);

const sizeArb = fc.integer({ min: 1, max: 600 });

describe('chunked properties', () => {
  test('flattening the chunks reproduces the input: order preserved, every item exactly once', () => {
    // Arbitrary element values (duplicates included) — deep equality of the
    // flattened result proves both order preservation and exactly-once
    // processing in a single invariant.
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 1200 }), sizeArb, (items, size) => {
        expect(chunked(items, size).flat()).toEqual(items);
      })
    );
  });

  test('every chunk is non-empty, at most `size` long, and all but the last are exactly `size`', () => {
    fc.assert(
      fc.property(lengthArb, sizeArb, (length, size) => {
        const items = Array.from({ length }, (_, i) => i);
        const chunks = chunked(items, size);

        expect(chunks.length).toBe(Math.ceil(length / size));
        chunks.forEach((chunk, index) => {
          expect(chunk.length).toBeGreaterThan(0);
          if (index < chunks.length - 1) {
            expect(chunk.length).toBe(size);
          } else {
            expect(chunk.length).toBeLessThanOrEqual(size);
          }
        });
      })
    );
  });

  test('boundary lengths and larger N hold under the default chunk size', () => {
    fc.assert(
      fc.property(lengthArb, length => {
        const items = Array.from({ length }, (_, i) => i);
        const chunks = chunked(items);

        expect(chunks.length).toBe(Math.ceil(length / SQLITE_SAFE_CHUNK_SIZE));
        expect(chunks.flat()).toEqual(items);
      })
    );
  });

  test('zero-length input yields zero chunks for any valid size', () => {
    fc.assert(
      fc.property(sizeArb, size => {
        expect(chunked([], size)).toEqual([]);
      })
    );
  });

  test('rejects every non-positive or non-integer size with a RangeError', () => {
    const invalidSizeArb = fc.oneof(
      fc.integer({ min: -1000, max: 0 }),
      fc.double({ noInteger: true, noNaN: false, noDefaultInfinity: false }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)
    );
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 10 }), invalidSizeArb, (items, size) => {
        expect(() => chunked(items, size)).toThrow(RangeError);
      })
    );
  });

  test('never mutates the input array', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 1200 }), sizeArb, (items, size) => {
        const snapshot = [...items];
        chunked(items, size);
        expect(items).toEqual(snapshot);
      })
    );
  });
});
