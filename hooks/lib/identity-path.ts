// Shared identity-path resolver for hooks and the CLI.
// Self-contained (no imports from src/) so RecallStart.ts (a hook) and
// `recall onboard` (CLI) agree on which identity.md to read and write.
// Mirrors the hooks/lib/db-path.ts shared-resolver pattern.
//
// The global identity lives under the one Recall install root,
// ~/.agents/Recall/MEMORY/identity.md. The installer links
// ~/.claude/MEMORY/identity.md to that canonical file. There is no relocated
// or custom install root: the only override is RECALL_IDENTITY_PATH.
//
// Precedence (resolveIdentityPath):
//   1. explicitPath            (`recall onboard --out`)
//   2. RECALL_IDENTITY_PATH
//   3. ./.atlas-recall/identity.md - project-local, when it exists (or when
//      forced by `recall onboard --project`)
//   4. ~/.claude/MEMORY/identity.md when it is user-owned (a regular file or a
//      symlink to something other than the canonical file)
//   5. ~/.agents/Recall/MEMORY/identity.md - the canonical file; also chosen
//      when the Claude path is the managed link to it, so writers update the
//      target instead of replacing the link.

import { existsSync, lstatSync, readlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
  const root = join(home, '.agents', 'Recall');
  return {
    root,
    alias: join(home, '.claude', 'MEMORY', 'identity.md'),
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
