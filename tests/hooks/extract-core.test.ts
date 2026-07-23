// Tests for the shared extract-core (hooks/lib/extract-core.ts) — the
// text → extract → quality-gate → scrub → dualWriteToSqlite pipeline that the
// Stop hook and the future in-session hook (#51 P3) both call.
//
// codegraph flagged extractAndAppend / dualWriteToSqlite as having no covering
// tests; these are the first real assertions on this write path. Each test is
// mutation-guarded — the comment on each names the neutering mutation that turns
// it RED (verified during development).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runExtractCore, type ExtractCoreContext } from '../../hooks/lib/extract-core';

// A clearly-fake Anthropic key that matches P0's `anthropic-key` pattern
// (`sk-ant-` + 20+ chars). Never a real credential.
const SECRET = 'sk-ant-FAKEKEYFORTESTINGONLY0000000000000000';
// Right-to-left override — one of the bidi codepoints write-safety strips.
const BIDI = '‮';

const CLEAN_FIXTURE = `## ONE SENTENCE SUMMARY
We migrated the Stop hook to write to SQLite.

## MAIN IDEAS
- Hooks must not import from src/ — keep them self-contained
- Dual-write is additive, legacy files remain
- Best-effort writes never block legacy path

## DECISIONS MADE
- Use SQLite extraction_tracker (confidence: HIGH)
- Retire .extraction_tracker.json (confidence: MEDIUM)
- Keep legacy markdown writers intact (confidence: HIGH)

## ERRORS FIXED
- EEXIST on lock file: switched to SQLite extraction_locks
- TOCTOU race in semaphore: wrapped acquire in BEGIN IMMEDIATE

## THINGS TO REJECT / AVOID
- Removing the legacy files in this pass

## SESSION CONTEXT
A surgical migration of the Stop hook to use SQLite-native helpers.`;

const BASE_CTX: ExtractCoreContext = {
  sessionId: 'sess-core',
  sessionLabel: 'demo-session',
  project: 'atlas-recall',
  timestamp: '2026-06-20',
  conversationPath: '/tmp/conv.jsonl',
};

