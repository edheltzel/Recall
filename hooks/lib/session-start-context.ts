/**
 * Shared L0/L1 session-start assembler.
 *
 * One renderer for every host inject path:
 *   - `recall start` (public CLI)
 *   - Claude SessionStart (`hooks/RecallStart.ts` is a thin wrapper)
 *   - Codex SessionStart (`src/commands/host-hook.ts` renderContext)
 *
 * Published char caps (≈ 4 chars/token). Tune from observation; do not
 * cargo-cult other products' token figures.
 *
 * Hooks are self-contained: this file must not import from `src/`.
 */

import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { execFileSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { resolveDbPath as getDbPath } from './db-path';
import { resolveIdentityPath } from './identity-path';

export const MAX_L0_CHARS = 1200;
export const MAX_L1_CHARS = 6000;
export const MAX_TOTAL_CHARS = 8000;
export const GIT_TIMEOUT_MS = 3000;

export const L1_TOTAL_SLOTS = 12;
export const L1_RESERVED_LOA_SLOTS = 4;
export const L1_LOA_FALLBACK_CAP = 6;

export const MEMORY_UNAVAILABLE =
  '## Recall — Memory unavailable this session\n_Use `memory_search` to query memory manually._';

export function detectProject(): string | undefined {
  const cwd = process.cwd();
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    const match = remote.match(/\/([^/]+?)(\.git)?$/);
    if (match) return match[1];
  } catch {
    // Not a git repo or timeout — fall through to basename
  }
  return basename(cwd);
}

type SqlParam = string | number | bigint | boolean | null;

