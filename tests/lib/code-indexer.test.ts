import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { indexCode } from '../../src/lib/code-indexer.js';

const CODE_KG_SCHEMA = `
CREATE TABLE code_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER,
  node_count INTEGER DEFAULT 0,
  parse_error TEXT,
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project, path)
);
CREATE TABLE code_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT,
  signature TEXT,
  is_exported INTEGER DEFAULT 0,
  language TEXT,
  start_line INTEGER,
  start_col INTEGER,
  end_line INTEGER,
  end_col INTEGER,
  UNIQUE (project, node_id),
  FOREIGN KEY (file_id) REFERENCES code_files(id) ON DELETE CASCADE
);
CREATE TABLE code_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id INTEGER NOT NULL,
  dst_id INTEGER,
  dst_hint TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('imports', 'structural', 'calls', 'inheritance')),
  provenance TEXT NOT NULL CHECK (provenance IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
  line INTEGER,
  col INTEGER,
  metadata TEXT,
  FOREIGN KEY (src_id) REFERENCES code_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (dst_id) REFERENCES code_nodes(id) ON DELETE SET NULL
);
CREATE INDEX idx_code_nodes_project_qn ON code_nodes(project, qualified_name);
CREATE INDEX idx_code_edges_unresolved ON code_edges(dst_hint) WHERE dst_id IS NULL;
`;

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(CODE_KG_SCHEMA);
  return db;
}

describe('code indexer', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  test('captures exported arrow and function-expression const definitions', async () => {
    root = mkdtempSync(join(tmpdir(), 'recall-kg-defs-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'defs.ts'), `
export const exportedArrow = () => helper();
export const exportedExpression = function () { return helper(); };
function helper() { return 1; }
`);

    const db = createDb();
    await indexCode({ db, root, target: join(root, 'src'), project: 'fixture' });

    const rows = db.prepare(`
      SELECT name, kind, is_exported, qualified_name, node_id
      FROM code_nodes
      WHERE project = 'fixture' AND name IN ('exportedArrow', 'exportedExpression')
      ORDER BY name
    `).all() as Array<{ name: string; kind: string; is_exported: number; qualified_name: string; node_id: string }>;

    expect(rows.map((row) => row.name)).toEqual(['exportedArrow', 'exportedExpression']);
    expect(rows.every((row) => row.kind === 'function' && row.is_exported === 1)).toBe(true);
    expect(rows.every((row) => row.node_id.includes(`src/defs.ts:${row.qualified_name}:`))).toBe(true);
  });

  test('attributes calls to arrow const and action callback scopes', async () => {
    root = mkdtempSync(join(tmpdir(), 'recall-kg-calls-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), `
const program = { action(fn: () => void) { fn(); } };
function helper() { return 1; }
export const runner = () => {
  helper();
  service.api.doThing();
};
program.action(() => {
  helper();
});
`);

    const db = createDb();
    await indexCode({ db, root, target: join(root, 'src'), project: 'fixture' });

    const helperCalls = db.prepare(`
      SELECT src.qualified_name AS src_qn, dst.qualified_name AS dst_qn, e.dst_hint, e.provenance, e.dst_id
      FROM code_edges AS e
      JOIN code_nodes AS src ON src.id = e.src_id
      LEFT JOIN code_nodes AS dst ON dst.id = e.dst_id
      WHERE e.kind = 'calls' AND e.dst_hint = 'helper'
      ORDER BY e.line
    `).all() as Array<{ src_qn: string; dst_qn: string; dst_hint: string; provenance: string; dst_id: number | null }>;

    expect(helperCalls).toHaveLength(2);
    expect(helperCalls.map((row) => row.src_qn)).toEqual(['runner', 'action.callback@8:15']);
    expect(helperCalls.every((row) => row.dst_qn === 'helper' && row.dst_id !== null && row.provenance === 'EXTRACTED')).toBe(true);
    expect(helperCalls.every((row) => !row.src_qn.endsWith('src/index.ts'))).toBe(true);

    const memberCalls = db.prepare(`
      SELECT dst_hint, COUNT(*) AS count
      FROM code_edges
      WHERE kind = 'calls' AND dst_hint IN ('service', 'api', 'doThing')
      GROUP BY dst_hint
    `).all() as Array<{ dst_hint: string; count: number }>;
    expect(memberCalls).toEqual([{ dst_hint: 'doThing', count: 1 }]);
  });

  test('indexes the repository root target instead of treating it as an escape', async () => {
    root = mkdtempSync(join(tmpdir(), 'recall-kg-root-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'rooted.ts'), 'export const rooted = () => 1;\n');

    const db = createDb();
    const result = await indexCode({ db, root, target: root, project: 'fixture' });

    expect(result.filesSeen).toBe(1);
    expect(result.filesIndexed).toBe(1);
    const row = db.prepare("SELECT path, name FROM code_nodes JOIN code_files ON code_files.id = code_nodes.file_id WHERE name = 'rooted'").get() as { path: string; name: string };
    expect(row).toEqual({ path: 'src/rooted.ts', name: 'rooted' });
  });

  test('resolves import edges to the target module node', async () => {
    root = mkdtempSync(join(tmpdir(), 'recall-kg-imports-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'target.ts'), 'export function imported() { return 1; }\nexport function other() { return 2; }\n');
    writeFileSync(join(root, 'src', 'caller.ts'), "import { imported } from './target.js';\nexport const caller = () => imported();\n");

    const db = createDb();
    await indexCode({ db, root, target: join(root, 'src'), project: 'fixture' });

    const importEdges = db.prepare(`
      SELECT src.qualified_name AS src_qn, dst.qualified_name AS dst_qn, dst.kind AS dst_kind, e.provenance
      FROM code_edges AS e
      JOIN code_nodes AS src ON src.id = e.src_id
      JOIN code_nodes AS dst ON dst.id = e.dst_id
      WHERE e.kind = 'imports'
    `).all() as Array<{ src_qn: string; dst_qn: string; dst_kind: string; provenance: string }>;

    expect(importEdges).toEqual([{
      src_qn: 'src/caller.ts',
      dst_qn: 'src/target.ts',
      dst_kind: 'module',
      provenance: 'EXTRACTED',
    }]);
  });

  test('re-links unresolved edges when a later indexed file defines the target', async () => {
    root = mkdtempSync(join(tmpdir(), 'recall-kg-relink-'));
    mkdirSync(join(root, 'src'));
    const caller = join(root, 'src', 'caller.ts');
    const target = join(root, 'src', 'target.ts');
    writeFileSync(caller, 'export const caller = () => later();\n');
    writeFileSync(target, 'export function later() { return 1; }\n');

    const db = createDb();
    await indexCode({ db, root, target: caller, project: 'fixture' });
    const unresolved = db.prepare("SELECT dst_id, provenance FROM code_edges WHERE kind = 'calls' AND dst_hint = 'later'").get() as { dst_id: number | null; provenance: string };
    expect(unresolved.dst_id).toBeNull();
    expect(unresolved.provenance).toBe('INFERRED');

    const result = await indexCode({ db, root, target, project: 'fixture' });
    expect(result.edgesRelinked).toBe(1);
    const relinked = db.prepare("SELECT dst_id, provenance FROM code_edges WHERE kind = 'calls' AND dst_hint = 'later'").get() as { dst_id: number | null; provenance: string };
    expect(relinked.dst_id).not.toBeNull();
    expect(relinked.provenance).toBe('EXTRACTED');
  });
});
