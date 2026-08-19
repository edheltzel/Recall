import type { Database } from 'bun:sqlite';

export function tableExists(db: Database, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}
