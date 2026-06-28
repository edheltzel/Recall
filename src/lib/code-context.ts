// Memory↔code join surface (design §5) — Recall's unique angle.
//
// The native code KG (code_files/code_nodes) and the memory FTS tables
// (decisions_fts/learnings_fts) live in the same recall.db, so we can fuse
// them in one SQL JOIN that no external code-intelligence tool can run:
// "for this source file, which decisions/learnings were made about its
// symbols?". The join key is `project` (design §5) — both code tables and the
// memory tables carry it. There is no hard FK between code and memory (a future
// explicit link is deferred per §5/Q3); correlation is `project` scope + FTS.
//
// FTS5 injection safety (design §9-C5): a symbol name is fed to MATCH as a
// QUOTED PHRASE, never raw. A symbol legitimately named `OR`, `NEAR`, `AND`,
// etc. would otherwise be parsed as FTS5 query syntax. Wrapping it in double
// quotes makes FTS5 treat it as a literal phrase. Binding alone is NOT enough —
// FTS5 parses a bound string as a query — so the quoting is the actual guard.

import type { Database } from 'bun:sqlite';

const DEFAULT_LIMIT = 20;

export interface FileDecisionMatch {
  id: number;
  decision: string;
  created_at: string;
  /** Comma-separated symbol names from the file that the decision text mentions. */
  symbols: string;
}

export interface FileLearningMatch {
  id: number;
  problem: string;
  solution: string | null;
  created_at: string;
  symbols: string;
}

export interface FileCodeContext {
  project: string;
  path: string;
  /** Symbols defined in the file (the synthetic module node is excluded). */
  symbolCount: number;
  decisions: FileDecisionMatch[];
  learnings: FileLearningMatch[];
}

export interface SymbolDiscussion {
  name: string;
  qualified_name: string;
  kind: string;
  path: string;
  start_line: number;
  decisions: Array<{ id: number; decision: string; created_at: string }>;
  learnings: Array<{ id: number; problem: string; created_at: string }>;
}

export interface FileContextOptions {
  project: string;
  path: string;
  limit?: number;
}

export interface SymbolSearchOptions {
  project: string;
  query: string;
  limit?: number;
}

/**
 * Build the FTS5 MATCH operand for a symbol name as a quoted phrase (§9-C5).
 * Embedded double quotes are doubled per FTS5 phrase-escaping rules; in
 * practice TS/JS identifiers cannot contain a quote, but the escape keeps the
 * guard total regardless of where the name came from.
 */
function ftsPhrase(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * §5 query 1 — decisions/learnings whose text references a symbol defined in a
 * given file. The correlated MATCH operand is `'"' || n.name || '"'`: the
 * symbol name comes from the joined column and is quoted in SQL so it is parsed
 * as a literal phrase, never FTS5 syntax (§9-C5). The synthetic `module` node
 * (whose name is the file's basename) is excluded so we match real symbols, not
 * the filename.
 */
export function codeContextForFile(db: Database, options: FileContextOptions): FileCodeContext {
  const { project, path } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const symbolCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM code_nodes AS n
         JOIN code_files AS cf ON cf.id = n.file_id
         WHERE cf.project = ? AND cf.path = ? AND n.kind != 'module'`
      )
      .get(project, path) as { c: number }
  ).c;

  const decisions = db
    .prepare(
      `SELECT d.id AS id, d.decision AS decision, d.created_at AS created_at,
              GROUP_CONCAT(DISTINCT n.name) AS symbols
       FROM code_files AS cf
       JOIN code_nodes AS n ON n.file_id = cf.id AND n.kind != 'module'
       JOIN decisions_fts AS f ON f.decisions_fts MATCH ('"' || n.name || '"')
       JOIN decisions AS d ON d.id = f.rowid
       WHERE cf.project = ? AND cf.path = ? AND d.project = ?
       GROUP BY d.id
       ORDER BY d.created_at DESC
       LIMIT ?`
    )
    .all(project, path, project, limit) as FileDecisionMatch[];

  const learnings = db
    .prepare(
      `SELECT l.id AS id, l.problem AS problem, l.solution AS solution, l.created_at AS created_at,
              GROUP_CONCAT(DISTINCT n.name) AS symbols
       FROM code_files AS cf
       JOIN code_nodes AS n ON n.file_id = cf.id AND n.kind != 'module'
       JOIN learnings_fts AS f ON f.learnings_fts MATCH ('"' || n.name || '"')
       JOIN learnings AS l ON l.id = f.rowid
       WHERE cf.project = ? AND cf.path = ? AND l.project = ?
       GROUP BY l.id
       ORDER BY l.created_at DESC
       LIMIT ?`
    )
    .all(project, path, project, limit) as FileLearningMatch[];

  return { project, path, symbolCount, decisions, learnings };
}

/**
 * §5 query 2 — symbol search fused with where each symbol was discussed. The
 * user query is bound as a normal FTS parameter; the per-symbol discussion
 * lookup quotes the symbol name (§9-C5) so symbol names never inject syntax.
 */
export function symbolSearchWithDiscussion(db: Database, options: SymbolSearchOptions): SymbolDiscussion[] {
  const { project, query } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const symbols = db
    .prepare(
      `SELECT n.name AS name, n.qualified_name AS qualified_name, n.kind AS kind,
              cf.path AS path, n.start_line AS start_line
       FROM code_nodes_fts AS nf
       JOIN code_nodes AS n ON n.id = nf.rowid
       JOIN code_files AS cf ON cf.id = n.file_id
       WHERE nf.code_nodes_fts MATCH ? AND n.project = ?
       ORDER BY nf.rank
       LIMIT ?`
    )
    .all(query, project, limit) as Array<{
    name: string;
    qualified_name: string;
    kind: string;
    path: string;
    start_line: number;
  }>;

  const decisionsFor = db.prepare(
    `SELECT d.id AS id, d.decision AS decision, d.created_at AS created_at
     FROM decisions_fts AS f
     JOIN decisions AS d ON d.id = f.rowid
     WHERE f.decisions_fts MATCH ? AND d.project = ?
     ORDER BY d.created_at DESC
     LIMIT ?`
  );
  const learningsFor = db.prepare(
    `SELECT l.id AS id, l.problem AS problem, l.created_at AS created_at
     FROM learnings_fts AS f
     JOIN learnings AS l ON l.id = f.rowid
     WHERE f.learnings_fts MATCH ? AND l.project = ?
     ORDER BY l.created_at DESC
     LIMIT ?`
  );

  return symbols.map((s) => {
    const phrase = ftsPhrase(s.name);
    return {
      ...s,
      decisions: decisionsFor.all(phrase, project, limit) as SymbolDiscussion['decisions'],
      learnings: learningsFor.all(phrase, project, limit) as SymbolDiscussion['learnings'],
    };
  });
}
