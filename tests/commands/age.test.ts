// recall age — issue #139 acceptance criteria (Phase A of #53, subsumes #38).
//
// Behavior under test:
// - dry-run by default: reports the plan, writes nothing
// - --execute deletes only eligible (consolidated, old, un-pinned) messages;
//   pins, FK-referenced rows, recorded survivors, and marked duplicates survive
// - --execute expires only old, un-pinned, not-already-expiring breadcrumbs
// - --execute demotes only old, below-threshold, un-pinned decisions/learnings;
//   pins (10), LoA (8), and the threshold boundary are untouched
// - #38's message + decision prune is covered here
// - idempotence: a second execute finds nothing new
// - -t/--table scopes to one table; bad flags fail cleanly without writing

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runAge } from '../../src/commands/age';
import { runLoaQuote } from '../../src/commands/loa';
import { getDb } from '../../src/db/connection';
import {
  createSession,
  addMessage,
  addDecision,
  addLearning,
  addBreadcrumb,
  createLoaEntry,
} from '../../src/lib/memory';
import type { LineageStatus } from '../../src/lib/dedup';

const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;

// Far outside any age window (default 180d / breadcrumb 14d).
const OLD = '2020-01-01 00:00:00';

let logged: string[] = [];

beforeEach(() => {
  setupTestDb();
  logged = [];
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  // A consolidated session so messages become prune-eligible (mirrors #38).
  createSession({ session_id: 's1', started_at: OLD });
  createLoaEntry({ title: 'consolidated', fabric_extract: 'x', session_id: 's1' });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode ?? 0;
  teardownTestDb();
});

function recordLineage(
  survivorTable: string, survivorId: number,
  duplicateTable: string, duplicateId: number,
  status: LineageStatus = 'marked',
): void {
  getDb().prepare(
    `INSERT INTO dedup_lineage
       (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status, detail)
     VALUES (?, ?, ?, ?, 'exact', NULL, ?, '{}')`
  ).run(survivorTable, survivorId, duplicateTable, duplicateId, status);
}

function rowExists(table: string, id: number): boolean {
  return getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) != null;
}
function importanceOf(table: string, id: number): number {
  return (getDb().prepare(`SELECT importance AS i FROM ${table} WHERE id = ?`).get(id) as { i: number }).i;
}
function expiresAtOf(id: number): string | null {
  return (getDb().prepare(`SELECT expires_at AS e FROM breadcrumbs WHERE id = ?`).get(id) as { e: string | null }).e;
}
/** Age a freshly-inserted row so it clears the cutoff. */
function makeOld(table: string, id: number): void {
  const col = table === 'messages' ? 'timestamp' : 'created_at';
  getDb().prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(OLD, id);
}
function seedEmbedding(table: string, id: number): void {
  getDb().prepare(
    `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES (?, ?, 'test', 4, ?)`
  ).run(table, id, Buffer.from([1, 2, 3, 4]));
}
function embeddingCount(table: string, id: number): number {
  return (getDb().prepare(
    `SELECT COUNT(*) AS c FROM embeddings WHERE source_table = ? AND source_id = ?`
  ).get(table, id) as { c: number }).c;
}

describe('dry-run default', () => {
  test('reports a plan but writes nothing', () => {
    const m = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'old message' });
    const d = addDecision({ decision: 'low decision', status: 'active', importance: 3 });
    makeOld('decisions', d);
    const b = addBreadcrumb({ content: 'old crumb', importance: 4 });
    makeOld('breadcrumbs', b);

    runAge({}); // dry run

    expect(rowExists('messages', m)).toBe(true);
    expect(importanceOf('decisions', d)).toBe(3);
    expect(expiresAtOf(b)).toBeNull();
    expect(logged.join('\n')).toContain('DRY RUN');
    expect(logged.join('\n')).toContain('Re-run with --execute');
  });
});

