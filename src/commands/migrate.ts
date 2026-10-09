// recall migrate — relocate the SQLite database to a new path and rewrite the
// MCP / hook configs across detected platforms so everything keeps pointing
// at the same file.
//
// Usage:
//   recall migrate --to /new/path/recall.db
//   recall migrate --to /new/path/recall.db --dry-run
//
// Behavior:
//   - Refuses to overwrite any path at the destination, or any
//     destination sidecar (-wal, -shm, -journal) of any type or size.
//   - Refuses to migrate while a process has the source DB open (lsof check).
//   - Snapshots source DB + sidecars + configs under
//     ~/.agents/Recall/backups/<TIMESTAMP>/pre-migrate/ before any mutation.
//   - Moves <src>.db, <src>.db-wal, <src>.db-shm to the new path. A sidecar
//     move that still fails moves the database back. Config commits that
//     already landed are restored from the bytes taken before commit().
//   - Updates env.RECALL_DB_PATH in each config we detect:
//       ~/.claude.json, ~/.claude/settings.json,
//       ~/.config/opencode/opencode.json, ~/.pi/agent/mcp.json
//   - --dry-run prints the plan without touching anything.

import { closeDb, getDbPath } from '../db/connection.js';
import { existsSync, mkdirSync, statSync, lstatSync, copyFileSync, linkSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { configurableHosts, type McpConfigTarget } from '../hosts/index.js';
import {
  parseJsonc,
  stageFileAtomic,
  stageJsonAtomic,
  validateClaudeConfigShape,
  type StagedFileWrite,
} from '../../lib/jsonc-mcp.js';

export const migrateTestHooks: {
  failCommitPath: string;
  beforeMove?: () => void;
  onCommitFailure?: () => void;
} = { failCommitPath: '' };

export interface MigrateOptions {
  to: string;
  dryRun?: boolean;
}

function expandHome(p: string, home: string): string {
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (p === '~') return home;
  return p;
}

function isOpen(path: string): boolean {
  try {
    // `lsof -- <path>` exits 0 if the file has an open handle.
    execFileSync('lsof', ['--', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const DEST_SIDECARS = ['-wal', '-shm', '-journal'] as const;
const MOVED_SIDECARS = ['-wal', '-shm'] as const;
// UF/SF immutable and append. Rename over these fails with EPERM; mode bits do not.
const BLOCKING_FLAGS = 0x2 | 0x4 | 0x00020000 | 0x00040000;

function refuseDestination(path: string): never {
  console.error(`Error: destination already exists: ${path}`);
  console.error('Refusing to overwrite. Delete the file or choose a different path.');
  process.exit(1);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function existingDestinationSidecar(dest: string): string | undefined {
  for (const ext of DEST_SIDECARS) {
    if (pathExists(dest + ext)) return dest + ext;
  }
  return undefined;
}

function destinationCollision(dest: string): string | undefined {
  return pathExists(dest) ? dest : existingDestinationSidecar(dest);
}

function moveNoReplace(source: string, destination: string): void {
  linkSync(source, destination);
  unlinkSync(source);
}

function commitBlocked(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  if (!statSync(path).isFile()) return `not a replaceable file: ${path}`;
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    const flags = Number.parseInt(execFileSync('stat', ['-f', '%f', path], { encoding: 'utf-8' }).trim(), 10);
    if ((flags & BLOCKING_FLAGS) !== 0) return `immutable: ${path}`;
  } else if (process.platform === 'linux') {
    try {
      const attrs = execFileSync('lsattr', ['-d', path], { encoding: 'utf-8' }).trim().split(/\s+/)[0] ?? '';
      if (attrs.includes('i') || attrs.includes('a')) return `immutable: ${path}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

function detectConfigs(home: string): McpConfigTarget[] {
  return configurableHosts.flatMap(host => host.mcpConfigTargets(home));
}

type ConfigPatchResult =
  | { status: 'changed'; config: Record<string, unknown> }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string };

type PreparedConfigPatch = {
  target: McpConfigTarget;
  result: ConfigPatchResult;
};

type StagedConfigPatch = {
  target: McpConfigTarget;
  write: StagedFileWrite;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function prepareConfigPatch(target: McpConfigTarget, newDbPath: string): ConfigPatchResult {
  if (!existsSync(target.path)) return { status: 'skipped', reason: 'not present' };
  let raw: string;
  try {
    raw = readFileSync(target.path, 'utf-8');
  } catch (e) {
    return { status: 'error', reason: `read error: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (e) {
    return { status: 'error', reason: `invalid JSONC: ${(e as Error).message}` };
  }
  if (!isRecord(parsed)) return { status: 'error', reason: 'invalid JSONC root' };
  if (target.host === 'claude') {
    try {
      validateClaudeConfigShape(parsed);
    } catch (e) {
      return { status: 'error', reason: `invalid Claude config: ${(e as Error).message}` };
    }
  }

  let node = parsed;
  for (let i = 0; i < target.envPath.length - 1; i++) {
    const next = node[target.envPath[i]];
    if (next === undefined) return { status: 'skipped', reason: 'recall-memory entry absent' };
    if (!isRecord(next)) return { status: 'error', reason: 'invalid recall-memory config' };
    node = next;
  }

  const envKey = target.envPath[target.envPath.length - 1];
  const currentEnv = node[envKey];
  if (currentEnv !== undefined && !isRecord(currentEnv)) {
    return { status: 'error', reason: 'invalid recall-memory environment' };
  }
  const env = currentEnv ?? {};
  const existing = env.RECALL_DB_PATH;
  if (existing === newDbPath) return { status: 'skipped', reason: 'already up-to-date' };

  env.RECALL_DB_PATH = newDbPath;
  if ('MEM_DB_PATH' in env) delete env.MEM_DB_PATH;
  node[envKey] = env;
  return { status: 'changed', config: parsed };
}

export function runMigrate(opts: MigrateOptions, home = homedir()): void {
  if (!opts.to || opts.to.trim() === '') {
    console.error('Error: --to <path> is required');
    process.exit(2);
  }

  const dryRun = !!opts.dryRun;
  const src = resolve(getDbPath());
  const dest = resolve(expandHome(opts.to, home));

  console.log(`recall migrate${dryRun ? ' (dry-run)' : ''}`);
  console.log(`  source:      ${src}`);
  console.log(`  destination: ${dest}`);
  console.log('');

  if (!existsSync(src)) {
    console.log(`Source database does not exist at ${src} — nothing to migrate.`);
    console.log(`Set RECALL_DB_PATH or run from a host where Recall is installed.`);
    return;
  }

  if (src === dest) {
    console.log('Source and destination are identical — nothing to do.');
    return;
  }

  const collision = destinationCollision(dest);
  if (collision) refuseDestination(collision);

  // Refuse to migrate if the source DB is open. lsof's absence on the host
  // is treated as "probably safe" — best-effort check.
  if (isOpen(src)) {
    console.error(`Error: source database is currently open: ${src}`);
    console.error('Stop recall-mcp (`pkill -f recall-mcp`) and any active `recall` CLI, then retry.');
    process.exit(1);
  }

  // Close our own connection before moving the file.
  closeDb();

  const targets = detectConfigs(home);
  const patches: PreparedConfigPatch[] = targets.map(target => ({
    target,
    result: prepareConfigPatch(target, dest),
  }));
  for (const patch of patches) {
    if (patch.result.status === 'error') {
      console.error(`Error: cannot patch ${patch.target.path} (${patch.result.reason})`);
      process.exit(1);
    }
  }

  // Build the pre-migrate snapshot path under the install root.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_').replace(/-/g, '');
  const snapshotDir = join(home, '.agents', 'Recall', 'backups', stamp, 'pre-migrate');

  console.log('Plan:');
  console.log(`  1. snapshot source + configs to ${snapshotDir}`);
  console.log(`  2. move ${src} → ${dest}`);
  for (const ext of MOVED_SIDECARS) {
    if (existsSync(src + ext)) console.log(`  3. move ${src + ext} → ${dest + ext}`);
  }
  let configIdx = 4;
  for (const t of targets) {
    if (!existsSync(t.path)) continue;
    console.log(`  ${configIdx++}. patch RECALL_DB_PATH in ${t.path}`);
  }
  console.log('');

  if (dryRun) {
    console.log('--dry-run: no changes made.');
    return;
  }

  // 1. Snapshot.
  mkdirSync(snapshotDir, { recursive: true });
  copyFileSync(src, join(snapshotDir, 'source.db'));
  for (const ext of MOVED_SIDECARS) {
    if (existsSync(src + ext)) {
      copyFileSync(src + ext, join(snapshotDir, `source.db${ext}`));
    }
  }
  for (const t of targets) {
    if (!existsSync(t.path)) continue;
    const rel = t.path.startsWith(home + '/') ? t.path.slice(home.length + 1) : t.path.replace(/^\//, '');
    const outFile = join(snapshotDir, rel);
    mkdirSync(dirname(outFile), { recursive: true });
    copyFileSync(t.path, outFile);
  }
  console.log(`✓ Snapshot: ${snapshotDir}`);

  const staged: StagedConfigPatch[] = [];
  for (const patch of patches) {
    if (patch.result.status !== 'changed') continue;
    try {
      staged.push({
        target: patch.target,
        write: stageJsonAtomic(patch.target.path, patch.result.config),
      });
    } catch (error) {
      for (const item of staged) item.write.cleanup();
      console.error(`Error: cannot stage ${patch.target.path} (${error instanceof Error ? error.message : String(error)})`);
      process.exit(1);
    }
  }

  for (const patch of staged) {
    try {
      const blocked = commitBlocked(patch.write.target);
      if (!blocked) continue;
      throw new Error(blocked);
    } catch (error) {
      for (const item of staged) item.write.cleanup();
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Error: cannot commit ${patch.target.path} (${reason})`);
      process.exit(1);
    }
  }

  // 2. Move DB + sidecars. Roll renames and already-committed configs back on failure.
  const movedExts: string[] = [];
  const committedConfigs: { path: string; bytes: Buffer; mode: number }[] = [];
  let dbMoved = false;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    migrateTestHooks.beforeMove?.();
    const racedCollision = destinationCollision(dest);
    if (racedCollision) throw new Error(`destination already exists: ${racedCollision}`);
    moveNoReplace(src, dest);
    dbMoved = true;
    for (const ext of MOVED_SIDECARS) {
      if (existsSync(src + ext)) {
        moveNoReplace(src + ext, dest + ext);
        movedExts.push(ext);
      }
    }
    console.log(`✓ Moved DB: ${dest}`);

    // 3. Patch configs. Record pre-commit bytes so a later commit can be undone.
    for (const patch of staged) {
      const path = patch.write.target;
      const prior = { path, bytes: readFileSync(path), mode: statSync(path).mode };
      if (migrateTestHooks.failCommitPath === patch.target.path) {
        migrateTestHooks.onCommitFailure?.();
        throw new Error('injected commit failure');
      }
      patch.write.commit();
      committedConfigs.push(prior);
      console.log(`✓ Patched ${path}`);
    }
  } catch (error) {
    const problems = [error instanceof Error ? error.message : String(error)];
    for (const ext of movedExts.reverse()) {
      try { moveNoReplace(dest + ext, src + ext); }
      catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        problems.push(`failed to move sidecar back from ${dest}${ext} (${message})`);
      }
    }
    if (dbMoved) {
      try { moveNoReplace(dest, src); }
      catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        problems.push(`failed to move database back from ${dest} (${message})`);
      }
    }
    for (const prior of committedConfigs.reverse()) {
      try {
        const restore = stageFileAtomic(prior.path, prior.bytes, prior.mode);
        try { restore.commit(); }
        finally { restore.cleanup(); }
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        problems.push(`failed to restore ${prior.path} (${message})`);
      }
    }
    for (const item of staged) item.write.cleanup();
    console.error(`Error: migration failed (${problems.join('; ')})`);
    process.exit(1);
  }

  for (const patch of patches) {
    if (patch.result.status === 'skipped' && patch.result.reason !== 'not present') {
      console.log(`  Skipped ${patch.target.path} (${patch.result.reason})`);
    }
  }

  console.log('');
  console.log('Migration complete.');
  const configuredHosts = [...new Set(targets.filter(t => existsSync(t.path)).map(t => t.host))];
  if (configuredHosts.length > 0) {
    console.log(`Restart ${configuredHosts.join(' / ')} so their MCP servers reload with the new path.`);
  }

  // Hint: if MEM_DB_PATH is still set in the shell, warn the user that it'd
  // be ignored on next session since RECALL_DB_PATH takes precedence.
  if (process.env.MEM_DB_PATH && !process.env.RECALL_DB_PATH) {
    console.log('');
    console.log(`Note: MEM_DB_PATH=${process.env.MEM_DB_PATH} is still set in this shell.`);
    console.log('It will be ignored when RECALL_DB_PATH is set elsewhere; consider unsetting it.');
  }
}