export function queryDb(sql: string, params: SqlParam[] = []): Record<string, unknown>[] {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    db.exec('PRAGMA journal_mode = WAL');
    const rows = db.prepare(sql).all(...params);
    db.close();
    return rows as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function sweepExpiredBreadcrumbs(): void {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return;
    const db = new Database(dbPath);
    try {
      db.prepare('PRAGMA journal_mode = WAL').run();
      db.prepare('PRAGMA busy_timeout = 5000').run();
      const sweep = db.transaction(() => {
        const expiredWhere = `expires_at IS NOT NULL AND expires_at < datetime('now')`;
        const tables = new Set(
          (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
            .map(row => row.name)
        );
        if (tables.has('embeddings')) {
          const removed = db.prepare(`
            DELETE FROM embeddings
            WHERE source_table = 'breadcrumbs'
              AND source_id IN (
                SELECT id FROM breadcrumbs
                WHERE ${expiredWhere}
              )
          `).run().changes;
          if (removed > 0 && tables.has('schema_meta') && !db.prepare(
            `SELECT 1 FROM schema_meta WHERE key = 'vec_index_dirty'`
          ).get()) {
            db.prepare(`
              INSERT INTO schema_meta (key, value) VALUES
                ('vec_index_dirty', '1'), ('vec_index_generation', '1')
              ON CONFLICT(key) DO UPDATE SET value = CASE
                WHEN key = 'vec_index_generation'
                  THEN CAST(schema_meta.value AS INTEGER) + 1
                ELSE '1'
              END
            `).run();
          }
        }
        db.prepare(`DELETE FROM breadcrumbs WHERE ${expiredWhere}`).run();
      });
      sweep.immediate();
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal best-effort cleanup
  }
}

function tableColumns(table: string): Set<string> {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return new Set();
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    db.close();
    return new Set(rows.map(r => r.name));
  } catch {
    return new Set();
  }
}

export function buildL0(): string | undefined {
  const path = resolveIdentityPath({ project: 'existing' });
  try {
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return undefined;
    const trimmed = content.length > MAX_L0_CHARS
      ? content.slice(0, MAX_L0_CHARS) + '\n[identity truncated — edit ' + path + ' to shorten]'
      : content;
    return trimmed;
  } catch {
    return undefined;
  }
}

export interface L1Row {
  table: 'loa' | 'decisions' | 'learnings' | 'breadcrumbs';
  id: number;
  content: string;
  project: string | null;
  importance: number;
  created_at: string;
}

const TABLE_PRIORITY: Record<L1Row['table'], number> = {
  loa: 0,
  decisions: 1,
  learnings: 2,
  breadcrumbs: 3,
};

function fetchLoa(project: string | undefined, limit: number): L1Row[] {
  const columns = tableColumns('loa_entries');
  const hasImp = columns.has('importance');
  const orderBy = hasImp ? 'importance DESC, created_at DESC' : 'created_at DESC';
  const impSelect = hasImp ? 'importance' : '8 AS importance';
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  if (project) {
    conditions.push('project = ?');
    params.push(project);
  }
  if (columns.has('tags')) {
    conditions.push(`(tags IS NULL OR tags NOT LIKE 'automatic-capture,%')`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);
  const sql = `SELECT id, title, description, fabric_extract, project,
              ${impSelect}, created_at
       FROM loa_entries ${where} ORDER BY ${orderBy} LIMIT ?`;
  const rows = queryDb(sql, params);
  return rows.map(r => ({
    table: 'loa' as const,
    id: r.id as number,
    content: `${r.title}${r.description ? ` — ${r.description}` : ''}`,
    project: (r.project as string | null) ?? null,
    importance: (r.importance as number) ?? 8,
    created_at: (r.created_at as string) ?? '',
  }));
}

function fetchDecisions(project: string | undefined, limit: number): L1Row[] {
  const hasImp = tableColumns('decisions').has('importance');
  const orderBy = hasImp ? 'importance DESC, created_at DESC' : 'created_at DESC';
  const base = `SELECT id, decision, reasoning, project,
                       ${hasImp ? 'importance' : '5 AS importance'}, created_at
                FROM decisions WHERE status = 'active'
                AND (confidence IS NULL OR confidence != 'low')`;
  const sql = project
    ? `${base} AND project = ? ORDER BY ${orderBy} LIMIT ?`
    : `${base} ORDER BY ${orderBy} LIMIT ?`;
  const params = project ? [project, limit] : [limit];
  const rows = queryDb(sql, params);
  return rows.map(r => ({
    table: 'decisions' as const,
    id: r.id as number,
    content: `${r.decision}${r.reasoning ? ` — ${r.reasoning}` : ''}`,
    project: (r.project as string | null) ?? null,
    importance: (r.importance as number) ?? 5,
    created_at: (r.created_at as string) ?? '',
  }));
}

function fetchLearnings(project: string | undefined, limit: number): L1Row[] {
  const hasImp = tableColumns('learnings').has('importance');
  const orderBy = hasImp ? 'importance DESC, created_at DESC' : 'created_at DESC';
  const sql = project
    ? `SELECT id, problem, solution, project,
              ${hasImp ? 'importance' : '5 AS importance'}, created_at
       FROM learnings WHERE project = ? ORDER BY ${orderBy} LIMIT ?`
    : `SELECT id, problem, solution, project,
              ${hasImp ? 'importance' : '5 AS importance'}, created_at
       FROM learnings ORDER BY ${orderBy} LIMIT ?`;
  const params = project ? [project, limit] : [limit];
  const rows = queryDb(sql, params);
  return rows.map(r => ({
    table: 'learnings' as const,
    id: r.id as number,
    content: `${r.problem}${r.solution ? ` → ${r.solution}` : ''}`,
    project: (r.project as string | null) ?? null,
    importance: (r.importance as number) ?? 5,
    created_at: (r.created_at as string) ?? '',
  }));
}

function fetchBreadcrumbs(project: string | undefined, limit: number): L1Row[] {
  const sql = project
    ? `SELECT id, content, project, importance, created_at
       FROM breadcrumbs WHERE project = ?
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY importance DESC, created_at DESC LIMIT ?`
    : `SELECT id, content, project, importance, created_at
       FROM breadcrumbs WHERE (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY importance DESC, created_at DESC LIMIT ?`;
  const params = project ? [project, limit] : [limit];
  const rows = queryDb(sql, params);
  return rows.map(r => ({
    table: 'breadcrumbs' as const,
    id: r.id as number,
    content: String(r.content ?? ''),
    project: (r.project as string | null) ?? null,
    importance: (r.importance as number) ?? 5,
    created_at: (r.created_at as string) ?? '',
  }));
}

export function assembleL1(project: string | undefined): L1Row[] {
  const loaPool = fetchLoa(project, L1_LOA_FALLBACK_CAP);
  const decPool = fetchDecisions(project, L1_TOTAL_SLOTS);
  const learnPool = fetchLearnings(project, L1_TOTAL_SLOTS);
  const breadPool = fetchBreadcrumbs(project, L1_TOTAL_SLOTS);

  const reservedLoa = loaPool.slice(0, L1_RESERVED_LOA_SLOTS);
  const reservedIds = new Set(reservedLoa.map(r => `loa:${r.id}`));

  const rest = [
    ...loaPool.slice(L1_RESERVED_LOA_SLOTS),
    ...decPool,
    ...learnPool,
    ...breadPool,
  ]
    .filter(r => !reservedIds.has(`${r.table}:${r.id}`))
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      const prioDiff = TABLE_PRIORITY[a.table] - TABLE_PRIORITY[b.table];
      if (prioDiff !== 0) return prioDiff;
      return b.created_at.localeCompare(a.created_at);
    });

  const remaining = Math.max(0, L1_TOTAL_SLOTS - reservedLoa.length);
  return [...reservedLoa, ...rest.slice(0, remaining)];
}