describe('messages — delete (absorbs #38)', () => {
  test('deletes eligible messages; pins, FK-referenced, survivors, marked-dups, unconsolidated, and recent survive', () => {
    const eligible = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'eligible old message' });

    const pinned = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'pinned message' });
    getDb().prepare('UPDATE messages SET importance = 10 WHERE id = ?').run(pinned);

    const recent = addMessage({ session_id: 's1', timestamp: '2099-01-01 00:00:00', role: 'user', content: 'recent message' });

    // Unconsolidated session → never eligible (#38 lossless contract).
    createSession({ session_id: 's2', started_at: OLD });
    const unconsolidated = addMessage({ session_id: 's2', timestamp: OLD, role: 'user', content: 'unconsolidated message' });

    // FK-referenced by a LoA message range → cannot be hard-deleted.
    const fkRef = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'fk referenced message' });
    createLoaEntry({ title: 'range', fabric_extract: 'y', session_id: 's1', message_range_start: fkRef, message_range_end: fkRef });

    // Recorded dedup survivor and a marked duplicate → both withheld.
    const survivor = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'survivor message' });
    const markedDup = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'marked duplicate message' });
    recordLineage('messages', survivor, 'messages', markedDup, 'marked');

    runAge({ execute: true });

    expect(rowExists('messages', eligible)).toBe(false);       // deleted
    expect(rowExists('messages', pinned)).toBe(true);          // pin protected
    expect(rowExists('messages', recent)).toBe(true);          // not old
    expect(rowExists('messages', unconsolidated)).toBe(true);  // not consolidated
    expect(rowExists('messages', fkRef)).toBe(true);           // FK protected
    expect(rowExists('messages', survivor)).toBe(true);        // recorded survivor
    expect(rowExists('messages', markedDup)).toBe(true);       // marked duplicate

    const line = logged.find(l => l.startsWith('messages:'));
    expect(line).toContain('deleted 1');
    expect(line).toContain('withheld');
  });
});

describe('breadcrumbs — expire via existing TTL', () => {
  test('expires eligible crumbs; pins, recent, and already-expired are untouched', () => {
    const eligible = addBreadcrumb({ content: 'old crumb', importance: 4 });
    makeOld('breadcrumbs', eligible);

    const futureTtl = addBreadcrumb({ content: 'old crumb future ttl', importance: 4, expires_at: '2099-01-01 00:00:00' });
    makeOld('breadcrumbs', futureTtl);

    const pinned = addBreadcrumb({ content: 'pinned crumb', importance: 10 });
    makeOld('breadcrumbs', pinned);

    const recent = addBreadcrumb({ content: 'recent crumb', importance: 4 });

    const alreadyExpired = addBreadcrumb({ content: 'already expired crumb', importance: 4, expires_at: OLD });
    makeOld('breadcrumbs', alreadyExpired);

    runAge({ execute: true });

    // eligible + futureTtl get expires_at stamped at ~now (in the past relative to 2099)
    expect(expiresAtOf(eligible)).not.toBeNull();
    expect(new Date(expiresAtOf(eligible)!.replace(' ', 'T') + 'Z').getTime()).toBeLessThan(Date.now() + 1000);
    expect(new Date(expiresAtOf(futureTtl)!.replace(' ', 'T') + 'Z').getFullYear()).toBeLessThan(2099);

    expect(expiresAtOf(pinned)).toBeNull();         // pin protected
    expect(expiresAtOf(recent)).toBeNull();         // not old
    expect(expiresAtOf(alreadyExpired)).toBe(OLD);  // unchanged (already expiring)

    const line = logged.find(l => l.startsWith('breadcrumbs:'));
    expect(line).toContain('expired 2');
  });
});

describe('decisions / learnings / loa — demote durable records', () => {
  test('demotes old below-threshold rows; pins, LoA(8), and threshold boundary survive', () => {
    const lowDecision = addDecision({ decision: 'low decision', status: 'active', importance: 4 });
    makeOld('decisions', lowDecision);

    const boundary = addDecision({ decision: 'boundary decision', status: 'active', importance: 5 });
    makeOld('decisions', boundary);

    const pinnedDecision = addDecision({ decision: 'pinned decision', status: 'active', importance: 10 });
    makeOld('decisions', pinnedDecision);

    const recentLow = addDecision({ decision: 'recent low decision', status: 'active', importance: 3 });

    const lowLearning = addLearning({ problem: 'low learning', importance: 2 });
    makeOld('learnings', lowLearning);

    // Default-importance LoA (8) is above the default threshold → never eligible.
    const loa = createLoaEntry({ title: 'curated', fabric_extract: 'z' });
    makeOld('loa_entries', loa);

    // Survivor / marked-dup decisions are withheld even when otherwise eligible.
    const survivorDec = addDecision({ decision: 'survivor decision', status: 'active', importance: 4 });
    makeOld('decisions', survivorDec);
    const markedDec = addDecision({ decision: 'marked dup decision', status: 'active', importance: 4 });
    makeOld('decisions', markedDec);
    recordLineage('decisions', survivorDec, 'decisions', markedDec, 'marked');

    runAge({ execute: true });

    expect(importanceOf('decisions', lowDecision)).toBe(1);     // demoted to floor
    expect(importanceOf('decisions', boundary)).toBe(5);        // == threshold, untouched
    expect(importanceOf('decisions', pinnedDecision)).toBe(10); // pin untouched
    expect(importanceOf('decisions', recentLow)).toBe(3);       // not old
    expect(importanceOf('learnings', lowLearning)).toBe(1);     // demoted to floor
    expect(importanceOf('loa_entries', loa)).toBe(8);           // curated, untouched
    expect(importanceOf('decisions', survivorDec)).toBe(4);     // recorded survivor
    expect(importanceOf('decisions', markedDec)).toBe(4);       // marked duplicate
  });
});

