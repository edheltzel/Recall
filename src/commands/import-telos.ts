// Import TELOS sections from identity file into the telos table

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from '../db/connection.js';

const TELOS_PATH = join(homedir(), '.claude', 'TELOS', 'IDENTITY.md');

interface TelosSection {
  code: string;
  type: string;
  category: string | null;
  title: string;
  content: string;
  parentCode: string | null;
}

/**
 * Parse TELOS markdown file into sections
 */
function parseTelosFile(filePath: string): TelosSection[] {
  if (!existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return [];
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const sections: TelosSection[] = [];

  let currentSection: Partial<TelosSection> | null = null;
  let currentContent: string[] = [];
  let currentCategory: string | null = null;
  let currentType: string | null = null;

  const typeMap: Record<string, string> = {
    'Identity': 'identity',
    'Problems': 'problem',
    'Problem': 'problem',
    'Mission': 'mission',
    'Goals': 'goal',
    'Goal': 'goal',
    'Challenges': 'challenge',
    'Challenge': 'challenge',
    'Strategies': 'strategy',
    'Strategy': 'strategy',
    'Projects': 'project',
    'Skills': 'skill',
    'Aspirations': 'aspiration',
    'Metrics': 'metric',
  };

  const categoryMap: Record<string, string> = {
    'Operational Goals': 'operational',
    'Capability Goals': 'capability',
    'Strategic Goals': 'strategic',
    'Technical Challenges': 'technical',
    'Architectural Challenges': 'architectural',
    'Philosophical Challenges': 'philosophical',
    'Memory & Persistence Strategies': 'memory',
    'Cost & Performance Strategies': 'cost',
    'Integration Strategies': 'integration',
    'Learning & Growth Strategies': 'learning',
    'Collaboration Strategies': 'collaboration',
    'Near-Term': 'near-term',
    'Medium-Term': 'medium-term',
    'Long-Term': 'long-term',
    'Philosophical Aspirations': 'philosophical',
  };

  function saveCurrentSection() {
    if (currentSection && currentSection.code && currentSection.title) {
      currentSection.content = currentContent.join('\n').trim();
      if (currentSection.content) {
        sections.push(currentSection as TelosSection);
      }
    }
    currentContent = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match ## Section headers (top-level types)
    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      saveCurrentSection();
      currentSection = null;
      const headerText = h2Match[1].trim();

      // Check if this is a type header
      for (const [key, type] of Object.entries(typeMap)) {
        if (headerText.includes(key)) {
          currentType = type;
          break;
        }
      }

      // Identity section is special - it's the whole section
      if (headerText === 'Identity') {
        currentSection = {
          code: 'IDENTITY',
          type: 'identity',
          category: null,
          title: 'Identity',
          parentCode: null
        };
      }
      continue;
    }

    // Match ### Category headers or P/M sections
    const h3Match = line.match(/^### (.+)$/);
    if (h3Match) {
      saveCurrentSection();
      const headerText = h3Match[1].trim();

      // Check for category headers
      for (const [key, cat] of Object.entries(categoryMap)) {
        if (headerText.includes(key)) {
          currentCategory = cat;
          break;
        }
      }

      // Check for P1, M1 pattern
      const codeMatch = headerText.match(/^([PMG])\s*(\d+):\s*(.+)$/);
      if (codeMatch) {
        const prefix = codeMatch[1];
        const num = codeMatch[2];
        const title = codeMatch[3].trim();
        const typeFromPrefix: Record<string, string> = { 'P': 'problem', 'M': 'mission', 'G': 'goal' };

        currentSection = {
          code: `${prefix}${num}`,
          type: typeFromPrefix[prefix] || currentType || 'other',
          category: currentCategory,
          title: title,
          parentCode: null
        };
      }
      continue;
    }

    // Match #### Subsections (G1, C1, S1, etc.)
    const h4Match = line.match(/^#### (.+)$/);
    if (h4Match) {
      saveCurrentSection();
      const headerText = h4Match[1].trim();

      // Check for G1, C1, S1 patterns
      const codeMatch = headerText.match(/^([GCS])\s*(\d+):\s*(.+)$/);
      if (codeMatch) {
        const prefix = codeMatch[1];
        const num = codeMatch[2];
        const title = codeMatch[3].trim();
        const typeFromPrefix: Record<string, string> = { 'G': 'goal', 'C': 'challenge', 'S': 'strategy' };

        currentSection = {
          code: `${prefix}${num}`,
          type: typeFromPrefix[prefix] || currentType || 'other',
          category: currentCategory,
          title: title,
          parentCode: null
        };
      } else {
        // Numbered sections like "1. PF (pi_forever)"
        const numberedMatch = headerText.match(/^(\d+)\.\s*(.+)$/);
        if (numberedMatch && currentType) {
          const num = numberedMatch[1];
          const title = numberedMatch[2].trim();

          // Generate code based on type
          const prefixMap: Record<string, string> = {
            'project': 'PRJ',
            'skill': 'SKL',
            'aspiration': 'ASP',
            'metric': 'MET'
          };
          const prefix = prefixMap[currentType] || 'SEC';

          currentSection = {
            code: `${prefix}${num}`,
            type: currentType,
            category: currentCategory,
            title: title,
            parentCode: null
          };
        }
      }
      continue;
    }

    // Accumulate content for current section
    if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  saveCurrentSection();

  return sections;
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
function insertTelos(section: TelosSection): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO telos (code, type, category, title, content, parent_code, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    section.code,
    section.type,
    section.category,
    section.title,
    section.content,
    section.parentCode,
    TELOS_PATH
  );
  return result.lastInsertRowid as number;
}

/**
 * Update a TELOS entry
 */
function updateTelos(section: TelosSection): void {
  const db = getDb();
  db.prepare(`
    UPDATE telos
    SET type = ?, category = ?, title = ?, content = ?, parent_code = ?, updated_at = CURRENT_TIMESTAMP
    WHERE code = ?
  `).run(section.type, section.category, section.title, section.content, section.parentCode, section.code);
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

  console.log(`Source: ${TELOS_PATH}`);

  if (!existsSync(TELOS_PATH)) {
    console.error(`\nError: TELOS file not found at ${TELOS_PATH}`);
    return;
  }

  const sections = parseTelosFile(TELOS_PATH);
  console.log(`Parsed ${sections.length} sections\n`);

  let newCount = 0;
  let updateCount = 0;
  let skipCount = 0;

  // Categorize sections
  for (const section of sections) {
    const exists = telosExists(section.code);

    if (exists && !options.update) {
      skipCount++;
      if (options.verbose) {
        console.log(`[SKIP] ${section.code}: ${section.title.slice(0, 40)}...`);
      }
    } else if (exists && options.update) {
      updateCount++;
      if (options.verbose) {
        console.log(`[UPDATE] ${section.code}: ${section.title.slice(0, 40)}...`);
      }
    } else {
      newCount++;
      if (options.verbose) {
        console.log(`[NEW] ${section.code}: ${section.title.slice(0, 40)}...`);
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`  New sections:    ${newCount}`);
  console.log(`  To update:       ${updateCount}`);
  console.log(`  Already exists:  ${skipCount}\n`);

  if (newCount === 0 && updateCount === 0) {
    console.log('Nothing to import or update.');
    return;
  }

  if (options.dryRun) {
    console.log('[DRY RUN] Would import/update the above sections.');
    return;
  }

  if (!options.yes) {
    console.log('Run with --yes to confirm import, or --dry-run to preview.');
    console.log('Use --update to update existing entries.');
    return;
  }

  // Import/update sections
  console.log('Importing...\n');
  let imported = 0;
  let updated = 0;
  let errors = 0;

  for (const section of sections) {
    try {
      const exists = telosExists(section.code);

      if (exists && options.update) {
        updateTelos(section);
        updated++;
        if (options.verbose) {
          console.log(`✓ Updated ${section.code}: ${section.title.slice(0, 40)}...`);
        }
      } else if (!exists) {
        const id = insertTelos(section);
        imported++;
        if (options.verbose) {
          console.log(`✓ Imported #${id} ${section.code}: ${section.title.slice(0, 40)}...`);
        }
      }
    } catch (err) {
      errors++;
      console.error(`✗ Error with ${section.code}: ${err}`);
    }
  }

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
    console.log('No TELOS entries found.');
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
  const row = db.prepare('SELECT * FROM telos WHERE code = ? COLLATE NOCASE').get(code) as {
    id: number;
    code: string;
    type: string;
    category: string | null;
    title: string;
    content: string;
    parent_code: string | null;
    created_at: string;
    updated_at: string;
  } | undefined;

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
