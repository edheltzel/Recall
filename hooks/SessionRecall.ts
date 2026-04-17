#!/usr/bin/env bun
/**
 * SessionRecall.ts — Tiered memory load at session start (Recall v2)
 *
 * PURPOSE
 * Inject a compact, high-value memory bundle at every session start:
 *   L0 — Identity (user-authored, always on, small)
 *   L1 — Top-N records by importance, with reserved LoA slots (curated tier)
 *   L2 — On-demand recall via MCP tools (memory_recall, memory_search)
 *   L3 — On-demand deep search via MCP tools (memory_hybrid_search)
 *
 * Only L0 and L1 are injected. L2/L3 are documented in the preamble so the
 * agent knows where to look when it needs more than the bundle provides.
 *
 * GUARDRAILS
 * - Token budget is bounded (MAX_L1_CHARS). If L1 overflows, drop tail rows.
 * - LoA records get reserved slots in L1 so curated knowledge is never
 *   crowded out by a flood of high-importance breadcrumbs.
 * - Tie-break ordering across tables: loa > decisions > learnings > breadcrumbs.
 * - Graceful degrade: empty DB, missing identity file, read errors → never block session.
 *
 * TRIGGER: Claude Code SessionStart
 */

import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync } from 'child_process';

// ─── Budget constants (derived, not cargo-culted) ───────────────────
// MAX_L1_CHARS ≈ ~1,500-2,000 tokens at 4 chars/token — a working-set
// budget that leaves the session's context window mostly empty.
// Tune from observation; do not match MemPalace's 170-token figure
// blindly (it was measured against their corpus, not ours).
const MAX_L0_CHARS = 1200;
const MAX_L1_CHARS = 6000;
const MAX_TOTAL_CHARS = 8000;
const GIT_TIMEOUT_MS = 3000;

// L1 assembly knobs
const L1_TOTAL_SLOTS = 12;              // total L1 record count target
const L1_RESERVED_LOA_SLOTS = 4;        // ~30% reserved for the curated tier
const L1_LOA_FALLBACK_CAP = 6;          // if no high-importance non-LoA exist, pull more LoA

// ─── Path resolution ─────────────────────────────────────────────────
function getDbPath(): string {
  if (process.env.MEM_DB_PATH) return process.env.MEM_DB_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.claude', 'memory.db');
}

function getIdentityPath(): string | undefined {
  // Precedence: env override > project-local > global.
  // Project-local wins over global so per-project identity can differ.
  if (process.env.RECALL_IDENTITY_PATH) return process.env.RECALL_IDENTITY_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectLocal = join(process.cwd(), '.atlas-recall', 'identity.md');
  if (existsSync(projectLocal)) return projectLocal;
  const globalPath = join(home, '.claude', 'MEMORY', 'identity.md');
  if (existsSync(globalPath)) return globalPath;
  return undefined;
}

// ─── Project detection ──────────────────────────────────────────────
// Uses execFileSync (no shell) with a fixed argv — safe by construction.
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

