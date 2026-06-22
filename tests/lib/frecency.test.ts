import { describe, test, expect } from 'bun:test';
import {
  frecency,
  recencyMultiplier,
  applyGlobalAging,
  RECENCY_MULTIPLIERS,
  HOUR_MS,
  DAY_MS,
  WEEK_MS,
} from '../../src/lib/frecency';

// Fixed reference clock — keeps every score deterministic and machine-independent.
const NOW = Date.parse('2026-06-22T12:00:00Z');

describe('recencyMultiplier — zoxide-style buckets', () => {
  test('within the last hour → ×4 (includes age 0)', () => {
    expect(recencyMultiplier(0)).toBe(4);
    expect(recencyMultiplier(HOUR_MS - 1)).toBe(4);
  });

  test('bucket edges are half-open (exact boundary falls into the older bucket)', () => {
    expect(recencyMultiplier(HOUR_MS)).toBe(2); // exactly 1h → day bucket
    expect(recencyMultiplier(DAY_MS)).toBe(0.5); // exactly 1d → week bucket
    expect(recencyMultiplier(WEEK_MS)).toBe(0.25); // exactly 1wk → older bucket
  });

  test('within the last day → ×2', () => {
    expect(recencyMultiplier(3 * HOUR_MS)).toBe(2);
    expect(recencyMultiplier(DAY_MS - 1)).toBe(2);
  });

  test('within the last week → ×0.5', () => {
    expect(recencyMultiplier(3 * DAY_MS)).toBe(0.5);
    expect(recencyMultiplier(WEEK_MS - 1)).toBe(0.5);
  });

  test('older than a week → ×0.25 (decays but never to zero)', () => {
    expect(recencyMultiplier(WEEK_MS + 1)).toBe(0.25);
    expect(recencyMultiplier(365 * DAY_MS)).toBe(0.25);
  });

  test('negative age (future last_accessed / clock skew) clamps to the most-recent bucket', () => {
    expect(recencyMultiplier(-HOUR_MS)).toBe(4);
    expect(recencyMultiplier(-WEEK_MS)).toBe(4);
  });

  test('multipliers match the documented constants', () => {
    expect(RECENCY_MULTIPLIERS).toEqual({ hour: 4, day: 2, week: 0.5, older: 0.25 });
  });
});

describe('frecency — access_count × recency multiplier', () => {
  test('never accessed → 0 baseline', () => {
    expect(frecency(0, NOW - 1000, NOW)).toBe(0); // zero access count
    expect(frecency(5, null, NOW)).toBe(0); // null timestamp
    expect(frecency(5, undefined, NOW)).toBe(0); // undefined timestamp
    expect(frecency(-3, NOW - 1000, NOW)).toBe(0); // negative count guarded
  });

  test('unparseable timestamp → 0 baseline (never guessed)', () => {
    expect(frecency(5, 'not-a-timestamp', NOW)).toBe(0);
  });

  test('recency buckets scale the score', () => {
    expect(frecency(10, NOW - 10 * 60 * 1000, NOW)).toBe(40); // <1h: 10 × 4
    expect(frecency(3, NOW - 3 * HOUR_MS, NOW)).toBe(6); // <1d: 3 × 2
    expect(frecency(4, NOW - 3 * DAY_MS, NOW)).toBe(2); // <1wk: 4 × 0.5
    expect(frecency(8, NOW - 30 * DAY_MS, NOW)).toBe(2); // older: 8 × 0.25
  });

  test('frequency scales linearly at a fixed recency', () => {
    const recent = (n: number) => frecency(n, NOW - 5 * 60 * 1000, NOW);
    expect(recent(1)).toBe(4);
    expect(recent(2)).toBe(8);
    expect(recent(5)).toBe(20);
    expect(recent(5)).toBeGreaterThan(recent(2));
  });

  test('very recent + very frequent → high; old + rare → low', () => {
    const hot = frecency(100, NOW - 60 * 1000, NOW); // 100 × 4 = 400
    const cold = frecency(1, NOW - 60 * DAY_MS, NOW); // 1 × 0.25 = 0.25
    expect(hot).toBe(400);
    expect(cold).toBe(0.25);
    expect(hot).toBeGreaterThan(cold);
  });

  test('accepts an epoch-ms timestamp directly', () => {
    expect(frecency(2, NOW - 30 * 60 * 1000, NOW)).toBe(8); // <1h: 2 × 4
  });

  test('treats a SQLite CURRENT_TIMESTAMP string as UTC (timezone-independent)', () => {
    // SQLite UTC 'YYYY-MM-DD HH:MM:SS' must NOT be read as local time. now is 30
    // minutes after last_accessed in UTC → <1h → ×4 → 4. If parsed as local, a
    // non-UTC host would shift the age across a bucket and break this.
    const now = Date.parse('2026-06-22T00:30:00Z');
    expect(frecency(1, '2026-06-22 00:00:00', now)).toBe(4);
    // The SQLite form and the explicit ISO-UTC form must score identically.
    expect(frecency(1, '2026-06-22 00:00:00', now)).toBe(frecency(1, '2026-06-22T00:00:00Z', now));
  });

  test('is deterministic — same inputs, same output', () => {
    const a = frecency(7, NOW - 2 * HOUR_MS, NOW);
    const b = frecency(7, NOW - 2 * HOUR_MS, NOW);
    expect(a).toBe(b);
  });
});

describe('applyGlobalAging — optional zoxide-style decay', () => {
  test('empty set → empty', () => {
    expect(applyGlobalAging([], 100)).toEqual([]);
  });

  test('total within cap → unchanged (returns a copy, not the same reference)', () => {
    const input = [10, 20, 30]; // total 60 <= 100
    const out = applyGlobalAging(input, 100);
    expect(out).toEqual([10, 20, 30]);
    expect(out).not.toBe(input);
  });

  test('total over cap → every value scaled by the default decay (0.9)', () => {
    const out = applyGlobalAging([50, 60], 100); // total 110 > 100
    expect(out).toEqual([45, 54]);
  });

  test('honors a custom decay factor', () => {
    expect(applyGlobalAging([100, 100], 100, 0.5)).toEqual([50, 50]);
  });

  test('decay preserves relative order and ratios', () => {
    const input = [10, 40, 80]; // total 130 > 100
    const out = applyGlobalAging(input, 100, 0.9);
    expect(out).toEqual([9, 36, 72]);
    // Ratios intact: 80/10 === 72/9.
    expect(out[2] / out[0]).toBeCloseTo(input[2] / input[0]);
  });

  test('does not mutate the input array', () => {
    const input = [50, 60];
    applyGlobalAging(input, 100);
    expect(input).toEqual([50, 60]);
  });
});
