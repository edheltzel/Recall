// Property-based tests for export invariants (issue #44 phase 2; export
// surface from issue #43, merged in PR #59).
//
// Every oracle is computed from generator inputs only (the tuple-multiset
// pattern from PR #57): expected counts, provenance histograms, and
// (text, provenance) tuples all derive from the generated corpus, never from
// the implementation under test. The SQL round-trip additionally checks
// dump→restore as an inverse pair against the rows the generator inserted.
//
// Two distinct NULL-provenance contracts are pinned:
// - app-level (JSON/Markdown) exports render NULL as the literal 'unknown',
//   never omitted, never guessed (issue #43 provenance contract);
// - the SQL dump carries raw rows, so NULL survives restore as NULL.
//
// Generator sizes are bounded (≤6 rows per table) so the suite stays
// practical under normal `bun test` runs.

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import fc from 'fast-check';
import {
  buildManifest,
  collectExportData,
  EXPORT_TABLES,
  renderJsonExport,
  renderMarkdownExport,
  renderSqlDump,
} from '../../src/lib/export';
import { createMemoryDb } from '../helpers/memdb';

type Prov = 'user_authored' | 'verbatim' | 'extracted' | 'derived' | null;

// Spec restated (issue #43 / ADR-0001), deliberately not imported from
// src/types: a regression that drops a table from PROVENANCE_TABLES or
// EXPORT_TABLES must fail here instead of silently weakening the oracle.
const PROV_TABLES = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'] as const;
const ALL_TABLES = ['sessions', ...PROV_TABLES, 'dedup_lineage'] as const;
type ProvTable = typeof PROV_TABLES[number];

// Which column carries the generated text per table.
const TEXT_COLUMN: Record<ProvTable, string> = {
  messages: 'content',
  decisions: 'decision',
  learnings: 'problem',
  breadcrumbs: 'content',
  loa_entries: 'fabric_extract',
};

interface GenRecord {
  text: string;
  project: string | null;
  provenance: Prov;
  importance: number;
}

interface GenCorpus {
  sessions: number;
  messages: GenRecord[];
  decisions: GenRecord[];
  learnings: GenRecord[];
  breadcrumbs: GenRecord[];
  loa_entries: GenRecord[];
  lineage: number;
}

// Apostrophes and newlines are injected with probability 1/2 each so SQL
// quoting and Markdown multi-line rendering are exercised on every run.
const textArb = fc
  .tuple(fc.string({ maxLength: 30 }), fc.boolean(), fc.boolean())
  .map(([s, apostrophe, multiline]) =>
    `${apostrophe ? "it's " : ''}${s}${multiline ? '\nsecond "line"' : ''}`);

const recordArb: fc.Arbitrary<GenRecord> = fc.record({
  text: textArb,
  project: fc.option(fc.constantFrom('proj-a', 'proj-b'), { nil: null }),
  provenance: fc.constantFrom<Prov>('user_authored', 'verbatim', 'extracted', 'derived', null),
  importance: fc.integer({ min: 1, max: 10 }),
});

const rowsArb = fc.array(recordArb, { maxLength: 6 });

const corpusArb: fc.Arbitrary<GenCorpus> = fc.record({
  sessions: fc.integer({ min: 1, max: 3 }),
  messages: rowsArb,
  decisions: rowsArb,
  learnings: rowsArb,
  breadcrumbs: rowsArb,
  loa_entries: rowsArb,
  lineage: fc.integer({ min: 0, max: 3 }),
});

const CREATED_AT = new Date('2026-06-11T00:00:00Z');