// ─── SQLite direct reads (hooks are self-contained) ─────────────────
export function queryDb(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  try {
    const { Database } = require('bun:sqlite');
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
    const { Database } = require('bun:sqlite');
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return;
    const db = new Database(dbPath);
    db.prepare('PRAGMA journal_mode = WAL').run();
    db.prepare("DELETE FROM breadcrumbs WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
    db.close();
  } catch {
    // Non-fatal best-effort cleanup
  }
}

// ─── Column presence probe ──────────────────────────────────────────
// Gracefully handle older databases that haven't run the importance migration.
// If the column doesn't exist yet, fall back to creation-order ranking.
function hasImportanceColumn(table: string): boolean {
  try {
    const { Database } = require('bun:sqlite');
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return false;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    db.close();
    return rows.some(r => r.name === 'importance');
  } catch {
    return false;
  }
}

// ─── L0: Identity ────────────────────────────────────────────────────
export function buildL0(): string | undefined {
  const path = getIdentityPath();
  if (!path) return undefined;
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

// ─── L1: Importance-ranked records ──────────────────────────────────
interface L1Row {
  table: 'loa' | 'decisions' | 'learnings' | 'breadcrumbs';
  id: number;
  content: string;
  project: string | null;
  importance: number;
  created_at: string;
}

const TABLE_PRIORITY: Record<L1Row['table'], number> = {
  loa: 0,         // wins ties
  decisions: 1,
  learnings: 2,
  breadcrumbs: 3,
};

function fetchLoa(project: string | undefined, limit: number): L1Row[] {
  const hasImp = hasImportanceColumn('loa_entries');
  const orderBy = hasImp ? 'importance DESC, created_at DESC' : 'created_at DESC';
  const sql = project
    ? `SELECT id, title, description, fabric_extract, project,
              ${hasImp ? 'importance' : '8 AS importance'}, created_at
       FROM loa_entries WHERE project = ? ORDER BY ${orderBy} LIMIT ?`
    : `SELECT id, title, description, fabric_extract, project,
              ${hasImp ? 'importance' : '8 AS importance'}, created_at
       FROM loa_entries ORDER BY ${orderBy} LIMIT ?`;
  const params = project ? [project, limit] : [limit];
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
  const hasImp = hasImportanceColumn('decisions');
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
  const hasImp = hasImportanceColumn('learnings');
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

// L1 assembly: reserve LoA slots, fill remainder by importance desc.
// Tie-break: (importance DESC, table_priority, created_at DESC).
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

// ─── Assembly ────────────────────────────────────────────────────────
export function gatherContext(): string {
  sweepExpiredBreadcrumbs();

  const project = detectProject();
  const sections: string[] = [];

  sections.push('## Recall — Session Memory (tiered)');
  if (project) sections.push(`**Project:** ${project}`);
  sections.push('');

  // L0 — Identity
  const l0 = buildL0();
  if (l0) {
    sections.push('### L0 — Identity');
    sections.push(l0);
    sections.push('');
  }

  // L1 — Ranked memory
  const l1Rows = assembleL1(project);
  const l1Text = renderL1(l1Rows);
  if (l1Text) {
    sections.push(l1Text);
    sections.push('');
  }

  // Empty-state hint
  if (!l0 && l1Rows.length === 0) {
    sections.push('_No memory yet. Drop `identity.md` into `~/.claude/MEMORY/` or this project\'s `.atlas-recall/` to seed L0._');
    sections.push('_Record during this session with `memory_add`; search existing knowledge with `memory_search` or `memory_hybrid_search`._');
    sections.push('');
  }

  // L2/L3 pointer (no behavioral instructions — the agent knows these tools exist)
  sections.push('---');
  sections.push('_More memory available on demand — `memory_recall`, `memory_search`, `memory_hybrid_search` (L2/L3)._');

  let output = sections.join('\n');

  // Budget enforcement: L1 cap first, then total cap.
  if (l1Text.length > MAX_L1_CHARS) {
    // Trim L1 tail to fit budget; keep reserved LoA slots intact.
    const keepRows = Math.max(L1_RESERVED_LOA_SLOTS, Math.floor(l1Rows.length * (MAX_L1_CHARS / l1Text.length)));
    const trimmedL1 = renderL1(l1Rows.slice(0, keepRows));
    output = output.replace(l1Text, trimmedL1);
  }

  if (output.length > MAX_TOTAL_CHARS) {
    output = output.slice(0, MAX_TOTAL_CHARS) + '\n\n[truncated — query more via `memory_search`]';
  }

  return output;
}

// ─── Main ────────────────────────────────────────────────────────────
const isDirectExecution = process.argv[1]?.endsWith('SessionRecall.ts');
if (isDirectExecution) {
  try {
    console.log(gatherContext());
  } catch {
    console.log('## Recall — Memory unavailable this session\n_Use `memory_search` to query memory manually._');
  }
}
