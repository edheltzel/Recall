// Import TELOS from the TELOS directory into the telos table

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getDb } from '../db/connection.js';
import { claudePaths } from '../hosts/claude.js';

const CLAUDE_PATHS = claudePaths(homedir());
const TELOS_DIR = join(CLAUDE_PATHS.skills, 'PAI', 'USER', 'TELOS');
const TELOS_MTIME_PATH = join(CLAUDE_PATHS.memory, '.telos_last_import');

// Map filenames to telos types (schema CHECK constraint)
const TYPE_MAP: Record<string, string> = {
  GOALS: 'goal',
  PROBLEMS: 'problem',
  MISSION: 'mission',
  CHALLENGES: 'challenge',
  STRATEGIES: 'strategy',
  PROJECTS: 'project',
  TELOS: 'identity',
};

interface TelosEntry {
  code: string;
  type: string;
  category: string | null;
  title: string;
  content: string;
  sourceFile: string;
}

/**
 * Parse all .md files in the TELOS directory into entries.
 * Each file becomes one entry. Code = uppercase filename without extension.
 * Title = first # heading or filename.
 */
function parseTelosDirectory(dirPath: string): TelosEntry[] {
  if (!existsSync(dirPath)) {
    console.log(`Directory not found: ${dirPath}`);
    return [];
  }

  const files = readdirSync(dirPath).filter(f => f.endsWith('.md'));
  const entries: TelosEntry[] = [];

  for (const file of files) {
    const filePath = join(dirPath, file);
    const code = basename(file, '.md').toUpperCase();
    const content = readFileSync(filePath, 'utf-8').trim();

    if (!content) continue;

    // Extract title from first # heading, or use filename
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : code;

    const type = TYPE_MAP[code] || 'other';

    entries.push({
      code,
      type,
      category: null,
      title,
      content,
      sourceFile: filePath,
    });
  }

  return entries;
}

/**
 * Get the most recent mtime from all files in the TELOS directory
 */
function getTelosDirMtime(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  const files = readdirSync(dirPath).filter(f => f.endsWith('.md'));
  let maxMtime = 0;
  for (const file of files) {
    const mtime = statSync(join(dirPath, file)).mtimeMs;
    if (mtime > maxMtime) maxMtime = mtime;
  }
  return maxMtime;
}

/**
 * Get the last import timestamp
 */
