// recall path — print resolved file paths Recall uses on this machine.
//
// Useful for diagnostics (especially when symlinks, MEM_DB_PATH, and
// RECALL_DB_PATH are interacting in unexpected ways) and for scripts that
// want to discover the install root.
//
// Usage:
//   recall path           Human-readable output
//   recall path --json    JSON output for scripting

import { getDbPath } from '../db/connection.js';
import { existsSync, lstatSync, readlinkSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface PathOptions {
  json?: boolean;
}

interface SymlinkInfo {
  path: string;
  exists: boolean;
  is_symlink: boolean;
  target?: string | null;
  target_exists?: boolean;
}

function inspect(path: string): SymlinkInfo {
  const info: SymlinkInfo = { path, exists: false, is_symlink: false };
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return info;
  }
  info.exists = true;
  info.is_symlink = st.isSymbolicLink();
  if (info.is_symlink) {
    try {
      info.target = readlinkSync(path);
      info.target_exists = existsSync(path); // follows the symlink
    } catch {
      info.target = null;
      info.target_exists = false;
    }
  }
  return info;
}

function activeDbEnvVar(): string {
  if (process.env.RECALL_DB_PATH) return 'RECALL_DB_PATH';
  if (process.env.MEM_DB_PATH) return 'MEM_DB_PATH (deprecated)';
  return '(default — no env override)';
}

function dbSizeMb(path: string): number | null {
  try {
    const st = statSync(path);
    return Math.round((st.size / (1024 * 1024)) * 100) / 100;
  } catch {
    return null;
  }
}

export function runPath(opts: PathOptions): void {
  const home = homedir();
  const installRoot = join(home, '.agents', 'Recall');
  const dbPath = getDbPath();
  const dbSize = dbSizeMb(dbPath);
  const envVar = activeDbEnvVar();

  // Symlink targets we expect under each platform home. Each entry is the
  // (target path, canonical path) pair so we can report drift.
  const symlinks: Array<{ name: string; from: string; to: string; info: SymlinkInfo }> = [];
  const candidates: Array<[string, string, string]> = [
    ['claude_guide',     join(home, '.claude', 'Recall_GUIDE.md'),                 join(installRoot, 'claude', 'Recall_GUIDE.md')],
    ['claude_extract_prompt', join(home, '.claude', 'MEMORY', 'extract_prompt.md'), join(installRoot, 'shared', 'extract_prompt.md')],
    ['claude_identity',  join(home, '.claude', 'MEMORY', 'identity.md'),            join(installRoot, 'MEMORY', 'identity.md')],
    ['opencode_guide',   join(home, '.config', 'opencode', 'Recall_GUIDE.md'),      join(installRoot, 'opencode', 'Recall_GUIDE.md')],
    ['pi_guide',         join(home, '.pi', 'agent', 'Recall_GUIDE.md'),             join(installRoot, 'pi', 'Recall_GUIDE.md')],
  ];
  for (const [name, from, to] of candidates) {
    symlinks.push({ name, from, to, info: inspect(from) });
  }

  if (opts.json) {
    const out = {
      db: {
        path: dbPath,
        exists: existsSync(dbPath),
        size_mb: dbSize,
        env_source: envVar,
      },
      install_root: installRoot,
      install_root_exists: existsSync(installRoot),
      symlinks: symlinks.map(s => ({
        name: s.name,
        from: s.from,
        canonical: s.to,
        exists: s.info.exists,
        is_symlink: s.info.is_symlink,
        target: s.info.target ?? null,
        target_resolves: s.info.target_exists ?? false,
        matches_canonical: s.info.is_symlink && s.info.target === s.to,
      })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('Recall paths');
  console.log('============');
  console.log('');
  console.log(`Database:     ${dbPath}`);
  console.log(`  exists:     ${existsSync(dbPath) ? 'yes' : 'no'}`);
  if (dbSize !== null) console.log(`  size:       ${dbSize} MB`);
  console.log(`  resolved:   ${envVar}`);
  console.log('');
  console.log(`Install root: ${installRoot}`);
  console.log(`  exists:     ${existsSync(installRoot) ? 'yes' : 'no'}`);
  console.log('');
  console.log('Per-platform symlinks:');
  for (const s of symlinks) {
    const fromShort = s.from.replace(home, '~');
    const toShort = s.to.replace(home, '~');
    let status: string;
    if (!s.info.exists) {
      status = 'missing';
    } else if (!s.info.is_symlink) {
      status = 'regular file (not symlinked)';
    } else if (s.info.target !== s.to) {
      status = `symlink → ${s.info.target} (drift; expected ${toShort})`;
    } else if (!s.info.target_exists) {
      status = 'dangling symlink (target missing)';
    } else {
      status = `→ ${toShort}`;
    }
    console.log(`  ${fromShort}`);
    console.log(`    ${status}`);
  }
}
