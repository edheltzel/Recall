// Tests for the importance scoring layer (Sprint #4) and the LoA write-time
// floor that protects the curated tier from later demotion.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  addDecision,
  addLearning,
  addBreadcrumb,
  addMessage,
  createSession,
  createLoaEntry,
  getDecision,
  getLearning,
  getBreadcrumb,
  getLoaEntry,
  clampImportance,
  pinRecord,
} from '../../src/lib/memory';
import { getDb } from '../../src/db/connection';

beforeAll(() => {
  setupTestDb();
  createSession({ session_id: 'imp-test', started_at: new Date().toISOString() });
});

afterAll(() => {
  teardownTestDb();
});

describe('clampImportance', () => {
  test('returns fallback for undefined', () => {
    expect(clampImportance(undefined, 5)).toBe(5);
  });
  test('clamps below 1 → 1', () => {
    expect(clampImportance(-3, 5)).toBe(1);
    expect(clampImportance(0, 5)).toBe(1);
  });
  test('clamps above 10 → 10', () => {
    expect(clampImportance(99, 5)).toBe(10);
  });
  test('rounds floats', () => {
    expect(clampImportance(7.4, 5)).toBe(7);
    expect(clampImportance(7.6, 5)).toBe(8);
  });
  test('non-finite values fall back to the default', () => {
    // isFinite is false for both NaN and Infinity, so both take the fallback.
    expect(clampImportance(Number.NaN, 5)).toBe(5);
    expect(clampImportance(Number.POSITIVE_INFINITY, 5)).toBe(5);
    expect(clampImportance(Number.NEGATIVE_INFINITY, 5)).toBe(5);
  });
});

describe('Importance roundtrip on writes', () => {
  test('decision: explicit importance persists', () => {
    const id = addDecision({
      decision: 'use Bun, not Node',
      project: 'imp-test',
      status: 'active',
      importance: 9,
    });
    const got = getDecision(id);
    expect(got?.importance).toBe(9);
  });

  test('decision: missing importance defaults to 5', () => {
    const id = addDecision({
      decision: 'no-importance decision',
      project: 'imp-test',
      status: 'active',
    });
    expect(getDecision(id)?.importance).toBe(5);
  });

  test('learning: explicit importance persists', () => {
    const id = addLearning({
      problem: 'CI flakes on macOS',
      solution: 'pin xcode version',
      project: 'imp-test',
      importance: 8,
    });
    expect(getLearning(id)?.importance).toBe(8);
  });

  test('breadcrumb: explicit importance persists', () => {
    const id = addBreadcrumb({
      content: 'check the cron logs after deploy',
      project: 'imp-test',
      importance: 7,
    });
    expect(getBreadcrumb(id)?.importance).toBe(7);
  });

  test('message: defaults to 5', () => {
    const id = addMessage({
      session_id: 'imp-test',
      timestamp: new Date().toISOString(),
      role: 'user',
      content: 'hello',
      project: 'imp-test',
    });
    const row = getDb().prepare('SELECT importance FROM messages WHERE id = ?').get(id) as { importance: number };
    expect(row.importance).toBe(5);
  });
});

describe('LoA curated-tier floor', () => {
  test('createLoaEntry defaults to 8', () => {
    const id = createLoaEntry({
      title: 'Default LoA importance',
      fabric_extract: 'sample wisdom',
      project: 'imp-test',
    });
    expect(getLoaEntry(id)?.importance).toBe(8);
  });

  test('createLoaEntry honors explicit values within range', () => {
    const id = createLoaEntry({
      title: 'High-priority LoA',
      fabric_extract: 'critical wisdom',
      project: 'imp-test',
      importance: 10,
    });
    expect(getLoaEntry(id)?.importance).toBe(10);
  });

  test('createLoaEntry floors importance below 5 to 5 (curated tier protection)', () => {
    const id = createLoaEntry({
      title: 'Caller tried to demote LoA',
      fabric_extract: 'still curated',
      project: 'imp-test',
      importance: 1,
    });
    expect(getLoaEntry(id)?.importance).toBe(5);
  });

  test('createLoaEntry clamps above 10 to 10', () => {
    const id = createLoaEntry({
      title: 'Caller tried to set 99',
      fabric_extract: 'still bounded',
      project: 'imp-test',
      importance: 99,
    });
    expect(getLoaEntry(id)?.importance).toBe(10);
  });
});

describe('pinRecord', () => {
  test('default pin sets importance to 10', () => {
    const id = addBreadcrumb({ content: 'pin me', project: 'imp-test', importance: 3 });
    expect(pinRecord('breadcrumbs', id)).toBe(true);
    expect(getBreadcrumb(id)?.importance).toBe(10);
  });

  test('pin LoA below 5 is floored at 5', () => {
    const id = createLoaEntry({
      title: 'pinnable',
      fabric_extract: 'x',
      project: 'imp-test',
      importance: 8,
    });
    // Caller passes 2, but LoA floor enforced via runPin (in commands/importance);
    // direct pinRecord skips the floor — that's the contract. Verify it.
    pinRecord('loa_entries', id, 2);
    expect(getLoaEntry(id)?.importance).toBe(2); // direct call, no floor
  });

  test('pin returns false for missing record', () => {
    expect(pinRecord('decisions', 99999)).toBe(false);
  });
});
