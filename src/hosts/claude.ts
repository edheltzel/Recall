import { existsSync, readFileSync } from 'fs';
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

/**
 * Marketplace-qualified id Claude Code keys the native plugin under. Claude namespaces
 * plugin components, so the bundle's MCP server registers as `plugin:recall:recall-memory`
 * and never collides with a lifecycle-installed user-scope `recall-memory`. The two simply
 * coexist, which is why install/update reconcile them instead of relying on an override.
 *
 * `lib/install-lib.sh` carries the same id for the bash lifecycle; keep them in step.
 */
export const CLAUDE_PLUGIN_ID = 'recall@recall-marketplace';

export interface ClaudePluginState {
  installed: boolean;
  /** Installed and not disabled in settings — i.e. actually contributing skills and MCP. */
  active: boolean;
  version: string | null;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read Claude's own plugin state files; never shells out to the CLI. */
export function claudePluginState(home: string): ClaudePluginState {
  const paths = claudePaths(home);
  const installedPlugins = readJson(join(paths.root, 'plugins', 'installed_plugins.json'));
  const entries = (installedPlugins?.plugins as Record<string, unknown> | undefined)?.[CLAUDE_PLUGIN_ID];
  const record = Array.isArray(entries) ? (entries[0] as Record<string, unknown> | undefined) : undefined;
  if (!record) return { installed: false, active: false, version: null };

  const enabledPlugins = readJson(paths.settings)?.enabledPlugins as Record<string, unknown> | undefined;
  return {
    installed: true,
    active: enabledPlugins?.[CLAUDE_PLUGIN_ID] !== false,
    version: typeof record.version === 'string' ? record.version : null,
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
