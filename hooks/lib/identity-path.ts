import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveRecallRoot, symlinkPointsTo } from './db-path';

export interface ManagedIdentityPaths {
  root: string;
  alias: string;
  canonical: string;
}

interface ManagedIdentityPathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface IdentityPathOptions extends ManagedIdentityPathOptions {
  cwd?: string;
  explicitPath?: string;
  project?: 'existing' | 'force' | 'ignore';
}

function resolveHome(env: NodeJS.ProcessEnv, home?: string): string {
  return home || env.HOME || env.USERPROFILE || homedir();
}

export function resolveManagedIdentityPaths(
  options: ManagedIdentityPathOptions = {},
): ManagedIdentityPaths {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const alias = join(home, '.claude', 'MEMORY', 'identity.md');
  const root = resolveRecallRoot({ env, home });

  return {
    root,
    alias,
    canonical: join(root, 'MEMORY', 'identity.md'),
  };
}

export function resolveIdentityPath(options: IdentityPathOptions = {}): string {
  const env = options.env ?? process.env;
  if (options.explicitPath) return options.explicitPath;

  const envPath = env.RECALL_IDENTITY_PATH?.trim();
  if (envPath) return envPath;

  const projectPath = join(options.cwd ?? process.cwd(), '.atlas-recall', 'identity.md');
  const projectMode = options.project ?? 'existing';
  if (projectMode === 'force' || (projectMode === 'existing' && existsSync(projectPath))) {
    return projectPath;
  }

  const managed = resolveManagedIdentityPaths(options);
  if (!existsSync(managed.alias)) return managed.canonical;
  return symlinkPointsTo(managed.alias, managed.canonical, { env, home: resolveHome(env, options.home) })
    ? managed.canonical
    : managed.alias;
}