describe('#38 coverage — message + decision prune folded into age', () => {
  test('one --execute deletes a consolidated old message and demotes an old low decision', () => {
    const m = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'consolidated old message' });
    const d = addDecision({ decision: 'old low decision', status: 'active', importance: 3 });
    makeOld('decisions', d);

    runAge({ execute: true });

    expect(rowExists('messages', m)).toBe(false);
    expect(importanceOf('decisions', d)).toBe(1);
  });
});

describe('idempotence', () => {
  test('a second --execute finds nothing new', () => {
    addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'old message' });
    const d = addDecision({ decision: 'low decision', status: 'active', importance: 3 });
    makeOld('decisions', d);
    const b = addBreadcrumb({ content: 'old crumb', importance: 4 });
    makeOld('breadcrumbs', b);

    runAge({ execute: true });
    logged = [];
    const result = runAge({ execute: true });

    const total = result!.plan.tables.reduce((n, t) => n + t.eligible.length, 0);
    expect(total).toBe(0);
    expect(logged.join('\n')).toContain('Nothing to age');
  });
});

describe('scoping and validation', () => {
  test('-t/--table scopes to one table', () => {
    const m = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'old message' });
    const d = addDecision({ decision: 'low decision', status: 'active', importance: 3 });
    makeOld('decisions', d);

    runAge({ execute: true, table: 'decisions' });

    expect(rowExists('messages', m)).toBe(true);     // untouched — out of scope
    expect(importanceOf('decisions', d)).toBe(1);    // demoted
  });

  test('invalid --table fails cleanly without writing', () => {
    const d = addDecision({ decision: 'low decision', status: 'active', importance: 3 });
    makeOld('decisions', d);

    const result = runAge({ execute: true, table: 'nope' });

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(importanceOf('decisions', d)).toBe(3); // nothing written
  });

  test('invalid --age-cutoff and --importance-threshold fail cleanly', () => {
    expect(runAge({ ageCutoff: '90' })).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(runAge({ importanceThreshold: 99 })).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});

describe('quote-back stays truthful after interior pruning (#H1)', () => {
  test('a holey LoA range reports surviving messages, not the captured count', () => {
    // 3-message range; endpoints are FK-protected, the interior is prunable.
    const m1 = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'first message' });
    const m2 = addMessage({ session_id: 's1', timestamp: OLD, role: 'assistant', content: 'interior message' });
    const m3 = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'last message' });
    const loa = createLoaEntry({
      title: 'ranged', fabric_extract: 'summary preserving all three', session_id: 's1',
      message_range_start: m1, message_range_end: m3, message_count: 3,
    });

    runAge({ execute: true });

    // Interior deleted (accepted #38 tradeoff); endpoints survive (FK-protected).
    expect(rowExists('messages', m2)).toBe(false);
    expect(rowExists('messages', m1)).toBe(true);
    expect(rowExists('messages', m3)).toBe(true);

    logged = [];
    runLoaQuote(loa);
    const out = logged.join('\n');
    expect(out).toContain('Messages: 2 of 3 present (1 pruned)');
    // The line must not assert the stale full count as if all survived.
    expect(out).not.toMatch(/Messages: 3 \(IDs/);
  });
});

