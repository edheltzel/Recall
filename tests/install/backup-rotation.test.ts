import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO = join(import.meta.dir, '..', '..');

describe('backup rotation', () => {
  let root: string;
  let backupBase: string;

  function sh(snippet: string) {
    return spawnSync('bash', ['-c', `set -uo pipefail\nsource "$REPO/lib/install-lib.sh" >/dev/null 2>&1\n${snippet}`], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        REPO,
        HOME: root,
        BACKUP_BASE: backupBase,
        NO_COLOR: '1',
        HAS_GUM: 'false',
      },
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recall-backup-rotation-'));
    backupBase = join(root, 'backups');
    mkdirSync(backupBase, { recursive: true });
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('keeps the newest 2 full backups plus latest, and leaves non-backups alone', () => {
    const stamps = ['20260101_000001', '20260101_000002', '20260101_000003', '20260101_000004'];
    for (const stamp of stamps) {
      const dir = join(backupBase, stamp);
      mkdirSync(dir);
      writeFileSync(join(dir, 'manifest.txt'), `Timestamp: ${stamp}\n`);
    }
    writeFileSync(join(backupBase, 'latest'), '20260101_000001\n');
    writeFileSync(join(backupBase, 'loose.txt'), 'keep\n');
    const migrateDir = join(backupBase, '20250101_000000', 'pre-migrate');
    mkdirSync(migrateDir, { recursive: true });
    writeFileSync(join(migrateDir, 'source.db'), 'migrated\n');

    const result = sh('recall_prune_backups');
    expect(result.status).toBe(0);

    const names = readdirSync(backupBase).sort();
    expect(names).toEqual([
      '20250101_000000',
      '20260101_000001',
      '20260101_000003',
      '20260101_000004',
      'latest',
      'loose.txt',
    ]);
    expect(existsSync(join(backupBase, '20260101_000002'))).toBe(false);
    expect(existsSync(join(migrateDir, 'source.db'))).toBe(true);
    expect(readFileSync(join(backupBase, 'loose.txt'), 'utf-8')).toBe('keep\n');
    expect(readFileSync(join(backupBase, 'latest'), 'utf-8')).toBe('20260101_000001\n');
  });
});
