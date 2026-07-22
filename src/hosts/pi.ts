import { join } from 'path';
import type { NativeHostAdapter } from './types.js';

export interface PiPaths {
  root: string;
  guide: string;
  mcpSettings: string;
}

export function piPaths(home: string): PiPaths {
  const root = join(home, '.pi', 'agent');
  return {
    root,
    guide: join(root, 'Recall_GUIDE.md'),
    mcpSettings: join(root, 'mcp.json'),
  };
}

export const piHost: NativeHostAdapter = {
  id: 'pi',
  displayName: 'Pi',
  mcpConfigTargets(home) {
    const paths = piPaths(home);
    return [{
      host: 'pi',
      path: paths.mcpSettings,
      envPath: ['mcpServers', 'recall-memory', 'environment'],
      format: 'json',
    }];
  },
};
