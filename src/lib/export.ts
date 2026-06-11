// recall export — core export logic (issue #43).
//
// Pure(ish) building blocks for the export command: table row collection,
// manifest construction, and per-format renderers (JSON, Markdown, SQL dump).
// Everything here takes an open Database handle and plain data so it stays
// unit-testable (issue #44 phase 2 adds property tests over these functions).
//
// Provenance contract (ADR-0001, issue #42): JSON/Markdown exports carry an
// explicit `provenance` field for every row of a provenance-bearing table.
// Legacy NULL provenance is rendered as the literal string 'unknown' — never
// omitted, never guessed (matches the search/recent display contract).
//
// Bind-count note (see src/lib/chunk.ts): export reads bind a fixed number of
// parameters per statement — keyset pagination (`WHERE id > ? LIMIT ?`) — so
// bind counts never scale with selected rows and chunked() IN-lists are not
// needed. The shared SQLITE_SAFE_CHUNK_SIZE constant is reused as the batch
// size so large exports stream in bounded batches instead of one giant read.

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, extname, dirname, basename } from 'path';
import { SQLITE_SAFE_CHUNK_SIZE } from './chunk.js';
import { getMigrationVersion } from '../db/migrations.js';
import { VERSION } from '../version.js';

/** Durable memory tables included in app-level (JSON/Markdown/SQL) exports. */
export const EXPORT_TABLES = [
  'sessions',
  'messages',
  'decisions',
  'learnings',
  'breadcrumbs',
  'loa_entries',
] as const;
export type ExportTable = typeof EXPORT_TABLES[number];

/** Subset of EXPORT_TABLES carrying the provenance column (migration 8→9). */
export const PROVENANCE_TABLES = [
  'messages',
  'decisions',
  'learnings',
  'breadcrumbs',
  'loa_entries',
] as const;

