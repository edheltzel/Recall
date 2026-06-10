// Shared DB-path resolver for hooks.
// Self-contained — no imports from src/. Mirrors the resolution logic in
// src/db/connection.ts so hooks and CLI agree on which file to open.
//
// Precedence:
//   1. RECALL_DB_PATH (primary)
//   2. MEM_DB_PATH    (legacy fallback)
//   3. ~/.agents/Recall/recall.db (default)

import { join } from 'path';

export function resolveDbPath(): string {
  return (
    process.env.RECALL_DB_PATH ||
    process.env.MEM_DB_PATH ||
    join(process.env.HOME || process.env.USERPROFILE || '', '.agents', 'Recall', 'recall.db')
  );
}
