// recall export — portable and disaster-recovery exports (issue #43).
//
// Formats:
// - json / markdown: app-level export of the durable memory tables with an
//   explicit provenance field per provenance-bearing row (NULL → 'unknown').
//   Embeddings are excluded.
// - sql: textual SQL dump (schema + INSERTs) of the durable tables.
// - sqlite: database backup via VACUUM INTO — full DB including embeddings
//   and internal tables. Binary, so it always requires --output.
//
// Output contract:
// - no --output: export data goes to stdout, manifest summary to stderr —
//   stdout stays clean for piping.
// - --output <file>: data written to the file, manifest summary to stdout.
// - --output <dir>: artifact plus manifest.json written into the directory,
//   manifest summary to stdout. Directory exports always write manifest.json.
// - --backup: timestamped SQL dump into ~/.agents/Recall/backups/ (created if
//   needed), never overwrites an existing file, prints the output path.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Database } from 'bun:sqlite';
import { getDb } from '../db/connection.js';
import {
  EXPORT_FORMATS,
  EXPORT_TABLES,
  buildManifest,
  collectExportData,
  defaultBackupDir,
  listPhysicalTables,
  renderJsonExport,
  renderMarkdownExport,
  renderSqlDump,
  resolveNonClobbering,
  timestampSlug,
  type ExportFormat,
  type ExportManifest,
} from '../lib/export.js';

export interface ExportOptions {
  format?: string;
  output?: string;
  backup?: boolean;
  /** Test seam — the CLI always uses defaultBackupDir(). */
  backupDir?: string;
  /** Test seam — the CLI always uses the current time. */
  now?: Date;
}

const ARTIFACT_EXT: Record<ExportFormat, string> = {
  json: 'json',
  markdown: 'md',
  sql: 'sql',
  sqlite: 'db',
};

function manifestSummary(manifest: ExportManifest, paths: string[]): string {
  const lines: string[] = [];
  lines.push(`Recall export — format: ${manifest.format}`);
  for (const p of paths) lines.push(`  Output: ${p}`);
  lines.push(`  Recall ${manifest.recall_version} | schema v${manifest.schema_version} | ${manifest.created_at}`);
  lines.push(`  Rows: ${manifest.tables.map(t => `${t}=${manifest.counts[t]}`).join(', ')}`);
  const provenance = Object.entries(manifest.provenance_counts)
    .map(([table, hist]) => `${table} { ${Object.entries(hist).map(([k, v]) => `${k}=${v}`).join(', ')} }`)
    .join('; ');
  lines.push(`  Provenance: ${provenance}`);
  lines.push(`  Embeddings included: ${manifest.includes_embeddings ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function renderAppExport(db: Database, format: 'json' | 'markdown', createdAt: Date): { content: string; manifest: ExportManifest } {
  const manifest = buildManifest(db, format, [...EXPORT_TABLES], { includesEmbeddings: false, createdAt });
  const data = collectExportData(db);
  const content = format === 'json'
    ? renderJsonExport(manifest, data)
    : renderMarkdownExport(manifest, data);
  return { content, manifest };
}

function renderSqlExport(db: Database, createdAt: Date): { content: string; manifest: ExportManifest } {
  const manifest = buildManifest(db, 'sql', [...EXPORT_TABLES], { includesEmbeddings: false, createdAt });
  return { content: renderSqlDump(db, manifest), manifest };
}

function runBackup(options: ExportOptions): void {
  if (options.output) {
    throw new Error('--backup writes to the backup directory; do not combine it with --output');
  }
  if (options.format && options.format !== 'sql') {
    throw new Error(`--backup always writes a SQL dump; do not combine it with --format ${options.format}`);
  }
  const db = getDb();
  const now = options.now ?? new Date();
  const dir = options.backupDir ?? defaultBackupDir();
  mkdirSync(dir, { recursive: true });
  const target = resolveNonClobbering(join(dir, `recall-backup-${timestampSlug(now)}.sql`));
  const { content, manifest } = renderSqlExport(db, now);
  writeFileSync(target, content);
  console.log(manifestSummary(manifest, [target]));
}

export function runExport(options: ExportOptions): void {
  if (options.backup) {
    runBackup(options);
    return;
  }

  const format = (options.format ?? 'json') as ExportFormat;
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`Unknown format '${options.format}'. Supported: ${EXPORT_FORMATS.join(', ')}`);
  }

  const db = getDb();
  const now = options.now ?? new Date();

  // Resolve output mode: none (stdout), file, or directory.
  const output = options.output ? resolve(options.output) : undefined;
  const isDir = options.output !== undefined
    && (options.output.endsWith('/') || (existsSync(output!) && statSync(output!).isDirectory()));

  if (format === 'sqlite') {
    if (!output) {
      throw new Error('--format sqlite produces a binary database backup and requires --output <file-or-dir>');
    }
    // Manifest first — VACUUM INTO copies the live DB, so counts match it.
    const manifest = buildManifest(db, 'sqlite', listPhysicalTables(db), { includesEmbeddings: true, createdAt: now });
    let target: string;
    if (isDir) {
      mkdirSync(output, { recursive: true });
      target = resolveNonClobbering(join(output, `recall-export-${timestampSlug(now)}.db`));
      writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    } else {
      if (existsSync(output)) {
        throw new Error(`Refusing to overwrite existing database backup at ${output}`);
      }
      mkdirSync(dirname(output), { recursive: true });
      target = output;
    }
    db.prepare('VACUUM INTO ?').run(target);
    console.log(manifestSummary(manifest, isDir ? [target, join(output, 'manifest.json')] : [target]));
    return;
  }

  const { content, manifest } = format === 'sql'
    ? renderSqlExport(db, now)
    : renderAppExport(db, format, now);

  if (!output) {
    // Piping contract: stdout carries only the export data.
    process.stdout.write(content);
    console.error(manifestSummary(manifest, []));
    return;
  }

  if (isDir) {
    mkdirSync(output, { recursive: true });
    const artifact = resolveNonClobbering(join(output, `recall-export-${timestampSlug(now)}.${ARTIFACT_EXT[format]}`));
    const manifestPath = join(output, 'manifest.json');
    writeFileSync(artifact, content);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(manifestSummary(manifest, [artifact, manifestPath]));
    return;
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content);
  console.log(manifestSummary(manifest, [output]));
}