export const EXPORT_FORMATS = ['json', 'markdown', 'sql', 'sqlite'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

export type ExportRow = Record<string, unknown>;
export type ExportData = Record<string, ExportRow[]>;

export interface ExportManifest {
  recall_version: string;
  created_at: string;
  schema_version: number;
  format: ExportFormat;
  tables: string[];
  counts: Record<string, number>;
  provenance_counts: Record<string, Record<string, number>>;
  includes_embeddings: boolean;
}

/** Default disaster-recovery backup directory (install layout, AGENTS.md). */
export function defaultBackupDir(): string {
  return join(homedir(), '.agents', 'Recall', 'backups');
}

/** UTC timestamp slug for export artifact filenames (YYYYMMDD-HHMMSS). */
export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Return `path` if free, otherwise the first `name-N.ext` variant that does
 * not exist. Used by --backup, which must never overwrite an existing file.
 */
export function resolveNonClobbering(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = join(dirname(path), basename(path, ext));
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find a non-clobbering name for ${path}`);
}

/**
 * Normalize a row for app-level export: provenance-bearing tables get an
 * explicit provenance field with NULL rendered as 'unknown'. Tables without
 * the column (sessions) are returned unchanged — no field is invented.
 */
export function toExportRow(table: string, row: ExportRow): ExportRow {
  if (!(PROVENANCE_TABLES as readonly string[]).includes(table)) return row;
  return { ...row, provenance: row.provenance ?? 'unknown' };
}

/**
 * Read every row of a durable table in bounded batches via keyset pagination.
 * Fixed two-parameter bind per statement regardless of table size.
 */
export function collectTableRows(
  db: Database,
  table: ExportTable,
  batchSize: number = SQLITE_SAFE_CHUNK_SIZE
): ExportRow[] {
  const stmt = db.prepare(`SELECT * FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`);
  const rows: ExportRow[] = [];
  let lastId = 0;
  for (;;) {
    const batch = stmt.all(lastId, batchSize) as ExportRow[];
    if (batch.length === 0) break;
    rows.push(...batch);
    lastId = batch[batch.length - 1].id as number;
  }
  return rows;
}

/** Collect all durable tables, with export-row normalization applied. */
export function collectExportData(db: Database): ExportData {
  const data: ExportData = {};
  for (const table of EXPORT_TABLES) {
    data[table] = collectTableRows(db, table).map(row => toExportRow(table, row));
  }
  return data;
}

/**
 * Per-table provenance histograms for the manifest. NULL is counted under the
 * explicit 'unknown' key, which is always present (even at zero) so consumers
 * never have to infer it.
 */
export function buildProvenanceCounts(db: Database): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const table of PROVENANCE_TABLES) {
    const rows = db.prepare(
      `SELECT COALESCE(provenance, 'unknown') AS p, COUNT(*) AS c FROM ${table} GROUP BY COALESCE(provenance, 'unknown')`
    ).all() as Array<{ p: string; c: number }>;
    const histogram: Record<string, number> = { unknown: 0 };
    for (const row of rows) histogram[row.p] = row.c;
    counts[table] = histogram;
  }
  return counts;
}

export function buildManifest(
  db: Database,
  format: ExportFormat,
  tables: string[],
  options: { includesEmbeddings: boolean; createdAt: Date }
): ExportManifest {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  }
  return {
    recall_version: VERSION,
    created_at: options.createdAt.toISOString(),
    schema_version: getMigrationVersion(db),
    format,
    tables,
    counts,
    provenance_counts: buildProvenanceCounts(db),
    includes_embeddings: options.includesEmbeddings,
  };
}

/**
 * Physical user-data tables present in the database file — what a SQLite
 * backup actually carries. Excludes SQLite internals, FTS virtual tables,
 * and their shadow tables (derived indexes, rebuildable).
 */
export function listPhysicalTables(db: Database): string[] {
  const rows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ name: string; sql: string | null }>;
  const virtual = new Set(
    rows.filter(r => /CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map(r => r.name)
  );
  return rows
    .filter(r => {
      if (virtual.has(r.name)) return false;
      for (const v of virtual) {
        if (r.name.startsWith(`${v}_`)) return false;
      }
      return true;
    })
    .map(r => r.name);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function renderJsonExport(manifest: ExportManifest, data: ExportData): string {
  return JSON.stringify({ manifest, tables: data }, null, 2) + '\n';
}

function markdownValue(value: unknown): string {
  if (value === null || value === undefined) return '_null_';
  const s = String(value);
  if (!s.includes('\n')) return s;
  // Multi-line values as an indented blockquote — safe for arbitrary content.
  return '\n' + s.split('\n').map(line => `  > ${line}`).join('\n');
}

export function renderMarkdownExport(manifest: ExportManifest, data: ExportData): string {
  const lines: string[] = [];
  lines.push('# Recall Memory Export');
  lines.push('');
  lines.push(`- **Recall version:** ${manifest.recall_version}`);
  lines.push(`- **Created:** ${manifest.created_at}`);
  lines.push(`- **Schema version:** ${manifest.schema_version}`);
  lines.push(`- **Tables:** ${manifest.tables.join(', ')}`);
  lines.push(`- **Embeddings included:** ${manifest.includes_embeddings ? 'yes' : 'no'}`);
  lines.push('');
  for (const table of manifest.tables) {
    const rows = data[table] ?? [];
    lines.push(`## ${table} (${rows.length} rows)`);
    lines.push('');
    for (const row of rows) {
      lines.push(`### ${table} #${row.id}`);
      lines.push('');
      for (const [key, value] of Object.entries(row)) {
        if (key === 'id') continue;
        lines.push(`- **${key}:** ${markdownValue(value)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** SQL-literal quoting for dump output. */
export function sqlQuote(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Textual SQL dump of the durable tables: CREATE TABLE statements from
 * sqlite_master plus one INSERT per row. Restorable into an empty database;
 * one-command restore is intentionally out of scope (issue #43).
 */
export function renderSqlDump(db: Database, manifest: ExportManifest): string {
  const lines: string[] = [];
  lines.push('-- Recall SQL export');
  lines.push(`-- recall_version: ${manifest.recall_version}`);
  lines.push(`-- created_at: ${manifest.created_at}`);
  lines.push(`-- schema_version: ${manifest.schema_version}`);
  lines.push(`-- tables: ${manifest.tables.join(', ')}`);
  lines.push('PRAGMA foreign_keys=OFF;');
  lines.push('BEGIN TRANSACTION;');
  for (const table of manifest.tables) {
    const master = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(table) as { sql: string | null } | undefined;
    if (master?.sql) {
      lines.push(`${master.sql};`);
    }
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(c => c.name);
    const columnList = columns.map(c => `"${c}"`).join(', ');
    for (const row of collectTableRows(db, table as ExportTable)) {
      const values = columns.map(c => sqlQuote(row[c])).join(', ');
      lines.push(`INSERT INTO "${table}" (${columnList}) VALUES (${values});`);
    }
  }
  lines.push('COMMIT;');
  return lines.join('\n') + '\n';
}
