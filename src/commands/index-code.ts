import { resolve } from 'path';
import { getDb } from '../db/connection.js';
import { indexCode } from '../lib/code-indexer.js';

interface IndexOptions {
  project?: string;
  changed?: boolean;
}

export async function runIndexCode(target: string | undefined, options: IndexOptions): Promise<void> {
  const db = getDb();
  const root = resolve(target ?? process.cwd());
  const result = await indexCode({
    db,
    root,
    target: root,
    project: options.project,
    changedOnly: options.changed,
  });

  console.log(`Indexed ${result.filesIndexed}/${result.filesSeen} file(s) for ${result.project}`);
  if (result.filesSkipped > 0) console.log(`Skipped unchanged: ${result.filesSkipped}`);
  console.log(`Nodes: ${result.nodesInserted}`);
  console.log(`Edges: ${result.edgesInserted}`);
  console.log(`Re-linked edges: ${result.edgesRelinked}`);
}
