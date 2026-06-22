// recall search command

import { search, bumpAccess, SEARCH_TABLES, type SearchTable } from '../lib/memory.js';
import { formatProvenanceTag } from './provenance-display.js';

interface SearchOptions {
  project?: string;
  table?: string;
  biasType?: string;
  limit?: number;
  showProvenance?: boolean;
  includeDuplicates?: boolean;
}

export function runSearch(query: string, options: SearchOptions): void {
  if (options.biasType && !SEARCH_TABLES.includes(options.biasType as SearchTable)) {
    console.error(
      `Invalid --bias-type "${options.biasType}". Valid types: ${SEARCH_TABLES.join(', ')}.`
    );
    process.exitCode = 1;
    return;
  }

  const results = search(query, {
    project: options.project,
    table: options.table,
    biasType: options.biasType as SearchTable | undefined,
    limit: options.limit || 20,
    includeDuplicates: options.includeDuplicates
  });

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  // Bump-on-use (issue #153): these results are surfaced to the user.
  bumpAccess(results);

  console.log(`Found ${results.length} result(s):\n`);

  for (const result of results) {
    const preview = result.content.length > 100
      ? result.content.slice(0, 100) + '...'
      : result.content;

    const projectTag = result.project ? ` [${result.project}]` : '';
    const date = result.created_at.split('T')[0];

    const provenanceTag = formatProvenanceTag(result.provenance, options.showProvenance);

    console.log(`[${result.table}#${result.id}]${projectTag} ${date}${provenanceTag}`);
    console.log(`  ${preview.replace(/\n/g, ' ')}`);
    console.log('');
  }
}
