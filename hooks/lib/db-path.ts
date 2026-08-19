import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { isJsonObject, parseJsonc } from './jsonc';

export interface DbPathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface ManagedDbConfigTarget {
  host: 'claude' | 'opencode' | 'pi';
  path: string;
  envPath: string[];
  format: 'json' | 'jsonc';
}

function resolveHome(env: NodeJS.ProcessEnv, home?: string): string {
  return home || env.HOME || env.USERPROFILE || homedir();
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export function resolveRecallRoot(options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const explicit = env.RECALL_DIR || env.RECALL_HOME;
  if (explicit) return expandHome(explicit, home);

  const defaultRoot = join(home, '.agents', 'Recall');
  try {
    if (lstatSync(defaultRoot).isSymbolicLink()) {
      const target = readlinkSync(defaultRoot);
      return isAbsolute(target) ? target : resolve(dirname(defaultRoot), target);
    }
  } catch {
  }

  const guideAlias = join(home, '.claude', 'Recall_GUIDE.md');
  try {
    if (lstatSync(guideAlias).isSymbolicLink()) {
      const target = readlinkSync(guideAlias);
      const guideTarget = isAbsolute(target) ? target : resolve(dirname(guideAlias), target);
      const root = dirname(dirname(guideTarget));
      if (guideTarget === join(root, 'claude', 'Recall_GUIDE.md')) return root;
    }
  } catch {
  }

  return defaultRoot;
}

export function resolveDbPathStatePath(options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  return env.RECALL_DB_PATH_STATE || join(resolveRecallRoot(options), '.db-path');
}

export function resolveManagedDbConfigTargets(options: DbPathOptions = {}): ManagedDbConfigTarget[] {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const claudeDir = env.CLAUDE_DIR || join(home, '.claude');
  const openCodeDir = env.OPENCODE_CONFIG_DIR
    || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
  const piDir = env.PI_CONFIG_DIR || env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
  return [
    { host: 'claude', path: join(home, '.claude.json'), envPath: ['mcpServers', 'recall-memory', 'env'], format: 'json' },
    { host: 'claude', path: join(claudeDir, 'settings.json'), envPath: ['mcpServers', 'recall-memory', 'env'], format: 'json' },
    { host: 'opencode', path: join(openCodeDir, 'opencode.json'), envPath: ['mcp', 'recall-memory', 'environment'], format: 'jsonc' },
    { host: 'pi', path: join(piDir, 'mcp.json'), envPath: ['mcpServers', 'recall-memory', 'env'], format: 'json' },
  ];
}

function configuredPath(target: ManagedDbConfigTarget): string | null {
  if (!existsSync(target.path)) return null;
  try {
    let node: unknown = parseJsonc(readFileSync(target.path, 'utf-8')).value;
    for (const segment of target.envPath) {
      if (!isJsonObject(node)) return null;
      node = node[segment];
    }
    if (!isJsonObject(node)) return null;
    const path = node.RECALL_DB_PATH || node.MEM_DB_PATH;
    return typeof path === 'string' && path.trim() ? path : null;
  } catch {
    return null;
  }
}

export function resolveDbPath(options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const explicit = env.RECALL_DB_PATH || env.MEM_DB_PATH;
  if (explicit) return expandHome(explicit, home);

  const statePath = resolveDbPathStatePath({ env, home });
  if (existsSync(statePath)) {
    try {
      const persisted = readFileSync(statePath, 'utf-8').split(/\r?\n/, 1)[0] || '';
      if (persisted.trim()) return expandHome(persisted, home);
    } catch {
    }
  }

  const configured = resolveManagedDbConfigTargets({ env, home })
    .map(configuredPath)
    .filter((path): path is string => !!path)
    .map(path => expandHome(path, home));
  const defaultPath = join(resolveRecallRoot({ env, home }), 'recall.db');
  if (configured.length > 0) {
    return configured.find(path => path !== defaultPath) || configured[0];
  }

  return defaultPath;
}

export function persistDbPath(path: string, options: DbPathOptions = {}): string {
  if (!path.trim()) throw new Error('database path is required');
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const resolved = expandHome(path, home);
  const statePath = resolveDbPathStatePath({ env, home });
  const temp = `${statePath}.tmp.${process.pid}`;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(temp, `${resolved}\n`, { mode: 0o600 });
  renameSync(temp, statePath);
  return resolved;
}

export function resolvePhysicalDbPath(path: string, options: DbPathOptions = {}): string {
  if (!path.trim()) throw new Error('database path is required');
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const resolved = expandHome(path, home);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

if (import.meta.main) {
  const action = process.argv[2];
  if (action === 'resolve') {
    process.stdout.write(`${resolveDbPath()}\n`);
  } else if (action === 'physical') {
    process.stdout.write(`${resolvePhysicalDbPath(process.argv[3] || '')}\n`);
  } else if (action === 'persist') {
    persistDbPath(process.argv[3] || '');
  } else {
    console.error('usage: db-path.ts resolve | physical <path> | persist <path>');
    process.exit(1);
  }
}