describe('guard coverage on every aging path (#H2)', () => {
  test('breadcrumbs (expire): survivor and marked-duplicate are withheld', () => {
    const survivor = addBreadcrumb({ content: 'survivor crumb', importance: 4 });
    const marked = addBreadcrumb({ content: 'marked dup crumb', importance: 4 });
    const plain = addBreadcrumb({ content: 'plain old crumb', importance: 4 });
    [survivor, marked, plain].forEach(id => makeOld('breadcrumbs', id));
    recordLineage('breadcrumbs', survivor, 'breadcrumbs', marked, 'marked');

    runAge({ execute: true, table: 'breadcrumbs' });

    expect(expiresAtOf(survivor)).toBeNull();   // recorded survivor — withheld
    expect(expiresAtOf(marked)).toBeNull();     // marked duplicate — withheld
    expect(expiresAtOf(plain)).not.toBeNull();  // control — expired
  });

  test('learnings (demote): survivor and marked-duplicate are withheld', () => {
    const survivor = addLearning({ problem: 'survivor learning', importance: 4 });
    const marked = addLearning({ problem: 'marked dup learning', importance: 4 });
    const plain = addLearning({ problem: 'plain old learning', importance: 4 });
    [survivor, marked, plain].forEach(id => makeOld('learnings', id));
    recordLineage('learnings', survivor, 'learnings', marked, 'marked');

    runAge({ execute: true, table: 'learnings' });

    expect(importanceOf('learnings', survivor)).toBe(4);  // withheld
    expect(importanceOf('learnings', marked)).toBe(4);    // withheld
    expect(importanceOf('learnings', plain)).toBe(1);     // control — demoted
  });

  test('loa_entries (demote): survivor and marked-duplicate are withheld', () => {
    // importance 6 sits in the demote band only when the threshold is raised > 6.
    const survivor = createLoaEntry({ title: 'survivor loa', fabric_extract: 'x', importance: 6 });
    const marked = createLoaEntry({ title: 'marked dup loa', fabric_extract: 'y', importance: 6 });
    const plain = createLoaEntry({ title: 'plain loa', fabric_extract: 'z', importance: 6 });
    [survivor, marked, plain].forEach(id => makeOld('loa_entries', id));
    recordLineage('loa_entries', survivor, 'loa_entries', marked, 'marked');

    runAge({ execute: true, table: 'loa_entries', importanceThreshold: 7 });

    expect(importanceOf('loa_entries', survivor)).toBe(6);  // withheld
    expect(importanceOf('loa_entries', marked)).toBe(6);    // withheld
    expect(importanceOf('loa_entries', plain)).toBe(5);     // control — demoted to floor 5
  });
});

describe('embeddings cascade on message deletion (#M1)', () => {
  test('a deleted message loses its embedding; a withheld message keeps it', () => {
    const deletable = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'deletable message' });

    // A recorded survivor stays — its embedding must survive with it.
    const survivor = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'survivor message' });
    createSession({ session_id: 's2', started_at: OLD });
    const dup = addMessage({ session_id: 's2', timestamp: OLD, role: 'user', content: 'a duplicate elsewhere' });
    recordLineage('messages', survivor, 'messages', dup, 'marked');

    seedEmbedding('messages', deletable);
    seedEmbedding('messages', survivor);

    runAge({ execute: true, table: 'messages' });

    expect(rowExists('messages', deletable)).toBe(false);
    expect(embeddingCount('messages', deletable)).toBe(0);  // cascaded
    expect(rowExists('messages', survivor)).toBe(true);
    expect(embeddingCount('messages', survivor)).toBe(1);   // preserved
  });
});

describe('age cutoff happy-path (#M3)', () => {
  test('a row between two cutoffs flips eligibility as the cutoff changes', () => {
    // Aged 100 days: older than a 90d cutoff, younger than a 180d cutoff.
    const d = addDecision({ decision: 'hundred-day decision', status: 'active', importance: 3 });
    getDb().prepare(`UPDATE decisions SET created_at = datetime('now', '-100 days') WHERE id = ?`).run(d);

    const farPlan = runAge({ ageCutoff: '180d' })!.plan;       // dry run
    const nearPlan = runAge({ ageCutoff: '90d' })!.plan;       // dry run
    const eligibleIn = (plan: typeof farPlan) =>
      plan.tables.find(t => t.table === 'decisions')!.eligible.length;

    expect(eligibleIn(farPlan)).toBe(0);   // 100d < 180d cutoff → not yet old
    expect(eligibleIn(nearPlan)).toBe(1);  // 100d > 90d cutoff → eligible
    expect(importanceOf('decisions', d)).toBe(3); // dry runs wrote nothing

    runAge({ execute: true, ageCutoff: '90d' });
    expect(importanceOf('decisions', d)).toBe(1); // demoted under the near cutoff
  });
});
