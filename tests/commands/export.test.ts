// recall export — issue #43 acceptance criteria.
//
// Behavior under test:
// - JSON/Markdown exports carry an explicit provenance field on every
//   provenance-bearing row; legacy NULL renders as 'unknown', never omitted
// - sessions rows (no provenance column) get no invented field
// - manifest carries version, schema, counts, and provenance counts incl. unknown
// - SQL dump and SQLite backup creation; backup includes embeddings, app
//   formats exclude them
// - --backup writes a timestamped dump, creates the directory, never overwrites
// - --output file vs directory contract; directory exports write manifest.json
// - no --output keeps stdout data-only (piping contract)
// - large exports span multiple read batches without dropping or duplicating rows

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runExport } from '../../src/commands/export';
import { EXPORT_TABLES, PROVENANCE_TABLES } from '../../src/lib/export';
import { SQLITE_SAFE_CHUNK_SIZE } from '../../src/lib/chunk';
import {
  createSession,
  addMessage,
  addMessagesBatch,
  addDecision,
  addLearning,
  addBreadcrumb,
  createLoaEntry,
} from '../../src/lib/memory';

let dbPath: string;
let outDir: string;
const NOW = new Date('2026-01-02T03:04:05Z');
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  dbPath = setupTestDb();
  outDir = mkdtempSync(join(tmpdir(), 'recall-export-out-'));
  console.log = () => {};
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  teardownTestDb();
  rmSync(outDir, { recursive: true, force: true });
});

/** One known-provenance and one legacy (NULL) row across the durable tables. */
function seed(): void {
  createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
  addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'known message', provenance: 'verbatim' });
  addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', content: "legacy 'quoted' message\nsecond line" });
  addDecision({ session_id: 's1', decision: 'known decision', status: 'active', provenance: 'user_authored' });
  addDecision({ session_id: 's1', decision: 'legacy decision', status: 'active' });
  addLearning({ session_id: 's1', problem: 'legacy problem', solution: 'fix' });
  addBreadcrumb({ session_id: 's1', content: 'known crumb', importance: 5, provenance: 'extracted' });
  createLoaEntry({ title: 'legacy entry', fabric_extract: 'extract body' });
}

function readJsonExport(file: string): any {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

describe('JSON export provenance', () => {
  test('every provenance-bearing row carries an explicit field; NULL renders as unknown', () => {
    seed();
    const file = join(outDir, 'export.json');
    runExport({ format: 'json', output: file, now: NOW });

    const doc = readJsonExport(file);
    expect(Object.keys(doc.tables).sort()).toEqual([...EXPORT_TABLES].sort());

    for (const table of PROVENANCE_TABLES) {
      for (const row of doc.tables[table]) {
        expect(typeof row.provenance).toBe('string');
      }
    }

    const legacy = doc.tables.messages.find((m: any) => m.content.startsWith('legacy'));
    const known = doc.tables.messages.find((m: any) => m.content.startsWith('known'));
    expect(legacy.provenance).toBe('unknown');
    expect(known.provenance).toBe('verbatim');
    expect(doc.tables.decisions.map((d: any) => d.provenance).sort()).toEqual(['unknown', 'user_authored']);
    expect(doc.tables.loa_entries[0].provenance).toBe('unknown');

    // sessions has no provenance column — no field is invented
    for (const row of doc.tables.sessions) {
      expect('provenance' in row).toBe(false);
    }

    // embeddings excluded from app-level export
    expect(doc.tables.embeddings).toBeUndefined();
    expect(doc.manifest.includes_embeddings).toBe(false);
  });
});

describe('Markdown export provenance', () => {
  test('renders provenance per row, including explicit unknown', () => {
    seed();
    const file = join(outDir, 'export.md');
    runExport({ format: 'markdown', output: file, now: NOW });

    const md = readFileSync(file, 'utf-8');
    expect(md).toContain('# Recall Memory Export');
    expect(md).toContain('## messages (2 rows)');
    expect(md).toContain('**provenance:** verbatim');
    expect(md).toContain('**provenance:** unknown');
    expect(md).toContain('**Embeddings included:** no');
  });
});

describe('manifest', () => {
  test('directory export writes manifest.json with counts and provenance counts incl. unknown', () => {
    seed();
    runExport({ format: 'json', output: outDir, now: NOW });

    const manifestPath = join(outDir, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    expect(manifest.recall_version).toBeTruthy();
    expect(manifest.created_at).toBe(NOW.toISOString());
    expect(manifest.schema_version).toBeGreaterThanOrEqual(9);
    expect(manifest.format).toBe('json');
    expect(manifest.counts).toEqual({
      sessions: 1,
      messages: 2,
      decisions: 2,
      learnings: 1,
      breadcrumbs: 1,
      loa_entries: 1,
    });
    expect(manifest.provenance_counts.messages).toEqual({ unknown: 1, verbatim: 1 });
    expect(manifest.provenance_counts.decisions).toEqual({ unknown: 1, user_authored: 1 });
    expect(manifest.provenance_counts.learnings).toEqual({ unknown: 1 });
    // unknown is explicit even at zero
    expect(manifest.provenance_counts.breadcrumbs).toEqual({ unknown: 0, extracted: 1 });
    expect(manifest.provenance_counts.loa_entries).toEqual({ unknown: 1 });
    expect(manifest.includes_embeddings).toBe(false);

    // artifact written alongside the manifest
    const artifacts = readdirSync(outDir).filter(f => /^recall-export-.*\.json$/.test(f));
    expect(artifacts.length).toBe(1);
  });

  test('file export writes a single file and no manifest.json', () => {
    seed();
    const file = join(outDir, 'single.json');
    runExport({ format: 'json', output: file, now: NOW });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });
});

describe('SQL dump', () => {
  test('creates a textual dump of the durable tables, excluding embeddings', () => {
    seed();
    const file = join(outDir, 'dump.sql');
    runExport({ format: 'sql', output: file, now: NOW });

    const sql = readFileSync(file, 'utf-8');
    expect(sql).toContain('CREATE TABLE sessions');
    expect(sql).toContain('INSERT INTO "messages"');
    expect(sql).toContain("''quoted''"); // escaped single quotes
    expect(sql).toContain('BEGIN TRANSACTION;');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toContain('INSERT INTO "embeddings"');
    expect(sql).not.toContain('CREATE TABLE embeddings');
  });
});

describe('SQLite backup format', () => {
  test('copies the full database including embeddings', () => {
    seed();
    const raw = new Database(dbPath);
    raw.prepare(
      `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding) VALUES ('messages', 1, 'test-model', 2, ?)`
    ).run(new Uint8Array([1, 2]));
    raw.close();

    const copyPath = join(outDir, 'copy.db');
    runExport({ format: 'sqlite', output: copyPath, now: NOW });

    const copy = new Database(copyPath, { readonly: true });
    try {
      const embeddings = copy.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number };
      const messages = copy.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
      expect(embeddings.c).toBe(1);
      expect(messages.c).toBe(2);
    } finally {
      copy.close();
    }
  });

  test('refuses to overwrite an existing backup file', () => {
    seed();
    const copyPath = join(outDir, 'copy.db');
    runExport({ format: 'sqlite', output: copyPath, now: NOW });
    expect(() => runExport({ format: 'sqlite', output: copyPath, now: NOW })).toThrow(/Refusing to overwrite/);
  });

  test('requires --output', () => {
    seed();
    expect(() => runExport({ format: 'sqlite', now: NOW })).toThrow(/requires --output/);
  });

  test('directory export writes the backup plus manifest.json with embeddings included', () => {
    seed();
    runExport({ format: 'sqlite', output: outDir, now: NOW });
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.format).toBe('sqlite');
    expect(manifest.includes_embeddings).toBe(true);
    expect(manifest.tables).toContain('embeddings');
    const artifacts = readdirSync(outDir).filter(f => /^recall-export-.*\.db$/.test(f));
    expect(artifacts.length).toBe(1);
  });
});

