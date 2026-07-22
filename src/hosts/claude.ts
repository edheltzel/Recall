import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { McpConfigTarget, NativeHostAdapter } from './types.js';

export interface ClaudePaths {
  root: string;
  memory: string;
  projects: string;
  sessions: string;
  hooks: string;
  skills: string;
  guide: string;
  settings: string;
  legacySettings: string;
}

export function claudePaths(home: string): ClaudePaths {
  const root = join(home, '.claude');
  return {
    root,
    memory: join(root, 'MEMORY'),
    projects: join(root, 'projects'),
    sessions: join(root, 'sessions'),
    hooks: join(root, 'hooks'),
    skills: join(root, 'skills'),
    guide: join(root, 'Recall_GUIDE.md'),
    settings: join(root, 'settings.json'),
    legacySettings: join(home, '.claude.json'),
  };
}

export function claudeMcpConfigTargets(home: string): McpConfigTarget[] {
  const paths = claudePaths(home);
  const envPath = ['mcpServers', 'recall-memory', 'env'];
  return [
    { host: 'claude', path: paths.legacySettings, envPath, format: 'json' },
    { host: 'claude', path: paths.settings, envPath, format: 'json' },
  ];
}

/** Locate Claude Code without embedding that native-host rule in generic diagnostics. */
export function findClaudeCli(home: string, pathEnv: string | undefined = process.env.PATH): string | null {
  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.local', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const resolved = execFileSync('which', ['claude'], {
      encoding: 'utf-8',
      timeout: 3000,
      env: { ...process.env, PATH: pathEnv },
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

export interface ClaudeCliReadiness {
  path: string | null;
  warnings: string[];
}

export function inspectClaudeCli(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCliReadiness {
  const warnings: string[] = [];
  if (env.CLAUDECODE) warnings.push('CLAUDECODE env var set (will block extraction)');
  const path = findClaudeCli(home, env.PATH);
  if (!path) warnings.push('Claude CLI not found in PATH (Claude lifecycle extraction will not work)');
  return { path, warnings };
}

export const claudeHost: NativeHostAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  mcpConfigTargets: claudeMcpConfigTargets,
};