function insertCorpus(db: Database, corpus: GenCorpus): void {
  const session = db.prepare(
    `INSERT INTO sessions (session_id, started_at) VALUES (?, '2026-06-01T00:00:00Z')`
  );
  for (let i = 0; i < corpus.sessions; i++) session.run(`s-${i}`);

  const inserts: Record<ProvTable, (r: GenRecord, i: number) => void> = {
    messages: (r, i) => db.prepare(
      `INSERT INTO messages (session_id, timestamp, role, content, project, importance, provenance)
       VALUES (?, '2026-06-01T01:00:00Z', 'user', ?, ?, ?, ?)`
    ).run(`s-${i % corpus.sessions}`, r.text, r.project, r.importance, r.provenance),
    decisions: r => db.prepare(
      `INSERT INTO decisions (decision, project, importance, provenance) VALUES (?, ?, ?, ?)`
    ).run(r.text, r.project, r.importance, r.provenance),
    learnings: r => db.prepare(
      `INSERT INTO learnings (problem, project, importance, provenance) VALUES (?, ?, ?, ?)`
    ).run(r.text, r.project, r.importance, r.provenance),
    breadcrumbs: r => db.prepare(
      `INSERT INTO breadcrumbs (content, project, importance, provenance) VALUES (?, ?, ?, ?)`
    ).run(r.text, r.project, r.importance, r.provenance),
    loa_entries: r => db.prepare(
      `INSERT INTO loa_entries (title, fabric_extract, project, importance, provenance)
       VALUES ('entry', ?, ?, ?, ?)`
    ).run(r.text, r.project, r.importance, r.provenance),
  };
  for (const table of PROV_TABLES) {
    corpus[table].forEach((r, i) => inserts[table](r, i));
  }

  const lineage = db.prepare(
    `INSERT INTO dedup_lineage (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status)
     VALUES ('messages', ?, 'messages', ?, 'exact', 1.0, 'marked')`
  );
  for (let i = 0; i < corpus.lineage; i++) lineage.run(1000 + i, 2000 + i);
}

function expectedCount(corpus: GenCorpus, table: string): number {
  if (table === 'sessions') return corpus.sessions;
  if (table === 'dedup_lineage') return corpus.lineage;
  return corpus[table as ProvTable].length;
}