// Mirror RecallExtract's real deriveMeta (extractTopics + ONE SENTENCE SUMMARY
// regex) closely enough to exercise the persisted summary/topics fields.
function deriveMeta(extracted: string): { topics: string[]; summary: string } {
  const summaryMatch = extracted.match(/##\s*ONE\s*SENTENCE\s*SUMMARY\s*\n+(.+)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : 'demo-session session';
  return { topics: ['migration', 'sqlite'], summary };
}

let dbPath: string;

beforeEach(() => {
  dbPath = setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

function openRead(): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/** Concatenate every persisted text column across all extraction tables. */
function allPersistedText(): string {
  const db = openRead();
  try {
    const rows: string[] = [];
    const push = (sql: string) => {
      for (const r of db.prepare(sql).all() as Record<string, unknown>[]) {
        rows.push(Object.values(r).map((v) => (v == null ? '' : String(v))).join(' '));
      }
    };
    push('SELECT summary, topics FROM extraction_sessions');
    push('SELECT decision FROM decisions');
    push('SELECT problem, solution FROM learnings');
    push('SELECT content FROM breadcrumbs');
    push('SELECT error, fix FROM extraction_errors');
    push('SELECT title, description, fabric_extract, tags FROM loa_entries');
    return rows.join('\n');
  } finally {
    db.close();
  }
}

describe('runExtractCore — dual-write parity', () => {
  test('clean fixture produces the same per-table rows as the pre-refactor path', async () => {
    const result = await runExtractCore(dbPath, 'raw transcript', BASE_CTX, {
      extract: async () => CLEAN_FIXTURE,
      deriveMeta,
    });

    expect(result.outcome).toBe('extracted');
    // Wiring guard — break any writer (e.g. pass empty extracted) and these go RED.
    expect(result.dualWrite).toBeDefined();
    expect(result.dualWrite!.failures).toEqual({});
    expect(result.dualWrite!.sessions).toBe(1);
    expect(result.dualWrite!.decisions).toBe(3);
    expect(result.dualWrite!.learnings).toBe(2);
    expect(result.dualWrite!.breadcrumbs).toBe(3);
    expect(result.dualWrite!.errors).toBe(2);
    expect(result.dualWrite!.loa).toBe(1);

    const db = openRead();
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
    expect(count('extraction_sessions')).toBe(1);
    expect(count('decisions')).toBe(3);
    expect(count('learnings')).toBe(2);
    expect(count('breadcrumbs')).toBe(3);
    expect(count('extraction_errors')).toBe(2);
    expect(count('loa_entries')).toBe(1);
    db.close();

    // No secrets present → scrub is a no-op; clean text survives verbatim
    // (guards against over-redaction mangling ordinary prose).
    expect(result.redactions).toEqual([]);
    expect(allPersistedText()).toContain('extraction_tracker');
  });

  test('returns RAW (un-scrubbed) extracted/topics/summary for markdown side-effects', async () => {
    const result = await runExtractCore(dbPath, 'raw', BASE_CTX, {
      extract: async () => CLEAN_FIXTURE,
      deriveMeta,
    });
    expect(result.extracted).toBe(CLEAN_FIXTURE);
    expect(result.summary).toBe('We migrated the Stop hook to write to SQLite.');
    expect(result.topics).toEqual(['migration', 'sqlite']);
  });

  test('surfaces a failed SQLite persistence as non-success', async () => {
    const result = await runExtractCore('/path/that/does/not/exist.db', 'raw', BASE_CTX, {
      extract: async () => CLEAN_FIXTURE,
      deriveMeta,
    });

    expect(result.outcome).toBe('persistence_failed');
    expect(result.dualWrite?.failures._db).toBe('not writable or locked');
  });

  test('surfaces an exclusively locked database instead of reporting an empty success', async () => {
    const busyDir = mkdtempSync(join(tmpdir(), 'recall-busy-'));
    const busyPath = join(busyDir, 'busy.db');
    const blocker = new Database(busyPath);
    blocker.exec('PRAGMA journal_mode = DELETE; CREATE TABLE lock_probe (id INTEGER); BEGIN EXCLUSIVE');
    try {
      const result = await runExtractCore(busyPath, 'raw', BASE_CTX, {
        extract: async () => CLEAN_FIXTURE,
        deriveMeta,
      });
      expect(result.outcome).toBe('persistence_failed');
      expect(result.dualWrite?.failures._db).toContain('locked');
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
      rmSync(busyDir, { recursive: true, force: true });
    }
  });
});

describe('runExtractCore — scrub is active on every persisted field', () => {
  test('a planted secret in the body, summary, AND topics never persists as cleartext', async () => {
    // Secret planted in a DECISIONS bullet, a MAIN IDEAS bullet, the ONE SENTENCE
    // SUMMARY line, and (via deriveMeta) a topic — i.e. every persisted surface.
    // Padded past the quality gate's 50-word floor so it reaches the writers.
    const fixture = `## ONE SENTENCE SUMMARY
During the configuration session we accidentally leaked the key ${SECRET} into the shared notes before anyone noticed the exposure.

## MAIN IDEAS
- The token ${SECRET} was pasted into the config file during local debugging
- Keep hooks self-contained and never import from the source tree
- Secrets pasted into a transcript must be redacted before they are persisted

## DECISIONS MADE
- Rotate ${SECRET} immediately and invalidate the old credential (confidence: HIGH)
- Add a redaction guard to the shared write path so this cannot recur (confidence: HIGH)

## ERRORS FIXED
- Auth failure during setup: replaced ${SECRET} with a vault reference and restarted the service`;

    const result = await runExtractCore(dbPath, 'raw', BASE_CTX, {
      extract: async () => fixture,
      deriveMeta: (e) => ({ topics: [`auth-${SECRET}`], summary: deriveMeta(e).summary }),
    });

    expect(result.outcome).toBe('extracted');
    expect(result.redactions).toContain('anthropic-key');

    const persisted = allPersistedText();
    // The load-bearing guard: the cleartext secret reaches NO row, anywhere.
    // Mutation — bypass scrub in the core → the secret persists → RED.
    expect(persisted).not.toContain(SECRET);
    expect(persisted).toContain('[REDACTED:anthropic-key]');

    // Explicitly cover the brief's named fields.
    const db = openRead();
    const summary = (db.prepare('SELECT summary FROM extraction_sessions').get() as any).summary as string;
    const topics = (db.prepare('SELECT topics FROM extraction_sessions').get() as any).topics as string;
    const loa = db.prepare('SELECT description, fabric_extract, tags FROM loa_entries').get() as any;
    const decision = (db.prepare('SELECT decision FROM decisions').get() as any).decision as string;
    db.close();

    for (const field of [summary, topics, loa.description, loa.fabric_extract, loa.tags, decision]) {
      expect(field).not.toContain(SECRET);
    }
    expect(summary).toContain('[REDACTED:anthropic-key]');
    expect(topics).toContain('[REDACTED:anthropic-key]'); // scrub reaches topics
    expect(loa.description).toContain('[REDACTED:anthropic-key]');
    expect(decision).toContain('[REDACTED:anthropic-key]');
  });
});

describe('runExtractCore — secret in the ERRORS FIXED error-key position (#133)', () => {
  // The `[REDACTED:<kind>]` marker contains a colon, and the ERRORS FIXED bullet
  // parsers split on the FIRST colon (`line.indexOf(':')`). When a secret sits in
  // the error-key position, scrub rewrites it to `[REDACTED:anthropic-key]` and the
  // split lands INSIDE the marker → error="[REDACTED", fix="anthropic-key]: …".
  // This is the accepted redact-over-leak tradeoff (see extract-core SECURITY GUARD):
  // the split is wonky, but the cleartext secret was already redacted before the
  // parser ran, so it can NEVER persist. This test locks that no-leak guarantee and
  // documents the real (split) shape.
  test('the secret never persists as cleartext and the parse degrades gracefully', async () => {
    const fixture = `## ONE SENTENCE SUMMARY
We hardened the shared write path so leaked credentials are redacted before any row is persisted to the database.

## MAIN IDEAS
- A secret pasted into an ERRORS FIXED bullet must never survive into a stored row as cleartext
- The redaction marker contains a colon, so the first-colon split can land inside it on a secret-bearing row
- That split is wonky but safe because the cleartext secret was already replaced before the parser ever ran

## ERRORS FIXED
- ${SECRET}: replaced the leaked credential with a vault reference and restarted the affected service`;

    const result = await runExtractCore(dbPath, 'raw', BASE_CTX, {
      extract: async () => fixture,
      deriveMeta,
    });

    // Graceful degrade — no throw; the row is still produced (one learning, one error).
    expect(result.outcome).toBe('extracted');
    expect(result.dualWrite!.failures).toEqual({});
    expect(result.dualWrite!.learnings).toBe(1);
    expect(result.dualWrite!.errors).toBe(1);
    expect(result.redactions).toContain('anthropic-key');

    // The load-bearing guarantee: the cleartext secret reaches NO row, anywhere.
    // Mutation — bypass scrub() in runExtractCore → the secret persists → RED.
    const persisted = allPersistedText();
    expect(persisted).not.toContain(SECRET);

    // Document the REAL split shape: the first-colon split lands inside the marker,
    // so the error-key half is "[REDACTED" and the fix half carries the rest. Neither
    // half is cleartext. (LoA fabric_extract still holds the intact marker.)
    const db = openRead();
    const learning = db.prepare('SELECT problem, solution FROM learnings').get() as any;
    const err = db.prepare('SELECT error_key, error, fix FROM extraction_errors').get() as any;
    db.close();

    expect(learning.problem).toBe('[REDACTED');
    expect(learning.solution).toBe(
      'anthropic-key]: replaced the leaked credential with a vault reference and restarted the affected service',
    );
    expect(err.error).toBe('[REDACTED');
    expect(err.error_key).toBe('[redacted');
    expect(err.fix).toBe(
      'anthropic-key]: replaced the leaked credential with a vault reference and restarted the affected service',
    );
    for (const field of [learning.problem, learning.solution, err.error_key, err.error, err.fix]) {
      expect(field).not.toContain(SECRET);
    }
  });
});

describe('runExtractCore — invisible-unicode strip', () => {
  test('a planted bidi codepoint is absent from the written row', async () => {
    const fixture = `## ONE SENTENCE SUMMARY
A normal summary line describing a routine refactor of the shared extraction write path.

## MAIN IDEAS
- An idea with a hidden ${BIDI} override char embedded in the middle of the sentence
- Invisible and bidirectional unicode can hide or reorder text inside a stored record
- The write-safety guard strips these codepoints before anything is persisted to disk

## DECISIONS MADE
- Strip ${BIDI} invisible unicode before persisting so stored rows are clean (confidence: HIGH)`;

    const result = await runExtractCore(dbPath, 'raw', BASE_CTX, {
      extract: async () => fixture,
      deriveMeta,
    });
    expect(result.outcome).toBe('extracted');

    // Mutation — drop stripInvisibleUnicode from scrub → the bidi char survives → RED.
    const persisted = allPersistedText();
    expect(persisted).not.toContain(BIDI);
  });
});

describe('runExtractCore — early-exit outcomes write nothing', () => {
  test('extraction failure (model returns null) → no SQLite write', async () => {
    const result = await runExtractCore(dbPath, 'raw', BASE_CTX, {
      extract: async () => null,
      deriveMeta,
    });
    expect(result.outcome).toBe('extraction_failed');
    expect(result.dualWrite).toBeUndefined();

    const db = openRead();
    expect((db.prepare('SELECT COUNT(*) c FROM extraction_sessions').get() as any).c).toBe(0);
    db.close();
  });

  test('quality-gate failure (too short / no sections) → no SQLite write', async () => {
    const result = await runExtractCore(dbPath, 'raw', BASE_CTX, {
      extract: async () => 'too short to pass the gate',
      deriveMeta,
    });
    expect(result.outcome).toBe('quality_failed');
    expect(result.quality?.pass).toBe(false);
    expect(result.dualWrite).toBeUndefined();

    const db = openRead();
    expect((db.prepare('SELECT COUNT(*) c FROM extraction_sessions').get() as any).c).toBe(0);
    db.close();
  });
});

describe('Stop-path structure — markdown side-effects unchanged & still firing; core is SQLite-only', () => {
  const recallSrc = readFileSync(
    join(import.meta.dir, '../../hooks/RecallExtract.ts'),
    'utf-8',
  );
  const coreSrc = readFileSync(
    join(import.meta.dir, '../../hooks/lib/extract-core.ts'),
    'utf-8',
  );

  test('extractAndAppend routes through the core and still fires every markdown side-effect on RAW text', () => {
    // Mutation — delete any of these calls from the Stop path → RED.
    expect(recallSrc).toContain('await runExtractCore(');
    expect(recallSrc).toContain('appendFileSync(DISTILLED_PATH, header + extracted.trim()');
    expect(recallSrc).toContain('updateHotRecall(extracted, sessionLabel, timestamp)');
    expect(recallSrc).toContain('updateSessionIndex({');
    expect(recallSrc).toContain('# Session Transcript: ${sessionLabel}'); // LoA transcript
    expect(recallSrc).toContain('appendDecisions(extracted, sessionLabel, timestamp)');
    expect(recallSrc).toContain('appendRejections(extracted, sessionLabel, timestamp)');
    expect(recallSrc).toContain('appendErrors(extracted, sessionLabel, timestamp)');
  });

  test('the core is SQLite-only — it never touches the markdown side-effects', () => {
    expect(coreSrc).not.toContain('DISTILLED');
    expect(coreSrc).not.toContain('HOT_RECALL');
    expect(coreSrc).not.toContain('updateSessionIndex');
    expect(coreSrc).not.toContain('updateHotRecall');
  });
});
