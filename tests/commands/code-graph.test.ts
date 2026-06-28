import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '../../src/db/connection';
import { runCallers, runCallees, runTrace } from '../../src/commands/code-graph';
import { runIndexCode } from '../../src/commands/index-code';
import { setupTestDb, teardownTestDb } from '../helpers/setup';

let output = '';
let errorOutput = '';
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExitCode: typeof process.exitCode;

function captureConsole(): void {
  output = '';
  errorOutput = '';
  originalLog = console.log;
  originalError = console.error;
  originalExitCode = process.exitCode;
  console.log = (message?: unknown) => {
    output += `${String(message ?? '')}\n`;
  };
  console.error = (message?: unknown) => {
    errorOutput += `${String(message ?? '')}\n`;
  };
}

function restoreConsole(): void {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode ?? 0;
}

function insertFile(project: string, path: string): number {
  const result = getDb().prepare(`
    INSERT INTO code_files (project, path, language, content_hash, size_bytes, node_count)
    VALUES (?, ?, 'typescript', ?, 10, 0)
  `).run(project, path, `${path}:hash`);
  return Number(result.lastInsertRowid);
}

function insertNode(project: string, fileId: number, nodeId: string, name: string, qualifiedName: string, line: number): number {
  const result = getDb().prepare(`
    INSERT INTO code_nodes (project, file_id, node_id, kind, name, qualified_name, language, start_line, start_col, end_line, end_col)
    VALUES (?, ?, ?, 'function', ?, ?, 'typescript', ?, 0, ?, 10)
  `).run(project, fileId, nodeId, name, qualifiedName, line, line);
  return Number(result.lastInsertRowid);
}

function insertCall(srcId: number, dstId: number | null, hint: string, provenance: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS', line: number): void {
  getDb().prepare(`
    INSERT INTO code_edges (src_id, dst_id, dst_hint, kind, provenance, line, col)
    VALUES (?, ?, ?, 'calls', ?, ?, 0)
  `).run(srcId, dstId, hint, provenance, line);
}

function seedGraph(): void {
  const rootFile = insertFile('fixture', 'src/root.ts');
  const midFile = insertFile('fixture', 'src/mid.ts');
  const leafFile = insertFile('fixture', 'src/leaf.ts');
  const root = insertNode('fixture', rootFile, 'function:src/root.ts:root:1:0', 'root', 'root', 1);
  const mid = insertNode('fixture', midFile, 'function:src/mid.ts:mid:1:0', 'mid', 'mid', 1);
  const leaf = insertNode('fixture', leafFile, 'function:src/leaf.ts:leaf:1:0', 'leaf', 'leaf', 1);
  insertCall(root, mid, 'mid', 'EXTRACTED', 3);
  insertCall(mid, leaf, 'leaf', 'EXTRACTED', 4);
  insertCall(root, null, 'missing', 'INFERRED', 5);
}

describe('code graph CLI verbs', () => {
  beforeEach(() => {
    setupTestDb();
    captureConsole();
    seedGraph();
  });

  afterEach(() => {
    restoreConsole();
    teardownTestDb();
  });

  test('callers prints resolved callers for a symbol', () => {
    runCallers('leaf', { project: 'fixture' });

    expect(output).toContain('src/mid.ts:4 mid -> leaf [EXTRACTED/resolved]');
  });

  test('callers prints unresolved candidate calls without dropping them', () => {
    runCallers('missing', { project: 'fixture' });

    expect(output).toContain('No code symbol matched missing in fixture');
    expect(output).toContain('Unresolved candidate calls:');
    expect(output).toContain('src/root.ts:5 root -> <missing> [INFERRED/unresolved]');
  });

  test('callees prints resolved and unresolved outgoing calls', () => {
    runCallees('root', { project: 'fixture' });

    expect(output).toContain('src/root.ts:3 root -> mid [EXTRACTED/resolved]');
    expect(output).toContain('src/root.ts:5 root -> <missing> [INFERRED/unresolved]');
  });

  test('trace prints a deterministic resolved path', () => {
    runTrace('root', 'leaf', { project: 'fixture', depth: '4' });

    expect(output).toContain('root (src/root.ts:1)');
    expect(output).toContain('-> mid via src/root.ts:3 [EXTRACTED/resolved]');
    expect(output).toContain('-> leaf via src/mid.ts:4 [EXTRACTED/resolved]');
  });
});

describe('code graph capability guard', () => {
  beforeEach(() => {
    setupTestDb();
    captureConsole();
    getDb().exec('PRAGMA user_version = 15');
  });

  afterEach(() => {
    restoreConsole();
    teardownTestDb();
  });

  test('new graph verbs print a friendly schema message on old databases', () => {
    runCallers('leaf', { project: 'fixture' });

    expect(errorOutput).toContain('Native code graph schema is not installed yet');
    expect(errorOutput).toContain("Run 'recall init'");
    expect(process.exitCode).toBe(1);
  });

  test('recall index prints the same friendly schema message on old databases', async () => {
    await runIndexCode(undefined, {});

    expect(errorOutput).toContain('Native code graph schema is not installed yet');
    expect(errorOutput).toContain("Run 'recall init'");
    expect(process.exitCode).toBe(1);
  });

  test('graph verbs print a friendly schema message when code tables are absent', () => {
    getDb().exec('PRAGMA user_version = 16');
    getDb().exec('DROP TABLE code_edges');

    runCallers('leaf', { project: 'fixture' });

    expect(errorOutput).toContain('Native code graph tables are missing');
    expect(errorOutput).toContain('code_edges');
    expect(errorOutput).toContain("Run 'recall init'");
    expect(process.exitCode).toBe(1);
  });
});
