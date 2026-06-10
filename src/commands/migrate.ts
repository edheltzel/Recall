// recall migrate — relocate the SQLite database to a new path and rewrite the
// MCP / hook configs across detected platforms so everything keeps pointing
// at the same file.
//
// Usage:
//   recall migrate --to /new/path/recall.db
//   recall migrate --to /new/path/recall.db --dry-run
//
// Behavior:
//   - Refuses to overwrite a non-empty file at the destination.
//   - Refuses to migrate while a process has the source DB open (lsof check).
//   - Snapshots source DB + sidecars + configs under
//     ~/.agents/Recall/backups/<TIMESTAMP>/pre-migrate/ before any mutation.
//   - Moves <src>.db, <src>.db-wal, <src>.db-shm to the new path (renames
//     sidecars in lockstep so SQLite still finds them).
//   - Updates env.RECALL_DB_PATH in each config we detect:
//       ~/.claude.json, ~/.claude/settings.json,
//       ~/.config/opencode/opencode.json, ~/.pi/agent/mcp.json
//   - --dry-run prints the plan without touching anything.

import { closeDb, getDbPath } from '../db/connection.js';
import { existsSync, mkdirSync, statSync, copyFileSync, renameSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

export interface MigrateOptions {
  to: string;
  dryRun?: boolean;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
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

function isSidecar(suffix: string): suffix is '-wal' | '-shm' {
  return suffix === '-wal' || suffix === '-shm';
}

interface ConfigTarget {
  path: string;
  // Path within the parsed JSON to the env object that needs RECALL_DB_PATH.
  // Strings are property keys, all-or-nothing — if any segment is missing
  // (or the recall-memory entry is absent), the writer skips silently.
  envPath: string[];
}

function detectConfigs(): ConfigTarget[] {
  const home = homedir();
  return [
    { path: join(home, '.claude.json'),                                envPath: ['mcpServers', 'recall-memory', 'env'] },
    { path: join(home, '.claude', 'settings.json'),                    envPath: ['mcpServers', 'recall-memory', 'env'] },
    { path: join(home, '.config', 'opencode', 'opencode.json'),        envPath: ['mcp', 'recall-memory', 'environment'] },
    { path: join(home, '.pi', 'agent', 'mcp.json'),                    envPath: ['mcpServers', 'recall-memory', 'environment'] },
  ];
}

function patchConfigEnv(target: ConfigTarget, newDbPath: string, dryRun: boolean): { changed: boolean; reason?: string } {
  if (!existsSync(target.path)) return { changed: false, reason: 'not present' };
  let raw: string;
  try {
    raw = readFileSync(target.path, 'utf-8');
  } catch (e) {
    return { changed: false, reason: `read error: ${(e as Error).message}` };
  }
  // opencode.json may contain JSONC — strip comments before parsing.
  const stripped = raw
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  let cfg: any;
  try {
    cfg = JSON.parse(stripped);
  } catch (e) {
    return { changed: false, reason: `invalid JSON: ${(e as Error).message}` };
  }

  // Walk the envPath, returning early if any segment is missing.
  let node: any = cfg;
  for (let i = 0; i < target.envPath.length - 1; i++) {
    if (!node || typeof node !== 'object') return { changed: false, reason: 'recall-memory entry absent' };
    node = node[target.envPath[i]];
  }
  if (!node || typeof node !== 'object') return { changed: false, reason: 'recall-memory entry absent' };

  const envKey = target.envPath[target.envPath.length - 1];
  node[envKey] = node[envKey] || {};
  const env = node[envKey];
  const existing = env.RECALL_DB_PATH;
  if (existing === newDbPath) return { changed: false, reason: 'already up-to-date' };

  if (dryRun) return { changed: true, reason: `would set RECALL_DB_PATH=${newDbPath}` };

  env.RECALL_DB_PATH = newDbPath;
  // Drop legacy MEM_DB_PATH if present so we don't leave a conflicting value.
  if ('MEM_DB_PATH' in env) delete env.MEM_DB_PATH;
  writeFileSync(target.path, JSON.stringify(cfg, null, 2));
  return { changed: true };
}

export function runMigrate(opts: MigrateOptions): void {
  if (!opts.to || opts.to.trim() === '') {
    console.error('Error: --to <path> is required');
    process.exit(2);
  }

  const dryRun = !!opts.dryRun;
  const src = resolve(getDbPath());
  const dest = resolve(expandHome(opts.to));

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

  if (existsSync(dest)) {
    const st = statSync(dest);
    if (st.size > 0) {
      console.error(`Error: destination already exists and is non-empty: ${dest}`);
      console.error('Refusing to overwrite. Delete the file or choose a different path.');
      process.exit(1);
    }
  }

  // Refuse to migrate if the source DB is open. lsof's absence on the host
  // is treated as "probably safe" — best-effort check.
  if (isOpen(src)) {
    console.error(`Error: source database is currently open: ${src}`);
    console.error('Stop recall-mcp (`pkill -f recall-mcp`) and any active `recall` CLI, then retry.');
    process.exit(1);
  }

  // Close our own connection before moving the file.
  closeDb();

  // Build the pre-migrate snapshot path under the install root.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_').replace(/-/g, '');
  const snapshotDir = join(homedir(), '.agents', 'Recall', 'backups', stamp, 'pre-migrate');

  console.log('Plan:');
  console.log(`  1. snapshot source + configs to ${snapshotDir}`);
  console.log(`  2. move ${src} → ${dest}`);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(src + ext)) console.log(`  3. move ${src + ext} → ${dest + ext}`);
  }
  const targets = detectConfigs();
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
  for (const ext of ['-wal', '-shm']) {
    if (isSidecar(ext) && existsSync(src + ext)) {
      copyFileSync(src + ext, join(snapshotDir, `source.db${ext}`));
    }
  }
  for (const t of targets) {
    if (!existsSync(t.path)) continue;
    const rel = t.path.startsWith(homedir() + '/') ? t.path.slice(homedir().length + 1) : t.path.replace(/^\//, '');
    const outFile = join(snapshotDir, rel);
    mkdirSync(dirname(outFile), { recursive: true });
    copyFileSync(t.path, outFile);
  }
  console.log(`✓ Snapshot: ${snapshotDir}`);

  // 2. Move DB + sidecars.
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  for (const ext of ['-wal', '-shm']) {
    if (isSidecar(ext) && existsSync(src + ext)) {
      renameSync(src + ext, dest + ext);
    }
  }
  // If destination existed as an empty file (we allowed that above), nothing
  // to clean up — renameSync replaced it.
  console.log(`✓ Moved DB: ${dest}`);

  // 3. Patch configs.
  for (const t of targets) {
    const res = patchConfigEnv(t, dest, false);
    if (res.changed) {
      console.log(`✓ Patched ${t.path}`);
    } else if (res.reason && res.reason !== 'not present') {
      console.log(`  Skipped ${t.path} (${res.reason})`);
    }
  }

  console.log('');
  console.log('Migration complete.');
  console.log('Restart Claude Code / OpenCode / Pi so their MCP servers reload with the new path.');

  // Hint: if MEM_DB_PATH is still set in the shell, warn the user that it'd
  // be ignored on next session since RECALL_DB_PATH takes precedence.
  if (process.env.MEM_DB_PATH && !process.env.RECALL_DB_PATH) {
    console.log('');
    console.log(`Note: MEM_DB_PATH=${process.env.MEM_DB_PATH} is still set in this shell.`);
    console.log('It will be ignored when RECALL_DB_PATH is set elsewhere; consider unsetting it.');
  }

  // If our process leaked into a stale connection during the run, reset.
  try { unlinkSync(dest + '-journal'); } catch { /* nothing to clean */ }
}
