// Shared DB-path resolver for hooks.
// Self-contained — no imports from src/. Mirrors the resolution logic in
// src/db/connection.ts so hooks and CLI agree on which file to open.
//
// Precedence:
//   1. RECALL_DB_PATH (primary)
//   2. MEM_DB_PATH    (deprecated, accepted with one-time stderr warning)
//   3. ~/.agents/Recall/recall.db (default)

import { join } from 'path';

let warnedAboutMemDbPath = false;

export function resolveDbPath(): string {
  if (process.env.RECALL_DB_PATH) return process.env.RECALL_DB_PATH;
  if (process.env.MEM_DB_PATH) {
    if (!warnedAboutMemDbPath) {
      warnedAboutMemDbPath = true;
      console.error(
        '[recall] MEM_DB_PATH is deprecated; use RECALL_DB_PATH. ' +
        'Both are accepted for now; MEM_DB_PATH will be removed in a future release.'
      );
    }
    return process.env.MEM_DB_PATH;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.agents', 'Recall', 'recall.db');
}

// Test-only hook: reset the warning state so tests can exercise the
// first-call branch deterministically.
export function __resetDeprecationWarningForTests(): void {
  warnedAboutMemDbPath = false;
}
