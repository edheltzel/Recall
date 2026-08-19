import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { isJsonObject, parseJsonc } from './jsonc';

export const RECALL_ROOT_MARKER = '.recall-root';
export const RECALL_ROOT_MARKER_CONTENT = 'recall-root-v1\n';

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

function normalizePath(path: string, home: string): string {
  return resolve(expandHome(path, home));
}

export function resolvePhysicalPath(path: string, options: DbPathOptions = {}): string {
  if (!path.trim()) throw new Error('path is required');
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  let current = normalizePath(path, home);
  const suffix: string[] = [];
  while (true) {
    try {
      const physical = realpathSync(current);
      return suffix.length > 0 ? join(physical, ...suffix) : physical;
    } catch {
      const parent = dirname(current);
      if (parent === current) return normalizePath(path, home);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function pathContains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function pathsReferToSameLocation(
  first: string,
  second: string,
  options: DbPathOptions = {},
): boolean {
  return resolvePhysicalPath(first, options) === resolvePhysicalPath(second, options);
}

function resolveSymlinkTarget(path: string, options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const normalized = normalizePath(path, home);
  if (!lstatSync(normalized).isSymbolicLink()) throw new Error(`not a symlink: ${normalized}`);
  const target = readlinkSync(normalized);
  return resolvePhysicalPath(
    isAbsolute(target) ? target : resolve(dirname(normalized), target),
    { env, home },
  );
}

export function symlinkPointsTo(
  link: string,
  expected: string,
  options: DbPathOptions = {},
): boolean {
  try {
    return resolveSymlinkTarget(link, options) === resolvePhysicalPath(expected, options);
  } catch {
    return false;
  }
}

export function symlinkTargetWithin(
  link: string,
  root: string,
  options: DbPathOptions = {},
): boolean {
  try {
    return pathContains(resolvePhysicalPath(root, options), resolveSymlinkTarget(link, options));
  } catch {
    return false;
  }
}

function assertSafeRecallRoot(root: string, options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const physicalRoot = resolvePhysicalPath(root, { env, home });
  const physicalHome = resolvePhysicalPath(home, { env, home });
  const forbidden = [
    resolve('/'),
    physicalHome,
    resolvePhysicalPath(join(home, '.agents'), { env, home }),
    resolvePhysicalPath(join(home, '.claude'), { env, home }),
  ];
  const depth = physicalRoot.split(sep).filter(Boolean).length;
  if (depth < 2 || forbidden.includes(physicalRoot) || pathContains(physicalRoot, physicalHome)) {
    throw new Error(`refusing unsafe Recall root: ${physicalRoot}`);
  }
  return physicalRoot;
}

function hasLegacyRecallLayout(root: string): boolean {
  const isRegularFile = (path: string): boolean => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  };
  const isDirectory = (path: string): boolean => {
    try {
      return lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  const hook = join(root, 'shared', 'hooks', 'RecallStart.ts');
  const guide = join(root, 'claude', 'Recall_GUIDE.md');
  const grok = join(root, 'grok', 'hooks', 'RecallLifecycle.json');
  const interrupted = isRegularFile(join(root, '.install-incomplete'))
    && isDirectory(join(root, 'shared', 'hooks', 'lib'))
    && isDirectory(join(root, 'shared', 'skills'))
    && isDirectory(join(root, 'opencode', 'plugins'))
    && isDirectory(join(root, 'MEMORY'))
    && isDirectory(join(root, 'backups'));
  return interrupted
    || (isRegularFile(hook) && (isRegularFile(guide) || isRegularFile(grok)));
}

export function assertRecallRootOwned(root: string, options: DbPathOptions = {}): string {
  const physicalRoot = assertSafeRecallRoot(root, options);
  const marker = join(physicalRoot, RECALL_ROOT_MARKER);
  if (existsSync(marker)) {
    if (lstatSync(marker).isFile()
      && readFileSync(marker, 'utf-8') === RECALL_ROOT_MARKER_CONTENT) return physicalRoot;
    throw new Error(`invalid Recall root ownership marker: ${physicalRoot}`);
  }
  if (hasLegacyRecallLayout(physicalRoot)) return physicalRoot;
  throw new Error(`Recall root is not installer-owned: ${physicalRoot}`);
}

function isStaleRootMarkerTemp(root: string, entry: string): boolean {
  const match = /^\.recall-root\.tmp\.([1-9]\d*)$/.exec(entry);
  if (!match) return false;
  const path = join(root, entry);
  try {
    if (!lstatSync(path).isFile()) return false;
    if (readFileSync(path, 'utf-8') !== RECALL_ROOT_MARKER_CONTENT) return false;
    try {
      process.kill(Number(match[1]), 0);
      return false;
    } catch (error) {
      return (error as { code?: string }).code === 'ESRCH';
    }
  } catch {
    return false;
  }
}

export function claimRecallRoot(root: string, options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const normalized = normalizePath(root, home);
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(normalized);
  } catch {
  }
  if (stat?.isSymbolicLink()) return assertRecallRootOwned(normalized, { env, home });
  const physicalRoot = assertSafeRecallRoot(normalized, { env, home });
  mkdirSync(physicalRoot, { recursive: true });
  const marker = join(physicalRoot, RECALL_ROOT_MARKER);
  if (existsSync(marker)) return assertRecallRootOwned(physicalRoot, { env, home });
  const allowed = new Set([
    'backups',
    'MEMORY',
    '.db-path',
    '.install-incomplete',
    'recall.db',
    'recall.db-wal',
    'recall.db-shm',
  ]);
  const entries = readdirSync(physicalRoot);
  const staleTemps = new Set(entries.filter(entry => isStaleRootMarkerTemp(physicalRoot, entry)));
  if (!hasLegacyRecallLayout(physicalRoot)
    && entries.some(entry => !allowed.has(entry) && !staleTemps.has(entry))) {
    throw new Error(`refusing to claim non-Recall directory: ${physicalRoot}`);
  }
  for (const entry of staleTemps) unlinkSync(join(physicalRoot, entry));
  const temp = `${marker}.tmp.${process.pid}`;
  writeFileSync(temp, RECALL_ROOT_MARKER_CONTENT, { mode: 0o600 });
  renameSync(temp, marker);
  return physicalRoot;
}

export function resolveRecallRoot(options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const defaultRoot = normalizePath(join(home, '.agents', 'Recall'), home);
  const explicit = [env.RECALL_DIR, env.RECALL_HOME]
    .filter((path): path is string => !!path)
    .map(path => normalizePath(path, home))
    .find(path => path !== defaultRoot);
  if (explicit) return explicit;

  let defaultStat: ReturnType<typeof lstatSync> | null = null;
  try {
    defaultStat = lstatSync(defaultRoot);
  } catch {
  }
  if (defaultStat?.isSymbolicLink()) {
    return assertRecallRootOwned(resolvePhysicalPath(defaultRoot, { env, home }), { env, home });
  }

  const guideAlias = join(home, '.claude', 'Recall_GUIDE.md');
  let guideStat: ReturnType<typeof lstatSync> | null = null;
  try {
    guideStat = lstatSync(guideAlias);
  } catch {
  }
  if (guideStat?.isSymbolicLink()) {
    const target = readlinkSync(guideAlias);
    const guideTarget = normalizePath(
      isAbsolute(target) ? target : resolve(dirname(guideAlias), target),
      home,
    );
    const root = dirname(dirname(guideTarget));
    if (guideTarget === join(root, 'claude', 'Recall_GUIDE.md')) {
      try {
        lstatSync(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultRoot;
        throw error;
      }
      return assertRecallRootOwned(root, { env, home });
    }
  }

  return defaultRoot;
}

export function resolvePhysicalRecallRoot(options: DbPathOptions = {}): string {
  return resolvePhysicalPath(resolveRecallRoot(options), options);
}

export function resolveRecallRootLocator(options: DbPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const locator = normalizePath(join(home, '.agents', 'Recall'), home);
  try {
    if (!lstatSync(locator).isSymbolicLink()) return null;
    const target = assertRecallRootOwned(resolvePhysicalPath(locator, { env, home }), { env, home });
    return target === resolvePhysicalRecallRoot(options) ? locator : null;
  } catch {
    return null;
  }
}

export function resolveDbPathStatePath(options: DbPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const defaultState = normalizePath(join(home, '.agents', 'Recall', '.db-path'), home);
  const explicit = env.RECALL_DB_PATH_STATE
    ? normalizePath(env.RECALL_DB_PATH_STATE, home)
    : '';
  return explicit && explicit !== defaultState
    ? explicit
    : join(resolveRecallRoot({ env, home }), '.db-path');
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
    const physicalDefault = resolvePhysicalPath(defaultPath, { env, home });
    return configured.find(path => resolvePhysicalPath(path, { env, home }) !== physicalDefault)
      || configured[0];
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
  return resolvePhysicalPath(path, options);
}

export function resolvePurgeBackupBase(
  root: string,
  preferred: string,
  fallback: string,
  options: DbPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const home = resolveHome(env, options.home);
  const physicalRoot = resolvePhysicalPath(root, { env, home });
  const candidates = [
    preferred,
    fallback,
    join(dirname(physicalRoot), 'Recall-pre-purge'),
    join(home, '.recall-pre-purge'),
  ];
  for (const candidate of candidates) {
    const physicalCandidate = resolvePhysicalPath(candidate, { env, home });
    if (!pathContains(physicalRoot, physicalCandidate)) return physicalCandidate;
  }
  throw new Error(`cannot place purge snapshot outside Recall root: ${physicalRoot}`);
}

if (import.meta.main) {
  try {
    const action = process.argv[2];
    if (action === 'resolve') {
      process.stdout.write(`${resolveDbPath()}\n`);
    } else if (action === 'root') {
      process.stdout.write(`${resolveRecallRoot()}\n`);
    } else if (action === 'physical-root') {
      process.stdout.write(`${resolvePhysicalRecallRoot()}\n`);
    } else if (action === 'state') {
      process.stdout.write(`${resolveDbPathStatePath()}\n`);
    } else if (action === 'locator') {
      const locator = resolveRecallRootLocator();
      if (locator) process.stdout.write(`${locator}\n`);
    } else if (action === 'physical') {
      process.stdout.write(`${resolvePhysicalDbPath(process.argv[3] || '')}\n`);
    } else if (action === 'same-path') {
      process.exit(pathsReferToSameLocation(process.argv[3] || '', process.argv[4] || '') ? 0 : 1);
    } else if (action === 'symlink-points-to') {
      process.exit(symlinkPointsTo(process.argv[3] || '', process.argv[4] || '') ? 0 : 1);
    } else if (action === 'symlink-target-within') {
      process.exit(symlinkTargetWithin(process.argv[3] || '', process.argv[4] || '') ? 0 : 1);
    } else if (action === 'purge-backup-base') {
      process.stdout.write(`${resolvePurgeBackupBase(
        process.argv[3] || '',
        process.argv[4] || '',
        process.argv[5] || '',
      )}\n`);
    } else if (action === 'claim-root') {
      claimRecallRoot(process.argv[3] || '');
    } else if (action === 'assert-owned-root') {
      process.stdout.write(`${assertRecallRootOwned(process.argv[3] || '')}\n`);
    } else if (action === 'persist') {
      persistDbPath(process.argv[3] || '');
    } else {
      console.error('usage: db-path.ts resolve | root | physical-root | state | locator | physical <path> | same-path <first> <second> | symlink-points-to <link> <expected> | symlink-target-within <link> <root> | purge-backup-base <root> <preferred> <fallback> | claim-root <path> | assert-owned-root <path> | persist <path>');
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
