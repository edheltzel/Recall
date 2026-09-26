// Suite B internals — direct measurement helpers.
//
// We do not import from hooks/RecallStart.ts directly because the hook is
// self-contained and writes paths from $HOME (which we don't want to override
// during a benchmark run). Instead we re-implement the same SQL, scoped to a
// single project, and report the bundle's character count.
//
// Keeping this implementation parallel to the hook is intentional: if the
// hook's L1 assembly drifts, the benchmark drifts with it only when someone
// updates this file too. That's a feature, not a bug — it forces an explicit
// decision when changing what L1 means.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const L1_TOTAL_SLOTS = 12;
const L1_RESERVED_LOA_SLOTS = 4;
const L1_LOA_FALLBACK_CAP = 6;

const V1_FLAT_BUDGET = 8000;          // MAX_OUTPUT_CHARS in the original hook
const V1_DECISIONS_LIMIT = 7;          // 5 project + 3 global, dedup'd to 7
const V1_BREADCRUMBS_LIMIT = 5;
const V1_LEARNINGS_LIMIT = 3;

function getDbPath(): string {
  if (process.env.RECALL_DB_PATH) return process.env.RECALL_DB_PATH;
  if (process.env.MEM_DB_PATH) return process.env.MEM_DB_PATH;
  return join(homedir(), '.agents', 'Recall', 'recall.db');
}

function openReadonly(): Database | null {
  const path = getDbPath();
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.prepare('PRAGMA journal_mode = WAL').run();
  } catch {
    // older WAL setup may complain on a readonly handle — ignore
  }
  return db;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some(r => r.name === column);
  } catch {
    return false;
  }
}

interface Row {
  table: 'loa' | 'decisions' | 'learnings' | 'breadcrumbs';
  importance: number;
  rendered: string;
}

const TABLE_PRIORITY: Record<Row['table'], number> = {
  loa: 0, decisions: 1, learnings: 2, breadcrumbs: 3,
};

// ── v2 — tiered L0 + L1 ──────────────────────────────────────────────
// Mirrors hooks/RecallStart.ts assembleL1. We render the same way the hook
// renders so the char count reflects the actual on-the-wire bundle.

export interface V2Snapshot {
  l0Chars: number;
  l1Chars: number;
  totalChars: number;
  l1RecordCount: number;
  l1LoaCount: number;
}

export function runSuiteB_v2Tiered(project?: string): V2Snapshot {
  // L0 — read identity.md the same way the hook does
  const identityPath = resolveIdentityPath();
  const l0 = identityPath ? readFile(identityPath) : '';
  const l0Chars = l0.length;

  const db = openReadonly();
  if (!db) {
    return { l0Chars, l1Chars: 0, totalChars: l0Chars, l1RecordCount: 0, l1LoaCount: 0 };
  }

  try {
    const rows = collectV2Rows(db, project);
    const l1Rendered = renderV2L1(rows);
    return {
      l0Chars,
      l1Chars: l1Rendered.length,
      totalChars: l0Chars + l1Rendered.length,
      l1RecordCount: rows.length,
      l1LoaCount: rows.filter(r => r.table === 'loa').length,
    };
  } finally {
    db.close();
  }
}

