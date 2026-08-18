import { existsSync, lstatSync, readlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';

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
  const guideAlias = join(home, '.claude', 'Recall_GUIDE.md');
  let root = env.RECALL_DIR || env.RECALL_HOME || join(home, '.agents', 'Recall');

  try {
    if (existsSync(guideAlias) && lstatSync(guideAlias).isSymbolicLink()) {
      const guideTarget = readlinkSync(guideAlias);
      const discoveredRoot = dirname(dirname(guideTarget));
      if (isAbsolute(guideTarget)
        && guideTarget === join(discoveredRoot, 'claude', 'Recall_GUIDE.md')) {
        root = discoveredRoot;
      }
    }
  } catch {
  }

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
  try {
    const aliasStat = lstatSync(managed.alias);
    if (aliasStat.isSymbolicLink() && readlinkSync(managed.alias) === managed.canonical) {
      return managed.canonical;
    }
    return managed.alias;
  } catch {
    return managed.canonical;
  }
}