function renderL1(rows: L1Row[]): string {
  if (rows.length === 0) return '';
  const lines: string[] = ['### L1 — Top Memory (ranked by importance)'];
  for (const r of rows) {
    const date = r.created_at?.split('T')[0] || '';
    const tag = r.project ? `[${r.project}]` : '';
    const imp = r.importance != null ? `★${r.importance}` : '';
    const preview = r.content.length > 220 ? r.content.slice(0, 220) + '…' : r.content;
    lines.push(`- **[${r.table}#${r.id}]** ${tag} ${imp} ${date}: ${preview}`);
  }
  return lines.join('\n');
}

export type SessionStartFormat = 'markdown' | 'cursor';

export function wrapCursorSessionStart(context: string): string {
  return JSON.stringify({ additional_context: context });
}

/**
 * Assemble the L0/L1 bundle. Empty DB + missing identity.md fail-soft to a
 * short degrade line (never throw, never block session start).
 *
 * Char budget drops L1 tail first; reserved LoA slots stay at the front of
 * `assembleL1`, so a cap trim never evicts them before later rows.
 */
export function gatherContext(): string {
  try {
    sweepExpiredBreadcrumbs();

    const project = detectProject();
    const l0 = buildL0();
    const l1Rows = assembleL1(project);
    const l1Text = renderL1(l1Rows);

    if (!l0 && l1Rows.length === 0) return MEMORY_UNAVAILABLE;

    const sections: string[] = [];
    sections.push('## Recall — Session Memory (tiered)');
    if (project) sections.push(`**Project:** ${project}`);
    sections.push('');

    if (l0) {
      sections.push('### L0 — Identity');
      sections.push(l0);
      sections.push('');
    }

    if (l1Text) {
      sections.push(l1Text);
      sections.push('');
    }

    sections.push('---');
    sections.push('_More memory available on demand — `memory_recall`, `memory_search`, `memory_hybrid_search` (L2/L3)._');

    let output = sections.join('\n');

    if (l1Text.length > MAX_L1_CHARS) {
      const keepRows = Math.max(L1_RESERVED_LOA_SLOTS, Math.floor(l1Rows.length * (MAX_L1_CHARS / l1Text.length)));
      const trimmedL1 = renderL1(l1Rows.slice(0, keepRows));
      output = output.replace(l1Text, trimmedL1);
    }

    if (output.length > MAX_TOTAL_CHARS) {
      output = output.slice(0, MAX_TOTAL_CHARS) + '\n\n[truncated — query more via `memory_search`]';
    }

    return output;
  } catch {
    return MEMORY_UNAVAILABLE;
  }
}

export function renderSessionStart(format: SessionStartFormat = 'markdown'): string {
  const context = gatherContext();
  return format === 'cursor' ? wrapCursorSessionStart(context) : context;
}