// Per-table provenance histogram from generator data: 'unknown' key always
// present (even at zero), other keys only when at least one record carries
// the value — the manifest contract from issue #43.
function expectedHistogram(records: GenRecord[]): Record<string, number> {
  const histogram: Record<string, number> = { unknown: 0 };
  for (const r of records) {
    const key = r.provenance ?? 'unknown';
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return histogram;
}

const sortedJson = (tuples: unknown[][]): string[] =>
  tuples.map(t => JSON.stringify(t)).sort();

function withCorpusDb<T>(corpus: GenCorpus, fn: (db: Database) => T): T {
  const db = createMemoryDb();
  try {
    insertCorpus(db, corpus);
    return fn(db);
  } finally {
    db.close();
  }
}

describe('export properties', () => {
  test('EXPORT_TABLES is the durable-table contract from issues #43/#45', () => {
    expect([...EXPORT_TABLES]).toEqual([...ALL_TABLES]);
  });

  test('JSON export: manifest counts, (text, provenance) tuple multisets, NULL rendered as explicit unknown', () => {
    fc.assert(
      fc.property(corpusArb, corpus => {
        withCorpusDb(corpus, db => {
          const manifest = buildManifest(db, 'json', [...EXPORT_TABLES], {
            includesEmbeddings: false,
            createdAt: CREATED_AT,
          });
          const parsed = JSON.parse(renderJsonExport(manifest, collectExportData(db))) as {
            manifest: typeof manifest;
            tables: Record<string, Array<Record<string, unknown>>>;
          };

          expect(parsed.manifest.tables).toEqual([...ALL_TABLES]);
          for (const table of ALL_TABLES) {
            expect(parsed.manifest.counts[table]).toBe(expectedCount(corpus, table));
            expect(parsed.tables[table].length).toBe(expectedCount(corpus, table));
          }

          for (const table of PROV_TABLES) {
            const actual = parsed.tables[table].map(row => [row[TEXT_COLUMN[table]], row.provenance]);
            const expected = corpus[table].map(r => [r.text, r.provenance ?? 'unknown']);
            expect(sortedJson(actual)).toEqual(sortedJson(expected));
            expect(parsed.manifest.provenance_counts[table]).toEqual(expectedHistogram(corpus[table]));
          }

          // Tables without the column get no field invented.
          for (const row of parsed.tables.sessions) {
            expect('provenance' in row).toBe(false);
          }
        });
      })
    );
  });

  test('Markdown export: one table heading with the generated count, one record heading per generated row', () => {
    fc.assert(
      fc.property(corpusArb, corpus => {
        withCorpusDb(corpus, db => {
          const manifest = buildManifest(db, 'markdown', [...EXPORT_TABLES], {
            includesEmbeddings: false,
            createdAt: CREATED_AT,
          });
          const lines = renderMarkdownExport(manifest, collectExportData(db)).split('\n');

          // Value lines can never start at column 0 with '#': single-line
          // values render inline after '- **key:**' and multi-line values are
          // indented blockquotes — so heading counts are sound oracles even
          // for adversarial generated text.
          expect(lines[0]).toBe('# Recall Memory Export');
          expect(lines.filter(l => l.startsWith('## '))).toEqual(
            ALL_TABLES.map(t => `## ${t} (${expectedCount(corpus, t)} rows)`)
          );
          for (const table of ALL_TABLES) {
            expect(lines.filter(l => l.startsWith(`### ${table} #`)).length).toBe(
              expectedCount(corpus, table)
            );
          }
        });
      })
    );
  });

  test('SQL dump restores into an empty database with full row fidelity; NULL provenance stays NULL', () => {
    fc.assert(
      fc.property(corpusArb, corpus => {
        withCorpusDb(corpus, db => {
          const manifest = buildManifest(db, 'sql', [...EXPORT_TABLES], {
            includesEmbeddings: false,
            createdAt: CREATED_AT,
          });
          const restored = new Database(':memory:');
          try {
            restored.exec(renderSqlDump(db, manifest));

            // dump ∘ restore is the identity on every exported table's rows
            // (the source rows came from the generator's inserts).
            for (const table of ALL_TABLES) {
              const src = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
              const back = restored.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
              expect(back).toEqual(src);
              expect(back.length).toBe(expectedCount(corpus, table));
            }

            // Generator-anchored raw tuples: unlike JSON, the dump carries
            // stored values — legacy NULL provenance must restore as NULL,
            // not as 'unknown'.
            for (const table of PROV_TABLES) {
              const rows = restored.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
              const actual = rows.map(row => [row[TEXT_COLUMN[table]], row.provenance]);
              const expected = corpus[table].map(r => [r.text, r.provenance]);
              expect(sortedJson(actual)).toEqual(sortedJson(expected));
            }
          } finally {
            restored.close();
          }
        });
      })
    );
  });

  test('manifest is accurate for any table subset; provenance histograms always cover every provenance-bearing table', () => {
    fc.assert(
      fc.property(corpusArb, fc.subarray([...ALL_TABLES], { minLength: 1 }), (corpus, subset) => {
        withCorpusDb(corpus, db => {
          const manifest = buildManifest(db, 'json', subset, {
            includesEmbeddings: false,
            createdAt: CREATED_AT,
          });

          expect(manifest.tables).toEqual(subset);
          expect(Object.keys(manifest.counts).sort()).toEqual([...subset].sort());
          for (const table of subset) {
            expect(manifest.counts[table]).toBe(expectedCount(corpus, table));
          }
          expect(Object.keys(manifest.provenance_counts).sort()).toEqual([...PROV_TABLES].sort());
          for (const table of PROV_TABLES) {
            expect(manifest.provenance_counts[table]).toEqual(expectedHistogram(corpus[table]));
          }
          expect(manifest.created_at).toBe(CREATED_AT.toISOString());
          expect(manifest.includes_embeddings).toBe(false);
        });
      })
    );
  });
});
