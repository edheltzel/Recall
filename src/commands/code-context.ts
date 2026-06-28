// recall code-context — surface the decisions/learnings made about the symbols
// defined in a source file, by fusing the native code KG with memory FTS in the
// one recall.db (design §5). Project-scoped, token-cheap output.

import { isAbsolute, relative } from 'path';
import { getDb } from '../db/connection.js';
import { detectProject } from '../lib/project.js';
import { codeContextForFile } from '../lib/code-context.js';

interface CodeContextOptions {
  project?: string;
  limit?: number;
}

// code_files.path is stored repo-relative with POSIX separators. Normalize the
// user-supplied path to that shape so `src/foo.ts`, `./src/foo.ts`, and an
// absolute path all resolve to the same stored key.
function normalizeRelpath(input: string): string {
  const rel = isAbsolute(input) ? relative(process.cwd(), input) : input;
  return rel.split('\\').join('/').replace(/^\.\//, '');
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? oneLine.slice(0, 100) + '...' : oneLine;
}

// created_at is ISO (`...T...`) from tests and space-separated (`YYYY-MM-DD HH:MM:SS`)
// from SQLite CURRENT_TIMESTAMP — take the date portion either way.
function dateOnly(createdAt: string): string {
  return createdAt.split(/[ T]/)[0];
}

export function runCodeContext(relpath: string, options: CodeContextOptions): void {
  const db = getDb();
  const project = options.project ?? detectProject();
  if (!project) {
    console.error('Could not determine project. Pass --project <name>.');
    process.exitCode = 1;
    return;
  }

  const path = normalizeRelpath(relpath);
  const ctx = codeContextForFile(db, { project, path, limit: options.limit ?? 20 });

  if (ctx.symbolCount === 0) {
    console.log(`${path} — not indexed for project "${project}". Run \`recall index\` first.`);
    return;
  }

  if (ctx.decisions.length === 0 && ctx.learnings.length === 0) {
    console.log(`${path} — ${ctx.symbolCount} symbol(s) indexed. No decisions or learnings reference its symbols.`);
    return;
  }

  console.log(`${path} — ${ctx.symbolCount} symbol(s) indexed [${project}]\n`);

  if (ctx.decisions.length > 0) {
    console.log(`Decisions (${ctx.decisions.length}):`);
    for (const d of ctx.decisions) {
      console.log(`  [decisions#${d.id}] ${dateOnly(d.created_at)} · matched: ${d.symbols}`);
      console.log(`    ${truncate(d.decision)}`);
    }
    console.log('');
  }

  if (ctx.learnings.length > 0) {
    console.log(`Learnings (${ctx.learnings.length}):`);
    for (const l of ctx.learnings) {
      console.log(`  [learnings#${l.id}] ${dateOnly(l.created_at)} · matched: ${l.symbols}`);
      console.log(`    ${truncate(l.problem)}`);
    }
    console.log('');
  }
}
