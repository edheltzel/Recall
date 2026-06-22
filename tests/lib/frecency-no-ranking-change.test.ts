import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { search, bumpAccess, addBreadcrumb } from '../../src/lib/memory';
import { frecency } from '../../src/lib/frecency';

// Scope boundary guard (issue #154): B2 computes/exposes the frecency score but
// must NOT change search/recall ordering — that is #155 (needs:human, on hold).
// This proves the score is inert at the ranking surface: a row given a strictly
// higher frecency signal does not move in the result order.
describe('frecency is computed but does NOT change search ordering (#154 scope boundary)', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => teardownTestDb());

  test('bumping a row to the top frecency leaves search result order unchanged', () => {
    for (const s of ['alpha', 'bravo', 'charlie', 'delta']) {
      addBreadcrumb({ content: `orderword ${s}`, importance: 5 });
    }

    const order1 = search('orderword', { limit: 10 }).map((r) => r.id);
    expect(order1.length).toBe(4);

    // Give the LAST-ordered result a heavy access signal (many recent accesses).
    const target = order1[order1.length - 1];
    for (let i = 0; i < 25; i++) bumpAccess([{ table: 'breadcrumbs', id: target }]);

    // The bumped row now genuinely has the highest frecency of the set…
    const now = Date.now();
    const rows = getDb()
      .prepare('SELECT id, access_count, last_accessed FROM breadcrumbs')
      .all() as Array<{ id: number; access_count: number; last_accessed: string | null }>;
    const scored = rows
      .map((r) => ({ id: r.id, score: frecency(r.access_count, r.last_accessed, now) }))
      .sort((a, b) => b.score - a.score);
    expect(scored[0].id).toBe(target);
    expect(scored[0].score).toBeGreaterThan(0);
    // Every other (never-bumped) row sits at the 0 baseline.
    expect(scored.slice(1).every((s) => s.score === 0)).toBe(true);

    // …yet the search ordering is identical — frecency does not reorder results.
    const order2 = search('orderword', { limit: 10 }).map((r) => r.id);
    expect(order2).toEqual(order1);
  });
});
