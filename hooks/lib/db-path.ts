// Shared DB-path resolver for hooks.
// Self-contained — no imports from src/. src/db/connection.ts reuses
// expandDbPathTilde so hooks, CLI, and lib/install-lib.sh
// (recall_resolve_db_path) agree on which file to open.
//
// Precedence:
//   1. RECALL_DB_PATH (primary)
//   2. MEM_DB_PATH    (legacy fallback)
//   3. ~/.agents/Recall/recall.db (default)

import { join } from 'path';

/** Preserve the suffix: normalizing symlink/.. paths can select a different database. */
export function expandDbPathTilde(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return home + raw.slice(1);
  return raw;
}

export function resolveDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const raw = process.env.RECALL_DB_PATH || process.env.MEM_DB_PATH;
  return raw ? expandDbPathTilde(raw, home) : join(home, '.agents', 'Recall', 'recall.db');
}
