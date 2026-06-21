// src/lib/aging.ts — pure planner contract (issue #139).
//
// planAge writes nothing and composes the dedup guards; applyAgePlan is the
// only writer. These tests pin the pure-planner / apply split and the
// clampImportance routing for demotes.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { planAge, applyAgePlan } from '../../src/lib/aging';
import {
  createSession,
  addMessage,
  addDecision,
  addLearning,
  addBreadcrumb,
  createLoaEntry,
} from '../../src/lib/memory';

// Far outside any age window (default 180d / 14d).
const OLD = '2020-01-01 00:00:00';

beforeEach(() => setupTestDb());
afterEach(() => teardownTestDb());

function ageAll(): void {
  const db = getDb();
  db.prepare('UPDATE messages SET timestamp = ?').run(OLD);
  db.prepare('UPDATE decisions SET created_at = ?').run(OLD);
  db.prepare('UPDATE learnings SET created_at = ?').run(OLD);
  db.prepare('UPDATE breadcrumbs SET created_at = ?').run(OLD);
  db.prepare('UPDATE loa_entries SET created_at = ?').run(OLD);
}

describe('planAge is pure (writes nothing)', () => {
  test('planning an eligible DB leaves every row untouched', () => {
    createSession({ session_id: 's1', started_at: OLD });
    createLoaEntry({ title: 'sum', fabric_extract: 'x', session_id: 's1' });
    const m = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'old msg' });
    const d = addDecision({ decision: 'low decision', status: 'active', importance: 3 });
    const b = addBreadcrumb({ content: 'old crumb', importance: 4 });
    ageAll();

    const plan = planAge(getDb());
    // Plan reports eligible work...
    const total = plan.tables.reduce((n, t) => n + t.eligible.length, 0);
    expect(total).toBeGreaterThan(0);

    // ...but nothing is written.
    expect(getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(m)).toBeTruthy();
    expect((getDb().prepare('SELECT importance AS i FROM decisions WHERE id = ?').get(d) as { i: number }).i).toBe(3);
    expect((getDb().prepare('SELECT expires_at AS e FROM breadcrumbs WHERE id = ?').get(b) as { e: string | null }).e).toBeNull();
  });
});

describe('demote target routes through clampImportance to the per-type floor', () => {
  test('decisions/learnings floor at 1, loa floors at 5 (never below curated tier)', () => {
    const d = addDecision({ decision: 'low decision', status: 'active', importance: 4 });
    const l = addLearning({ problem: 'low learning', importance: 2 });
    // LoA manually lowered into the demote band only reachable with a raised threshold.
    const loa = createLoaEntry({ title: 'low loa', fabric_extract: 'x', importance: 6 });
    ageAll();

    // Raise the threshold so the LoA row (importance 6) becomes eligible.
    const plan = planAge(getDb(), { importanceThreshold: 7 });
    applyAgePlan(getDb(), plan);

    expect((getDb().prepare('SELECT importance AS i FROM decisions WHERE id = ?').get(d) as { i: number }).i).toBe(1);
    expect((getDb().prepare('SELECT importance AS i FROM learnings WHERE id = ?').get(l) as { i: number }).i).toBe(1); // floor 1
    expect((getDb().prepare('SELECT importance AS i FROM loa_entries WHERE id = ?').get(loa) as { i: number }).i).toBe(5); // floor 5
  });
});
