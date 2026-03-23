import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';

// Schema DDL for creating test tables (mirrors src/db/schema.ts core tables)
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  summary TEXT,
  project TEXT,
  cwd TEXT,
  git_branch TEXT,
  model TEXT,
  source TEXT DEFAULT 'claude-code'
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  category TEXT,
  project TEXT,
  decision TEXT NOT NULL,
  reasoning TEXT,
  alternatives TEXT,
  status TEXT DEFAULT 'active',
  confidence TEXT DEFAULT 'medium'
);
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  category TEXT,
  project TEXT,
  problem TEXT NOT NULL,
  solution TEXT,
  prevention TEXT,
  tags TEXT
);
CREATE TABLE IF NOT EXISTS breadcrumbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  content TEXT NOT NULL,
  category TEXT,
  project TEXT,
  importance INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  expires_at DATETIME
);
`;

let tempDir: string;
let dbPath: string;
let memoryDir: string;
let hotRecallPath: string;

function createTestDb(): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(CORE_SCHEMA);
  return db;
}

function seedDecisions(db: Database, entries: Array<{ decision: string; reasoning?: string; project?: string; created_at?: string }>) {
  const stmt = db.prepare(
    `INSERT INTO decisions (decision, reasoning, project, created_at) VALUES (?, ?, ?, ?)`
  );
  for (const e of entries) {
    stmt.run(e.decision, e.reasoning || null, e.project || null, e.created_at || new Date().toISOString());
  }
}

function seedBreadcrumbs(db: Database, entries: Array<{ content: string; project?: string; importance?: number; expires_at?: string | null }>) {
  const stmt = db.prepare(
    `INSERT INTO breadcrumbs (content, project, importance, expires_at) VALUES (?, ?, ?, ?)`
  );
  for (const e of entries) {
    stmt.run(e.content, e.project || null, e.importance ?? 5, e.expires_at ?? null);
  }
}

function seedLearnings(db: Database, entries: Array<{ problem: string; solution?: string; project?: string }>) {
  const stmt = db.prepare(
    `INSERT INTO learnings (problem, solution, project) VALUES (?, ?, ?)`
  );
  for (const e of entries) {
    stmt.run(e.problem, e.solution || null, e.project || null);
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-hook-test-'));
  dbPath = join(tempDir, 'test.db');
  memoryDir = join(tempDir, 'MEMORY');
  hotRecallPath = join(memoryDir, 'HOT_RECALL.md');
  mkdirSync(memoryDir, { recursive: true });

  // Set env vars so SessionRecall.ts uses our test paths
  process.env.MEM_DB_PATH = dbPath;
  process.env.HOT_RECALL_PATH = hotRecallPath;
});

afterEach(() => {
  delete process.env.MEM_DB_PATH;
  delete process.env.HOT_RECALL_PATH;
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── Helper: run the hook script as a subprocess ─────────────────────
async function runHookProcess(envOverrides: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const hookPath = join(import.meta.dir, '..', '..', 'hooks', 'SessionRecall.ts');
  const proc = Bun.spawn(['bun', 'run', hookPath], {
    env: {
      ...process.env,
      MEM_DB_PATH: dbPath,
      HOT_RECALL_PATH: hotRecallPath,
      ...envOverrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// ─── Helper: import functions from the hook ──────────────────────────
// We dynamically import to get the exported functions while env vars are set
async function importHook() {
  const hookPath = join(import.meta.dir, '..', '..', 'hooks', 'SessionRecall.ts');
  return await import(hookPath);
}

// The test runs inside the Recall repo, so detectProject() returns 'Recall'.
// Use this as the project name when seeding data that should be found.
const TEST_PROJECT = 'Recall';

// =====================================================================
// UNIT TESTS — queryDb
// =====================================================================
describe('queryDb', () => {
  test('returns empty array when DB does not exist', async () => {
    // Point to a non-existent DB
    process.env.MEM_DB_PATH = join(tempDir, 'nonexistent.db');
    const { queryDb } = await importHook();
    const result = queryDb('SELECT 1');
    expect(result).toEqual([]);
  });

  test('returns rows from a valid query', async () => {
    const db = createTestDb();
    seedDecisions(db, [{ decision: 'Use Bun', project: 'test' }]);
    db.close();

    const { queryDb } = await importHook();
    const rows = queryDb('SELECT decision FROM decisions WHERE project = ?', ['test']);
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('Use Bun');
  });

  test('returns empty array on SQL syntax error', async () => {
    createTestDb().close();
    const { queryDb } = await importHook();
    const result = queryDb('SELECTT broken sql');
    expect(result).toEqual([]);
  });

  test('returns empty array for query with no results', async () => {
    createTestDb().close();
    const { queryDb } = await importHook();
    const result = queryDb('SELECT * FROM decisions WHERE project = ?', ['nonexistent']);
    expect(result).toEqual([]);
  });
});

// =====================================================================
// UNIT TESTS — gatherContext
// =====================================================================
describe('gatherContext', () => {
  test('returns header and empty-state message when DB is empty', async () => {
    createTestDb().close();
    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('## Recall — Session Memory Context');
    expect(output).toContain('No memory entries found yet');
    expect(output).toContain('Recall is active');
  });

  test('includes decisions section when decisions exist', async () => {
    const db = createTestDb();
    seedDecisions(db, [
      { decision: 'Use PostgreSQL', reasoning: 'Better JSON support', project: 'Recall' },
    ]);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('### Active Decisions');
    expect(output).toContain('Use PostgreSQL');
    expect(output).toContain('Better JSON support');
  });

  test('deduplicates decisions across project-scoped and global queries', async () => {
    const db = createTestDb();
    // These will appear in both the project query and the global query
    seedDecisions(db, [
      { decision: 'Unique decision A', project: 'Recall' },
      { decision: 'Unique decision B', project: 'Recall' },
    ]);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    // Count occurrences — each should appear exactly once
    const countA = (output.match(/Unique decision A/g) || []).length;
    const countB = (output.match(/Unique decision B/g) || []).length;
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  test('includes breadcrumbs sorted by importance', async () => {
    const db = createTestDb();
    seedBreadcrumbs(db, [
      { content: 'Low importance note', importance: 2, project: TEST_PROJECT },
      { content: 'Critical note', importance: 9, project: TEST_PROJECT },
      { content: 'Normal note', importance: 5, project: TEST_PROJECT },
    ]);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('### Breadcrumbs');
    expect(output).toContain('Critical note');
    expect(output).toContain('(importance: 9/10)');
    // Low importance (<=5) should not show the importance tag
    expect(output).not.toContain('(importance: 2/10)');

    // Critical should appear before low importance in the output
    const critIdx = output.indexOf('Critical note');
    const lowIdx = output.indexOf('Low importance note');
    expect(critIdx).toBeLessThan(lowIdx);
  });

  test('filters out expired breadcrumbs', async () => {
    const db = createTestDb();
    seedBreadcrumbs(db, [
      { content: 'Active breadcrumb', expires_at: '2099-12-31T23:59:59Z', project: TEST_PROJECT },
      { content: 'Expired breadcrumb', expires_at: '2020-01-01T00:00:00Z', project: TEST_PROJECT },
      { content: 'No expiry breadcrumb', expires_at: null, project: TEST_PROJECT },
    ]);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('Active breadcrumb');
    expect(output).toContain('No expiry breadcrumb');
    expect(output).not.toContain('Expired breadcrumb');
  });

  test('includes learnings with problem and solution', async () => {
    const db = createTestDb();
    seedLearnings(db, [
      { problem: 'bun:sqlite uses $param', solution: 'Not :param like better-sqlite3', project: TEST_PROJECT },
    ]);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('### Recent Learnings');
    expect(output).toContain('bun:sqlite uses $param');
    expect(output).toContain('Not :param like better-sqlite3');
  });

  test('handles learnings without solution', async () => {
    const db = createTestDb();
    seedLearnings(db, [{ problem: 'Mysterious error in CI', project: TEST_PROJECT }]);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('Mysterious error in CI');
    expect(output).not.toContain(' → '); // No arrow when no solution
  });

  test('includes HOT_RECALL.md last session summary', async () => {
    writeFileSync(hotRecallPath, `First session summary\n---\nSecond session summary\n---\nThird and latest session`);
    createTestDb().close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('### Last Session Summary');
    expect(output).toContain('Third and latest session');
    // Should NOT include earlier sessions
    expect(output).not.toContain('First session summary');
  });

  test('truncates HOT_RECALL.md content over 500 chars', async () => {
    const longContent = 'A'.repeat(600);
    writeFileSync(hotRecallPath, longContent);
    createTestDb().close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('### Last Session Summary');
    expect(output).toContain('...');
    // The content should be truncated, not the full 600 chars
    expect(output).not.toContain('A'.repeat(600));
  });

  test('ignores HOT_RECALL.md if it does not exist', async () => {
    createTestDb().close();
    // Don't create HOT_RECALL.md
    const { gatherContext } = await importHook();
    const output = gatherContext();

    // Should not crash, should not contain "Last Session Summary"
    expect(output).not.toContain('### Last Session Summary');
    expect(output).toContain('Recall');
  });

  test('ignores empty HOT_RECALL.md', async () => {
    writeFileSync(hotRecallPath, '');
    createTestDb().close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).not.toContain('### Last Session Summary');
  });

  test('always includes the behavioral reminder footer', async () => {
    createTestDb().close();
    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('**Recall is active.**');
    expect(output).toContain('memory_search');
    expect(output).toContain('memory_hybrid_search');
  });
});

// =====================================================================
// EDGE CASES — Schema correctness
// =====================================================================
describe('Schema correctness', () => {
  test('uses expires_at column (not expiry) matching the actual schema', async () => {
    const db = createTestDb();
    // Insert a breadcrumb with a future expires_at — should be returned
    db.prepare(
      `INSERT INTO breadcrumbs (content, importance, expires_at, project) VALUES (?, ?, ?, ?)`
    ).run('Future breadcrumb', 5, '2099-12-31T23:59:59Z', TEST_PROJECT);
    // Insert one with past expires_at — should be filtered
    db.prepare(
      `INSERT INTO breadcrumbs (content, importance, expires_at, project) VALUES (?, ?, ?, ?)`
    ).run('Past breadcrumb', 5, '2020-01-01T00:00:00Z', TEST_PROJECT);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('Future breadcrumb');
    expect(output).not.toContain('Past breadcrumb');
  });
});

// =====================================================================
// EDGE CASES — Empty/Missing DB
// =====================================================================
describe('Edge cases: missing and empty state', () => {
  test('gracefully handles non-existent database', async () => {
    process.env.MEM_DB_PATH = join(tempDir, 'no-such-file.db');
    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('## Recall — Session Memory Context');
    expect(output).toContain('No memory entries found yet');
  });

  test('gracefully handles empty tables', async () => {
    createTestDb().close();
    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('No memory entries found yet');
    expect(output).not.toContain('### Active Decisions');
    expect(output).not.toContain('### Breadcrumbs');
    expect(output).not.toContain('### Recent Learnings');
  });

  test('handles decisions with NULL reasoning and created_at', async () => {
    const db = createTestDb();
    db.prepare('INSERT INTO decisions (decision) VALUES (?)').run('Bare decision');
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('Bare decision');
    // Should not crash on null reasoning — no " — null" in output
    expect(output).not.toContain('null');
  });

  test('handles breadcrumbs with NULL project (excluded from project-scoped query)', async () => {
    const db = createTestDb();
    // A breadcrumb without a project won't match the detected project scope
    seedBreadcrumbs(db, [{ content: 'Orphan breadcrumb', project: undefined }]);
    // But a breadcrumb WITH the project will show
    seedBreadcrumbs(db, [{ content: 'Scoped breadcrumb', project: TEST_PROJECT }]);
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    expect(output).toContain('Scoped breadcrumb');
  });
});

// =====================================================================
// SAFETY TESTS — Output bounds and runaway prevention
// =====================================================================
describe('Safety: output bounds and runaway prevention', () => {
  test('output is capped at MAX_OUTPUT_CHARS', async () => {
    const db = createTestDb();
    // Insert decisions with very large content to exceed 8000 chars
    // SQL LIMIT returns 5 project-scoped + 3 global = up to 7 unique
    // Each entry needs ~1200+ chars to exceed 8000 total
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        decision: `Decision ${i}: ${'X'.repeat(1500)}`,
        reasoning: `Reasoning ${i}: ${'Y'.repeat(1500)}`,
        project: TEST_PROJECT,
      });
    }
    seedDecisions(db, entries);
    // Also add large breadcrumbs and learnings
    for (let i = 0; i < 5; i++) {
      seedBreadcrumbs(db, [{ content: `Breadcrumb ${'Z'.repeat(1500)}`, project: TEST_PROJECT }]);
      seedLearnings(db, [{ problem: `Problem ${'W'.repeat(1500)}`, solution: `Solution ${'V'.repeat(1500)}`, project: TEST_PROJECT }]);
    }
    db.close();

    const { gatherContext } = await importHook();
    const output = gatherContext();

    // Output should be bounded (MAX_OUTPUT_CHARS = 8000 + truncation message)
    expect(output.length).toBeLessThan(8200);
    expect(output).toContain('[Output truncated');
  });

  test('process exits cleanly (no hang) even with large DB', async () => {
    const db = createTestDb();
    // Insert enough data to be substantial but not extreme
    for (let i = 0; i < 100; i++) {
      db.prepare('INSERT INTO decisions (decision, reasoning, project) VALUES (?, ?, ?)')
        .run(`Decision ${i}`, `Reasoning for ${i}`, 'test-project');
      db.prepare('INSERT INTO breadcrumbs (content, importance, project) VALUES (?, ?, ?)')
        .run(`Breadcrumb ${i}`, (i % 10) + 1, 'test-project');
      db.prepare('INSERT INTO learnings (problem, solution, project) VALUES (?, ?, ?)')
        .run(`Problem ${i}`, `Solution ${i}`, 'test-project');
    }
    db.close();

    // Run as subprocess with a hard timeout
    const start = Date.now();
    const { exitCode, stdout } = await runHookProcess();
    const elapsed = Date.now() - start;

    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // Must complete well under 5s (target: <2s)
    expect(elapsed).toBeLessThan(5000);
  });

  test('process exits with code 0 even when DB is missing', async () => {
    const { exitCode, stdout } = await runHookProcess({
      MEM_DB_PATH: join(tempDir, 'totally-missing.db'),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Recall');
  });

  test('process exits with code 0 even when DB is corrupt', async () => {
    // Write garbage to the DB path
    writeFileSync(dbPath, 'this is not a sqlite database');

    const { exitCode, stdout } = await runHookProcess();

    expect(exitCode).toBe(0);
    // Should still produce some output (graceful degradation)
    expect(stdout.length).toBeGreaterThan(0);
  });

  test('process does not produce unbounded stderr', async () => {
    createTestDb().close();

    const { stderr } = await runHookProcess();

    // Stderr should be minimal (no stack traces, no runaway logging)
    expect(stderr.length).toBeLessThan(1000);
  });
});

// =====================================================================
// SUBPROCESS TESTS — End-to-end hook execution
// =====================================================================
describe('End-to-end subprocess execution', () => {
  test('outputs valid markdown with decisions, breadcrumbs, learnings', async () => {
    const db = createTestDb();
    seedDecisions(db, [{ decision: 'Use TypeScript', reasoning: 'Type safety', project: TEST_PROJECT }]);
    seedBreadcrumbs(db, [{ content: 'Auth module is fragile', importance: 8, project: TEST_PROJECT }]);
    seedLearnings(db, [{ problem: 'SQLite locking', solution: 'Use WAL mode', project: TEST_PROJECT }]);
    db.close();

    const { exitCode, stdout } = await runHookProcess();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('## Recall — Session Memory Context');
    expect(stdout).toContain('### Active Decisions');
    expect(stdout).toContain('Use TypeScript');
    expect(stdout).toContain('### Breadcrumbs');
    expect(stdout).toContain('Auth module is fragile');
    expect(stdout).toContain('### Recent Learnings');
    expect(stdout).toContain('SQLite locking');
    expect(stdout).toContain('**Recall is active.**');
  });

  test('subprocess does not hang or spawn child processes', async () => {
    createTestDb().close();

    const hookPath = join(import.meta.dir, '..', '..', 'hooks', 'SessionRecall.ts');
    const proc = Bun.spawn(['bun', 'run', hookPath], {
      env: {
        ...process.env,
        MEM_DB_PATH: dbPath,
        HOT_RECALL_PATH: hotRecallPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Race against a 5-second timeout
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000));
    const exited = proc.exited.then(() => 'exited' as const);
    const result = await Promise.race([timeout, exited]);

    if (result === 'timeout') {
      proc.kill(9);
      await proc.exited;
    }

    expect(result).toBe('exited');
    expect(proc.exitCode).toBe(0);
  });

  test('concurrent hook executions do not deadlock', async () => {
    const db = createTestDb();
    seedDecisions(db, [{ decision: 'Concurrent test' }]);
    db.close();

    // Launch 5 concurrent instances
    const promises = Array.from({ length: 5 }, () => runHookProcess());
    const results = await Promise.all(promises);

    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Recall');
    }
  });
});

// =====================================================================
// SAFETY: Verify no self-spawning or recursive behavior
// =====================================================================
describe('Safety: no recursive spawning', () => {
  test('hook script does not spawn child processes', async () => {
    createTestDb().close();

    const { stdout } = await runHookProcess();

    // Output should be just memory context, not multiple copies
    const headerCount = (stdout.match(/## Recall — Session Memory Context/g) || []).length;
    expect(headerCount).toBe(1);
  });

  test('hook does not read stdin (non-blocking)', async () => {
    createTestDb().close();

    const hookPath = join(import.meta.dir, '..', '..', 'hooks', 'SessionRecall.ts');
    const proc = Bun.spawn(['bun', 'run', hookPath], {
      env: {
        ...process.env,
        MEM_DB_PATH: dbPath,
        HOT_RECALL_PATH: hotRecallPath,
      },
      stdin: 'pipe', // Provide pipe but don't write to it
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Close stdin immediately — hook should not wait for it
    proc.stdin.end();

    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000));
    const exited = proc.exited.then(() => 'exited' as const);
    const result = await Promise.race([timeout, exited]);

    if (result === 'timeout') {
      proc.kill(9);
      await proc.exited;
    }

    expect(result).toBe('exited');
    expect(proc.exitCode).toBe(0);
  });
});