describe('--backup', () => {
  test('writes a timestamped SQL dump, creates the directory, and prints the path', () => {
    seed();
    const backupDir = join(outDir, 'nested', 'backups');
    const logs: string[] = [];
    console.log = (msg: unknown) => { logs.push(String(msg)); };

    runExport({ backup: true, backupDir, now: NOW });

    const expected = join(backupDir, 'recall-backup-20260102-030405.sql');
    expect(existsSync(expected)).toBe(true);
    expect(logs.join('\n')).toContain(expected);
    expect(readFileSync(expected, 'utf-8')).toContain('INSERT INTO "messages"');
  });

  test('never overwrites an existing backup file', () => {
    seed();
    const backupDir = join(outDir, 'backups');
    runExport({ backup: true, backupDir, now: NOW });
    const first = join(backupDir, 'recall-backup-20260102-030405.sql');
    const firstContent = readFileSync(first, 'utf-8');

    // Same timestamp → must pick a new name, not clobber
    runExport({ backup: true, backupDir, now: NOW });
    const second = join(backupDir, 'recall-backup-20260102-030405-1.sql');
    expect(existsSync(second)).toBe(true);
    expect(readFileSync(first, 'utf-8')).toBe(firstContent);
  });

  test('rejects conflicting flags', () => {
    seed();
    expect(() => runExport({ backup: true, output: join(outDir, 'x.sql'), now: NOW })).toThrow(/--output/);
    expect(() => runExport({ backup: true, format: 'json', backupDir: join(outDir, 'b'), now: NOW })).toThrow(/SQL dump/);
    // --format sql is the backup format and is allowed
    runExport({ backup: true, format: 'sql', backupDir: join(outDir, 'b'), now: NOW });
  });
});

describe('stdout piping contract', () => {
  test('without --output, stdout carries only the export data', () => {
    seed();
    const chunks: string[] = [];
    const errors: string[] = [];
    const originalWrite = process.stdout.write;
    (process.stdout as any).write = (chunk: unknown) => { chunks.push(String(chunk)); return true; };
    console.error = (msg: unknown) => { errors.push(String(msg)); };
    try {
      runExport({ format: 'json', now: NOW });
    } finally {
      process.stdout.write = originalWrite;
    }

    // stdout parses as pure JSON — no manifest text mixed in
    const doc = JSON.parse(chunks.join(''));
    expect(doc.manifest.format).toBe('json');
    // summary went to stderr
    expect(errors.join('\n')).toContain('Recall export');
  });
});

describe('large export', () => {
  test('spans multiple read batches without dropping or duplicating rows', () => {
    seed();
    const bulk = SQLITE_SAFE_CHUNK_SIZE * 2 + 50;
    addMessagesBatch(
      Array.from({ length: bulk }, (_, i) => ({
        session_id: 's1',
        timestamp: `2026-01-01T01:00:00.${String(i).padStart(3, '0')}Z`,
        role: 'user' as const,
        content: `bulk ${i}`,
        provenance: 'verbatim' as const,
      }))
    );

    const file = join(outDir, 'large.json');
    runExport({ format: 'json', output: file, now: NOW });

    const doc = readJsonExport(file);
    const ids = doc.tables.messages.map((m: any) => m.id);
    expect(ids.length).toBe(bulk + 2); // bulk + two seeded messages
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    const sorted = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sorted); // keyset order preserved
  });
});
