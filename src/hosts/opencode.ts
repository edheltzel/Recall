import { join } from 'path';
import type { NativeHostAdapter } from './types.js';
import { resolveManagedDbConfigTargets } from '../../hooks/lib/db-path.js';

export interface OpenCodePaths {
  root: string;
  guide: string;
  settings: string;
}

export function openCodePaths(home: string): OpenCodePaths {
  const root = join(home, '.config', 'opencode');
  return {
    root,
    guide: join(root, 'Recall_GUIDE.md'),
    settings: join(root, 'opencode.json'),
  };
}

export const openCodeHost: NativeHostAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  mcpConfigTargets(home) {
    return resolveManagedDbConfigTargets({ home, env: {} }).filter(target => target.host === 'opencode');
  },
};
