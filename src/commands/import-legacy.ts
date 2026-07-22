// Import legacy DISTILLED.md extracts into LoA entries

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from '../db/connection.js';
import { createLoaEntry } from '../lib/memory.js';
import { scrub } from '../lib/write-safety.js';
import { detectThreats, summarizeThreats } from '../lib/threat-detect.js';
import { claudePaths } from '../hosts/claude.js';

const DEFAULT_MEMORY_DIR = claudePaths(homedir()).memory;

interface LegacyExtract {
  date: string;
  project: string;
  content: string;
  title: string;
}

/**
 * Parse DISTILLED.md into individual extracts
 */
function parseDistilledFile(filePath: string): LegacyExtract[] {
  if (!existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return [];
  }

  const content = readFileSync(filePath, 'utf-8');
  const extracts: LegacyExtract[] = [];

  // Match pattern: ## Extracted: DATE | PROJECT
  const extractRegex = /## Extracted:\s*([0-9-]+)\s*\|\s*([^\n]+)\n([\s\S]*?)(?=\n---\n## Extracted:|\n---\s*$|$)/g;

  let match;
  while ((match = extractRegex.exec(content)) !== null) {
    const date = match[1].trim();
    const project = match[2].trim();
    let extractContent = match[3].trim();

    // Remove trailing --- if present
    extractContent = extractContent.replace(/\n---\s*$/, '').trim();

    if (!extractContent) continue;

    // Generate title from content
    let title = `Legacy extract from ${project}`;

    // Try to extract SESSION name (old format)
    const sessionMatch = extractContent.match(/SESSION:\s*([^\n]+)/);
    if (sessionMatch) {
      title = sessionMatch[1].trim();
    }

    // Or try ONE SENTENCE SUMMARY (HOT_RECALL format)
    const summaryMatch = extractContent.match(/ONE SENTENCE SUMMARY\s*\n([^\n]+)/i);
    if (summaryMatch) {
      title = summaryMatch[1].trim();
    }

    extracts.push({
      date,
      project,
      content: extractContent,
      title
    });
  }

  return extracts;
}

/**
 * Check if a legacy extract already exists (by title and date)
 */
function extractExists(title: string, date: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    SELECT 1 FROM loa_entries
    WHERE title = ? AND DATE(created_at) = ?
  `).get(title, date);
  return !!result;
}

export interface ImportLegacyOptions {
  dryRun?: boolean;
  verbose?: boolean;
  yes?: boolean;
  source?: 'distilled' | 'hot_recall' | 'all';
  /** Test seam — defaults to ~/.claude/MEMORY (matches RecallExtract.ts). */
  memoryDir?: string;
}

export function runImportLegacy(options: ImportLegacyOptions): void {
  console.log('Import Legacy Memory');
  console.log('====================\n');

  const memoryDir = options.memoryDir ?? DEFAULT_MEMORY_DIR;
  const distilledPath = join(memoryDir, 'DISTILLED.md');
  const hotRecallPath = join(memoryDir, 'HOT_RECALL.md');

  const sources: string[] = [];
  if (options.source === 'distilled' || options.source === 'all' || !options.source) {
    sources.push(distilledPath);
  }
  if (options.source === 'hot_recall' || options.source === 'all') {
    sources.push(hotRecallPath);
  }

  let totalExtracts: LegacyExtract[] = [];
  let newCount = 0;
  let skipCount = 0;

  for (const source of sources) {
    console.log(`Parsing: ${source}`);
    const extracts = parseDistilledFile(source);
    console.log(`  Found ${extracts.length} extracts\n`);
    totalExtracts = totalExtracts.concat(extracts);
  }

  console.log(`Total extracts found: ${totalExtracts.length}\n`);

  // Defense-in-depth (#157): scrub secrets + invisible unicode from imported
  // content once, at the trust boundary, BEFORE the dedup check and the insert.
  // The legacy archive predates the write-safety scrub, so dirty content could
  // otherwise be amplified straight into the DB. Scrubbing here (not just at
  // createLoaEntry) keeps extractExists and the insert keyed on the SAME
  // scrubbed title — a secret-bearing title can't slip the dedup and re-import.
  // All three persisted fields (title, content, project) are scrubbed: project
  // comes from the raw "## Extracted: DATE | PROJECT" header and lands in
  // loa_entries.project, so it is just as much an amplifier as the body.
  // No-op on clean content, so behavior is preserved for the common case.
  for (const extract of totalExtracts) {
    extract.title = scrub(extract.title).text;
    extract.content = scrub(extract.content).text;
    extract.project = scrub(extract.project).text;
  }

  // #156 detection layer — DETECT-AND-SURFACE ONLY (Ed's ruling): it never
  // mutates or blocks. Scan the scrubbed fields and surface any injection/exfil
  // or anonymous-high-entropy flags as a non-fatal warning; the imported content
  // is stored byte-identical.
  for (const extract of totalExtracts) {
    const findings = [
      ...detectThreats(extract.title),
      ...detectThreats(extract.content),
      ...detectThreats(extract.project),
    ];
    if (findings.length > 0) {
      console.log(`[WARN] threat-detect: ${summarizeThreats(findings)} in "${extract.title.slice(0, 50)}" — surfaced, content stored unchanged`);
    }
  }

  // Check for duplicates
  for (const extract of totalExtracts) {
    if (extractExists(extract.title, extract.date)) {
      skipCount++;
      if (options.verbose) {
        console.log(`[SKIP] ${extract.date} | ${extract.title.slice(0, 50)}...`);
      }
    } else {
      newCount++;
      if (options.verbose) {
        console.log(`[NEW]  ${extract.date} | ${extract.title.slice(0, 50)}...`);
      }
    }
  }

  console.log(`\nNew extracts to import: ${newCount}`);
  console.log(`Already exists (skip):  ${skipCount}\n`);

  if (newCount === 0) {
    console.log('Nothing new to import.');
    return;
  }

  if (options.dryRun) {
    console.log('[DRY RUN] Would import the above extracts.');
    return;
  }

  if (!options.yes) {
    console.log('Run with --yes to confirm import, or --dry-run to preview.');
    return;
  }

  // Import new extracts
  console.log('Importing...\n');
  let imported = 0;
  let errors = 0;

  for (const extract of totalExtracts) {
    if (extractExists(extract.title, extract.date)) {
      continue;
    }

    try {
      const loaId = createLoaEntry({
        title: extract.title,
        fabric_extract: extract.content,
        project: extract.project,
        // Note: No message range since these are legacy extracts
        message_range_start: undefined,
        message_range_end: undefined,
        message_count: undefined,
        tags: 'legacy,imported',
        // DISTILLED.md / HOT_RECALL.md content is prior extraction output —
        // the record stays honest as extracted (ADR-0001).
        provenance: 'extracted'
      });

      // Update the created_at to match the original date
      const db = getDb();
      db.prepare(`UPDATE loa_entries SET created_at = ? WHERE id = ?`)
        .run(`${extract.date} 00:00:00`, loaId);

      imported++;

      if (options.verbose) {
        console.log(`✓ LoA #${loaId}: ${extract.title.slice(0, 50)}...`);
      }
    } catch (err) {
      errors++;
      console.error(`✗ Error importing ${extract.title}: ${err}`);
    }
  }

  console.log(`\nImport Complete`);
  console.log(`===============`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped:  ${skipCount}`);
  console.log(`  Errors:   ${errors}`);
}
