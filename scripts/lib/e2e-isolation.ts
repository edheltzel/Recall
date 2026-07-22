import { existsSync, statSync } from 'fs';
import { dirname } from 'path';

export interface FileMetadata {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  ino?: number;
}

export function metadata(path: string): FileMetadata {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function assertSafeTestDb(testDb: string, productionDb: string): void {
  const productionDir = dirname(productionDb);
  if (testDb === productionDb || testDb.startsWith(`${productionDir}/`)) {
    throw new Error(`unsafe test database path: ${testDb}`);
  }
}

export function assertMetadataUnchanged(path: string, before: FileMetadata): void {
  const after = metadata(path);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`production DB metadata changed: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
}
