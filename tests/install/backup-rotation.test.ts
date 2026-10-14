import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO = join(import.meta.dir, '..', '..');
const STAMPS = ['20260101_000001', '20260101_000002', '20260101_000003', '20260101_000004'];

describe('backup rotation', () => {
  let root: string;
  let backupBase: string;

  function sh(snippet: string, extraEnv: Record<string, string> = {}) {
    return spawnSync('bash', ['-c', `set -uo pipefail\nsource "$REPO/lib/install-lib.sh" >/dev/null 2>&1\nFILES_TO_BACKUP=("$CLAUDE_DIR/settings.json")\n${snippet}`], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        REPO,
        HOME: root,
        CLAUDE_DIR: join(root, '.claude'),
        RECALL_DIR: join(root, '.agents', 'Recall'),
        BACKUP_BASE: backupBase,
        TIMESTAMP: '20261014_120000',
        NO_COLOR: '1',
        HAS_GUM: 'false',
        ...extraEnv,
      },
    });
  }

  function seedBackup(stamp: string) {
    const dir = join(backupBase, stamp);
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.txt'), `Timestamp: ${stamp}\n`);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ snapshot: stamp }));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recall-backup-rotation-'));
    backupBase = join(root, 'backups');
    mkdirSync(backupBase, { recursive: true });
    mkdirSync(join(root, '.claude'));
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('keeps the newest 2 full backups plus latest, and leaves non-backups alone', () => {
    for (const stamp of STAMPS) seedBackup(stamp);
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

  test.each(['timestamp', 'latest', 'pre_restore'])('%s restore preserves existing backup history', (mode) => {
    for (const stamp of STAMPS) seedBackup(stamp);
    const undoStamp = 'pre_restore_20261013_120000';
    const selected = mode === 'pre_restore' ? undoStamp : STAMPS[0];
    const restored = JSON.stringify({ snapshot: selected });
    if (mode === 'pre_restore') {
      mkdirSync(join(backupBase, undoStamp));
      writeFileSync(join(backupBase, undoStamp, 'settings.json'), restored);
    }
    const latest = `${mode === 'latest' ? selected : STAMPS[3]}\n`;
    writeFileSync(join(backupBase, 'latest'), latest);
    const current = '{"current":true}';
    writeFileSync(join(root, '.claude', 'settings.json'), current);
    const namesBefore = readdirSync(backupBase);

    const result = sh('_confirm() { return 0; }\nrecall_do_restore "$RESTORE_TARGET"', {
      RESTORE_TARGET: mode === 'latest' ? '' : selected,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf-8')).toBe(restored);
    const preRestore = 'pre_restore_20261014_120000';
    expect(readFileSync(join(backupBase, preRestore, 'settings.json'), 'utf-8')).toBe(current);
    expect(readdirSync(backupBase).sort()).toEqual([...namesBefore, preRestore].sort());
    for (const stamp of STAMPS) {
      expect(readFileSync(join(backupBase, stamp, 'manifest.txt'), 'utf-8')).toBe(`Timestamp: ${stamp}\n`);
      expect(readFileSync(join(backupBase, stamp, 'settings.json'), 'utf-8')).toBe(JSON.stringify({ snapshot: stamp }));
    }
    expect(readFileSync(join(backupBase, 'latest'), 'utf-8')).toBe(latest);
  });

  test('creating a full backup rotates older full backups', () => {
    for (const stamp of STAMPS.slice(0, 3)) seedBackup(stamp);
    const current = '{"current":true}';
    writeFileSync(join(root, '.claude', 'settings.json'), current);

    const result = sh('git() { return 1; }\nrecall_create_backup', {
      TIMESTAMP: STAMPS[3],
      BACKUP_DIR: join(backupBase, STAMPS[3]),
    });

    expect(result.status).toBe(0);
    expect(readdirSync(backupBase).sort()).toEqual([STAMPS[2], STAMPS[3], 'latest']);
    expect(readFileSync(join(backupBase, STAMPS[3], 'settings.json'), 'utf-8')).toBe(current);
    expect(readFileSync(join(backupBase, 'latest'), 'utf-8')).toBe(`${STAMPS[3]}\n`);
  });
});
