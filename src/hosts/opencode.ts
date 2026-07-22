import { join } from 'path';
import type { NativeHostAdapter } from './types.js';

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
    const paths = openCodePaths(home);
    return [{
      host: 'opencode',
      path: paths.settings,
      envPath: ['mcp', 'recall-memory', 'environment'],
      format: 'jsonc',
    }];
  },
};