function collectV2Rows(db: Database, project?: string): Row[] {
  const rows: Row[] = [];

  const loaHasImp = hasColumn(db, 'loa_entries', 'importance');
  const decHasImp = hasColumn(db, 'decisions', 'importance');
  const learnHasImp = hasColumn(db, 'learnings', 'importance');

  // LoA pool
  const loaSql = project
    ? `SELECT id, title, description, ${loaHasImp ? 'importance' : '8 AS importance'} FROM loa_entries WHERE project = ? ORDER BY ${loaHasImp ? 'importance DESC,' : ''} created_at DESC LIMIT ?`
    : `SELECT id, title, description, ${loaHasImp ? 'importance' : '8 AS importance'} FROM loa_entries ORDER BY ${loaHasImp ? 'importance DESC,' : ''} created_at DESC LIMIT ?`;
  const loaParams = project ? [project, L1_LOA_FALLBACK_CAP] : [L1_LOA_FALLBACK_CAP];
  const loaRows = db.prepare(loaSql).all(...loaParams) as Array<{ id: number; title: string; description: string | null; importance: number }>;

  for (const r of loaRows) {
    rows.push({
      table: 'loa',
      importance: r.importance ?? 8,
      rendered: `- **[loa#${r.id}]** ★${r.importance ?? 8}: ${r.title}${r.description ? ` — ${r.description}` : ''}`,
    });
  }

  // Decisions
  const decSql = project
    ? `SELECT id, decision, reasoning, ${decHasImp ? 'importance' : '5 AS importance'} FROM decisions WHERE status='active' AND project=? ORDER BY ${decHasImp ? 'importance DESC,' : ''} created_at DESC LIMIT ?`
    : `SELECT id, decision, reasoning, ${decHasImp ? 'importance' : '5 AS importance'} FROM decisions WHERE status='active' ORDER BY ${decHasImp ? 'importance DESC,' : ''} created_at DESC LIMIT ?`;
  const decParams = project ? [project, L1_TOTAL_SLOTS] : [L1_TOTAL_SLOTS];
  const decRows = db.prepare(decSql).all(...decParams) as Array<{ id: number; decision: string; reasoning: string | null; importance: number }>;
  for (const r of decRows) {
    rows.push({
      table: 'decisions',
      importance: r.importance ?? 5,
      rendered: `- **[decisions#${r.id}]** ★${r.importance ?? 5}: ${r.decision}${r.reasoning ? ` — ${r.reasoning}` : ''}`,
    });
  }

  // Learnings
  const learnSql = project
    ? `SELECT id, problem, solution, ${learnHasImp ? 'importance' : '5 AS importance'} FROM learnings WHERE project=? ORDER BY ${learnHasImp ? 'importance DESC,' : ''} created_at DESC LIMIT ?`
    : `SELECT id, problem, solution, ${learnHasImp ? 'importance' : '5 AS importance'} FROM learnings ORDER BY ${learnHasImp ? 'importance DESC,' : ''} created_at DESC LIMIT ?`;
  const learnParams = project ? [project, L1_TOTAL_SLOTS] : [L1_TOTAL_SLOTS];
  const learnRows = db.prepare(learnSql).all(...learnParams) as Array<{ id: number; problem: string; solution: string | null; importance: number }>;
  for (const r of learnRows) {
    rows.push({
      table: 'learnings',
      importance: r.importance ?? 5,
      rendered: `- **[learnings#${r.id}]** ★${r.importance ?? 5}: ${r.problem}${r.solution ? ` → ${r.solution}` : ''}`,
    });
  }

  // Breadcrumbs
  const breadSql = project
    ? `SELECT id, content, importance FROM breadcrumbs WHERE project=? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY importance DESC, created_at DESC LIMIT ?`
    : `SELECT id, content, importance FROM breadcrumbs WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY importance DESC, created_at DESC LIMIT ?`;
  const breadParams = project ? [project, L1_TOTAL_SLOTS] : [L1_TOTAL_SLOTS];
  const breadRows = db.prepare(breadSql).all(...breadParams) as Array<{ id: number; content: string; importance: number }>;
  for (const r of breadRows) {
    rows.push({
      table: 'breadcrumbs',
      importance: r.importance ?? 5,
      rendered: `- **[breadcrumbs#${r.id}]** ★${r.importance ?? 5}: ${r.content}`,
    });
  }

  // L1 assembly: reserve LoA slots, fill the rest by importance.
  const loaSubset = rows.filter(r => r.table === 'loa').slice(0, L1_RESERVED_LOA_SLOTS);
  const reservedKeys = new Set(loaSubset.map(r => r.rendered));
  const rest = rows
    .filter(r => !reservedKeys.has(r.rendered))
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return TABLE_PRIORITY[a.table] - TABLE_PRIORITY[b.table];
    });

  const remaining = Math.max(0, L1_TOTAL_SLOTS - loaSubset.length);
  return [...loaSubset, ...rest.slice(0, remaining)];
}

function renderV2L1(rows: Row[]): string {
  if (rows.length === 0) return '';
  return ['### L1 — Top Memory (ranked by importance)', ...rows.map(r => r.rendered)].join('\n');
}

