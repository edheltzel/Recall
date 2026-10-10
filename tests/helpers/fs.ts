import { readdirSync } from 'fs';
import { basename, dirname } from 'path';

export function atomicTempEntries(file: string): string[] {
  const prefix = `${basename(file)}.`;
  return readdirSync(dirname(file))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    .sort();
}
