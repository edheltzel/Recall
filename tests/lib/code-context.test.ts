import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { indexCode } from '../../src/lib/code-indexer.js';
import { codeContextForFile, symbolSearchWithDiscussion } from '../../src/lib/code-context.js';
import { CREATE_TABLES, CREATE_FTS, CREATE_FTS_TRIGGERS } from '../../src/db/schema.js';

// Production schema (tables + FTS5 + sync triggers) — exec'd verbatim so the
// join is tested against the real decisions_fts/learnings_fts/code_nodes_fts,
// not a hand-rolled approximation. All FTS columns exist in the base tables, so
// no migrations are needed for these objects.
const CODE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_code_nodes_project_qn ON code_nodes(project, qualified_name);
CREATE INDEX IF NOT EXISTS idx_code_edges_unresolved ON code_edges(dst_hint) WHERE dst_id IS NULL;
`;

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(CREATE_TABLES);
  db.exec(CREATE_FTS);
  db.exec(CREATE_FTS_TRIGGERS);
  db.exec(CODE_INDEXES);
  return db;
}

function addDecision(db: Database, project: string, decision: string, createdAt: string): void {
  db.prepare('INSERT INTO decisions (project, decision, created_at, status) VALUES (?, ?, ?, \'active\')').run(
    project,
    decision,
    createdAt
  );
}

function addLearning(db: Database, project: string, problem: string, solution: string, createdAt: string): void {
  db.prepare('INSERT INTO learnings (project, problem, solution, created_at) VALUES (?, ?, ?, ?)').run(
    project,
    problem,
    solution,
    createdAt
  );
}

// A source file with: a normal function, a class+method, an adversarially named
// symbol (`OR` — a bare FTS5 boolean operator), and a private helper.
const WIDGET_SRC = `
export function parseConfig() { return load(); }
export class WidgetFactory {
  build() { return 1; }
}
export function OR() { return 1; }
function load() { return 2; }
`;

const OTHER_SRC = `
export function unrelated() { return 1; }
`;

describe('code-context memory↔code join (§5)', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  async function seed(): Promise<Database> {
    root = mkdtempSync(join(tmpdir(), 'recall-code-context-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'widget.ts'), WIDGET_SRC);
    writeFileSync(join(root, 'src', 'other.ts'), OTHER_SRC);

    const db = createDb();
    await indexCode({ db, root, target: join(root, 'src'), project: 'fixture' });

    // Memories that DO reference widget.ts symbols.
    addDecision(db, 'fixture', 'Chose to memoize parseConfig for faster startup', '2026-01-03T00:00:00Z');
    addDecision(db, 'fixture', 'Refactored OR to short-circuit early and avoid extra work', '2026-01-02T00:00:00Z');
    addLearning(db, 'fixture', 'WidgetFactory leaked file handles under load', 'pool them', '2026-01-01T00:00:00Z');
    // Reference to a symbol in OTHER file — must NOT surface for widget.ts.
    addDecision(db, 'fixture', 'Renamed the unrelated helper in the other module', '2026-01-04T00:00:00Z');
    // Same symbol word, DIFFERENT project — project scoping must exclude it.
    addDecision(db, 'elsewhere', 'parseConfig tuning in a different repo', '2026-01-05T00:00:00Z');
    return db;
  }

  test('surfaces decisions/learnings that mention a file\'s symbols, project-scoped', async () => {
    const db = await seed();
    const ctx = codeContextForFile(db, { project: 'fixture', path: 'src/widget.ts' });

    expect(ctx.symbolCount).toBeGreaterThan(0);

    const decisionTexts = ctx.decisions.map((d) => d.decision);
    expect(decisionTexts).toContain('Chose to memoize parseConfig for faster startup');
    expect(decisionTexts).toContain('Refactored OR to short-circuit early and avoid extra work');
    // Negative controls: other-file symbol + other-project must be absent.
    expect(decisionTexts).not.toContain('Renamed the unrelated helper in the other module');
    expect(decisionTexts).not.toContain('parseConfig tuning in a different repo');

    // The matched-symbol provenance is reported (why the record surfaced).
    const parseHit = ctx.decisions.find((d) => d.decision.includes('memoize'));
    expect(parseHit?.symbols.split(',')).toContain('parseConfig');

    const learningProblems = ctx.learnings.map((l) => l.problem);
    expect(learningProblems).toContain('WidgetFactory leaked file handles under load');
  });

  test('the other file gets ITS symbol matches, not widget.ts\'s', async () => {
    const db = await seed();
    const ctx = codeContextForFile(db, { project: 'fixture', path: 'src/other.ts' });
    const decisionTexts = ctx.decisions.map((d) => d.decision);
    expect(decisionTexts).toContain('Renamed the unrelated helper in the other module');
    expect(decisionTexts).not.toContain('Chose to memoize parseConfig for faster startup');
  });

  test('adversarial symbol name (OR) is quoted — no FTS5 injection (§9-C5)', async () => {
    const db = await seed();

    // The guard is load-bearing: the SAME join with the symbol name fed RAW to
    // MATCH (no quoting) is an FTS5 syntax error on a symbol named `OR`.
    const rawUnsafe = () =>
      db
        .prepare(
          `SELECT d.id
           FROM code_files AS cf
           JOIN code_nodes AS n ON n.file_id = cf.id AND n.kind != 'module'
           JOIN decisions_fts AS f ON f.decisions_fts MATCH n.name
           JOIN decisions AS d ON d.id = f.rowid
           WHERE cf.project = ? AND cf.path = ? AND d.project = ?`
        )
        .all('fixture', 'src/widget.ts', 'fixture');
    expect(rawUnsafe).toThrow();

    // Our quoted implementation does NOT throw and finds the OR decision.
    const ctx = codeContextForFile(db, { project: 'fixture', path: 'src/widget.ts' });
    const orHit = ctx.decisions.find((d) => d.decision.includes('short-circuit'));
    expect(orHit).toBeDefined();
    expect(orHit?.symbols.split(',')).toContain('OR');
  });

  test('symbol search fused with where it was discussed (§5 query 2)', async () => {
    const db = await seed();

    const results = symbolSearchWithDiscussion(db, { project: 'fixture', query: 'parseConfig' });
    const parse = results.find((s) => s.name === 'parseConfig');
    expect(parse).toBeDefined();
    expect(parse?.path).toBe('src/widget.ts');
    expect(parse?.decisions.map((d) => d.decision)).toContain('Chose to memoize parseConfig for faster startup');

    // Adversarial symbol on the fused path: searching the OR symbol (as a phrase)
    // then looking up its discussion must stay injection-safe and find D2.
    const orResults = symbolSearchWithDiscussion(db, { project: 'fixture', query: '"OR"' });
    const orSym = orResults.find((s) => s.name === 'OR');
    expect(orSym).toBeDefined();
    expect(orSym?.decisions.map((d) => d.decision)).toContain(
      'Refactored OR to short-circuit early and avoid extra work'
    );
  });

  test('a file with no indexed symbols returns an empty context', async () => {
    const db = await seed();
    const ctx = codeContextForFile(db, { project: 'fixture', path: 'src/does-not-exist.ts' });
    expect(ctx.symbolCount).toBe(0);
    expect(ctx.decisions).toHaveLength(0);
    expect(ctx.learnings).toHaveLength(0);
  });
});