function getLastImportTime(): number {
  try {
    return parseInt(readFileSync(TELOS_MTIME_PATH, 'utf-8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Save the current import timestamp
 */
function saveImportTime(): void {
  mkdirSync(CLAUDE_PATHS.memory, { recursive: true });
  writeFileSync(TELOS_MTIME_PATH, Date.now().toString());
}

/**
 * Check if TELOS files have changed since last import
 */
export function telosNeedsImport(): boolean {
  const dirMtime = getTelosDirMtime(TELOS_DIR);
  const lastImport = getLastImportTime();
  return dirMtime > lastImport;
}

/**
 * Check if a TELOS entry already exists
 */
function telosExists(code: string): boolean {
  const db = getDb();
  const result = db.prepare('SELECT 1 FROM telos WHERE code = ?').get(code);
  return !!result;
}

/**
 * Insert a TELOS entry
 */
function insertTelos(entry: TelosEntry): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO telos (code, type, category, title, content, parent_code, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    entry.code,
    entry.type,
    entry.category,
    entry.title,
    entry.content,
    null,
    entry.sourceFile
  );
  return result.lastInsertRowid as number;
}

/**
 * Update a TELOS entry
 */
function updateTelos(entry: TelosEntry): void {
  const db = getDb();
  db.prepare(`
    UPDATE telos
    SET type = ?, category = ?, title = ?, content = ?, source_file = ?, updated_at = CURRENT_TIMESTAMP
    WHERE code = ?
  `).run(entry.type, entry.category, entry.title, entry.content, entry.sourceFile, entry.code);
}

export interface ImportTelosOptions {
  dryRun?: boolean;
  verbose?: boolean;
  yes?: boolean;
  update?: boolean;
}

export function runImportTelos(options: ImportTelosOptions): void {
  console.log('Import TELOS Framework');
  console.log('======================\n');

  console.log(`Source: ${TELOS_DIR}`);

  if (!existsSync(TELOS_DIR)) {
    console.error(`\nError: TELOS directory not found at ${TELOS_DIR}`);
    return;
  }

  const entries = parseTelosDirectory(TELOS_DIR);
  console.log(`Found ${entries.length} files\n`);

  let newCount = 0;
  let updateCount = 0;
  let skipCount = 0;

  for (const entry of entries) {
    const exists = telosExists(entry.code);

    if (exists && !options.update) {
      skipCount++;
      if (options.verbose) {
        console.log(`[SKIP] ${entry.code}: ${entry.title.slice(0, 50)}`);
      }
    } else if (exists && options.update) {
      updateCount++;
      if (options.verbose) {
        console.log(`[UPDATE] ${entry.code}: ${entry.title.slice(0, 50)}`);
      }
    } else {
      newCount++;
      if (options.verbose) {
        console.log(`[NEW] ${entry.code}: ${entry.title.slice(0, 50)}`);
      }
    }
  }

  console.log(`Summary:`);
  console.log(`  New:      ${newCount}`);
  console.log(`  Update:   ${updateCount}`);
  console.log(`  Existing: ${skipCount}\n`);

  if (newCount === 0 && updateCount === 0) {
    console.log('Nothing to import or update.');
    saveImportTime();
    return;
  }

  if (options.dryRun) {
    console.log('[DRY RUN] Would import/update the above entries.');
    return;
  }

  if (!options.yes) {
    console.log('Run with --yes to confirm import, or --dry-run to preview.');
    console.log('Use --update to update existing entries.');
    return;
  }

  // Import/update
  console.log('Importing...\n');
  let imported = 0;
  let updated = 0;
  let errors = 0;

  for (const entry of entries) {
    try {
      const exists = telosExists(entry.code);

      if (exists && options.update) {
        updateTelos(entry);
        updated++;
        if (options.verbose) {
          console.log(`  ✓ Updated ${entry.code}: ${entry.title.slice(0, 50)}`);
        }
      } else if (!exists) {
        const id = insertTelos(entry);
        imported++;
        if (options.verbose) {
          console.log(`  ✓ Imported #${id} ${entry.code}: ${entry.title.slice(0, 50)}`);
        }
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ Error with ${entry.code}: ${err}`);
    }
  }

  saveImportTime();

  console.log(`\nImport Complete`);
  console.log(`===============`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipCount}`);
  console.log(`  Errors:   ${errors}`);
}

// List TELOS entries
export function runTelosList(options: { type?: string; limit?: number }): void {
  const db = getDb();
  const limit = options.limit || 50;

  let sql = 'SELECT code, type, category, title FROM telos';
  const params: (string | number)[] = [];

  if (options.type) {
    sql += ' WHERE type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY code LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    code: string;
    type: string;
    category: string | null;
    title: string;
  }>;

  if (rows.length === 0) {
    console.log('No TELOS entries found. Run `recall telos import --yes` to import.');
    return;
  }

  console.log(`TELOS Entries (${rows.length}):\n`);

  // Group by type
  const grouped: Record<string, typeof rows> = {};
  for (const row of rows) {
    if (!grouped[row.type]) grouped[row.type] = [];
    grouped[row.type].push(row);
  }

  for (const [type, entries] of Object.entries(grouped)) {
    console.log(`## ${type.toUpperCase()} (${entries.length})`);
    for (const entry of entries) {
      const cat = entry.category ? ` [${entry.category}]` : '';
      console.log(`  ${entry.code}: ${entry.title}${cat}`);
    }
    console.log('');
  }
}

// Show a specific TELOS entry
export function runTelosShow(code: string): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM telos WHERE code = ? COLLATE NOCASE').get(code) as
    | {
        id: number;
        code: string;
        type: string;
        category: string | null;
        title: string;
        content: string;
        parent_code: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    console.log(`TELOS entry '${code}' not found.`);
    return;
  }

  console.log(`# ${row.code}: ${row.title}\n`);
  console.log(`**Type:** ${row.type}`);
  if (row.category) console.log(`**Category:** ${row.category}`);
  console.log(`**Updated:** ${row.updated_at}\n`);
  console.log('---\n');
  console.log(row.content);
}

// Search TELOS
export function runTelosSearch(query: string, options: { type?: string; limit?: number }): void {
  const db = getDb();
  const limit = options.limit || 10;

  let sql = `
    SELECT t.code, t.type, t.category, t.title, SUBSTR(t.content, 1, 200) as preview, f.rank
    FROM telos_fts f
    JOIN telos t ON t.id = f.rowid
    WHERE telos_fts MATCH ?
  `;
  const params: (string | number)[] = [query];

  if (options.type) {
    sql += ' AND t.type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY f.rank LIMIT ?';
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      code: string;
      type: string;
      category: string | null;
      title: string;
      preview: string;
      rank: number;
    }>;

    if (rows.length === 0) {
      console.log(`No TELOS entries found for: "${query}"`);
      return;
    }

    console.log(`Found ${rows.length} TELOS entries for "${query}":\n`);

    for (const row of rows) {
      const cat = row.category ? ` [${row.category}]` : '';
      console.log(`**${row.code}** (${row.type}${cat}): ${row.title}`);
      console.log(`  ${row.preview.replace(/\n/g, ' ').slice(0, 150)}...`);
      console.log('');
    }
  } catch {
    console.log(`Search error. Try a simpler query.`);
  }
}