function resolveIdentityPath(): string | null {
  if (process.env.RECALL_IDENTITY_PATH) return process.env.RECALL_IDENTITY_PATH;
  const projectLocal = join(process.cwd(), '.atlas-recall', 'identity.md');
  if (existsSync(projectLocal)) return projectLocal;
  const globalPath = join(homedir(), '.claude', 'MEMORY', 'identity.md');
  if (existsSync(globalPath)) return globalPath;
  return null;
}

function readFile(path: string): string {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

// ── v1 — flat blob baseline (simulated) ──────────────────────────────
// Reconstructs the pre-tiered RecallStart output from the same DB so the
// comparison is fair. Char count only; the actual content fidelity isn't
// what we're measuring here.

export interface V1Snapshot {
  totalChars: number;
}

export function runSuiteB_v1Baseline(project?: string): V1Snapshot {
  const db = openReadonly();
  if (!db) return { totalChars: 0 };

  try {
    const sections: string[] = ['## Recall — Session Memory Context', ''];

    // Decisions section
    const decisions = db.prepare(
      project
        ? `SELECT id, decision, reasoning, project, created_at FROM decisions WHERE project = ? AND status = 'active' AND (confidence IS NULL OR confidence != 'low') ORDER BY created_at DESC LIMIT ?`
        : `SELECT id, decision, reasoning, project, created_at FROM decisions WHERE status = 'active' AND (confidence IS NULL OR confidence != 'low') ORDER BY created_at DESC LIMIT ?`
    ).all(...(project ? [project, V1_DECISIONS_LIMIT] : [V1_DECISIONS_LIMIT])) as Array<{ id: number; decision: string; reasoning: string | null; project: string | null; created_at: string }>;

    if (decisions.length > 0) {
      sections.push('### Active Decisions');
      for (const d of decisions) {
        sections.push(`- **#${d.id}** ${d.project ? `[${d.project}]` : ''}: ${d.decision}${d.reasoning ? ` — ${d.reasoning}` : ''}`);
      }
      sections.push('');
    }

    // Breadcrumbs section
    const crumbs = db.prepare(
      project
        ? `SELECT id, content, importance, project FROM breadcrumbs WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY importance DESC, created_at DESC LIMIT ?`
        : `SELECT id, content, importance, project FROM breadcrumbs WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY importance DESC, created_at DESC LIMIT ?`
    ).all(...(project ? [project, V1_BREADCRUMBS_LIMIT] : [V1_BREADCRUMBS_LIMIT])) as Array<{ id: number; content: string; importance: number; project: string | null }>;

    if (crumbs.length > 0) {
      sections.push('### Breadcrumbs');
      for (const b of crumbs) {
        const imp = b.importance > 5 ? ` (importance: ${b.importance}/10)` : '';
        sections.push(`- **#${b.id}** ${b.project ? `[${b.project}]` : ''}${imp}: ${b.content}`);
      }
      sections.push('');
    }

    // Learnings section
    const learnings = db.prepare(
      project
        ? `SELECT id, problem, solution, project FROM learnings WHERE project = ? ORDER BY created_at DESC LIMIT ?`
        : `SELECT id, problem, solution, project FROM learnings ORDER BY created_at DESC LIMIT ?`
    ).all(...(project ? [project, V1_LEARNINGS_LIMIT] : [V1_LEARNINGS_LIMIT])) as Array<{ id: number; problem: string; solution: string | null; project: string | null }>;

    if (learnings.length > 0) {
      sections.push('### Recent Learnings');
      for (const l of learnings) {
        sections.push(`- **#${l.id}** ${l.project ? `[${l.project}]` : ''}: ${l.problem}${l.solution ? ` → ${l.solution}` : ''}`);
      }
      sections.push('');
    }

    sections.push('---');
    sections.push('**Recall is active.** Before checking git log for context, search memory first.');

    let output = sections.join('\n');
    if (output.length > V1_FLAT_BUDGET) {
      output = output.slice(0, V1_FLAT_BUDGET) + '\n\n[Output truncated]';
    }
    return { totalChars: output.length };
  } finally {
    db.close();
  }
}
