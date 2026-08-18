import { join } from 'path';
import type { NativeHostAdapter } from './types.js';
import { resolveManagedDbConfigTargets } from '../../hooks/lib/db-path.js';

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
    return resolveManagedDbConfigTargets({ home, env: {} }).filter(target => target.host === 'pi');
  },
};
