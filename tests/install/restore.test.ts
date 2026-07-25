import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO = join(import.meta.dir, '..', '..');

/**
 * Installer rollback: `./install.sh restore [TIMESTAMP]`, documented in
 * docs/installation.md, had no coverage at all.
 *
 * `recall_do_restore` gates on `_confirm "Proceed with restore?" "N"`, and
 * `_confirm` returns the default when stdin is not a TTY — so restore is a
 * deliberate no-op in automation. To exercise the restoring path without
 * changing that safety default, these tests override `_confirm` in the sourced
 * shell, which is the ordinary seam for a bash function. The non-interactive
 * default is asserted separately, because "declines and changes nothing" is
 * itself the contract CI and scripts depend on.
 */
describe('installer restore (rollback)', () => {
  let root: string;
  let claudeDir: string;
  let recallDir: string;
  let backupBase: string;

  /** Run a bash snippet with install-lib sourced in a fully disposable HOME. */
  function sh(snippet: string, extraEnv: Record<string, string> = {}) {
    return spawnSync('bash', ['-c', `set -uo pipefail\nsource "$REPO/lib/install-lib.sh" >/dev/null 2>&1\n${snippet}`], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        REPO,
        HOME: root,
        CLAUDE_DIR: claudeDir,
        RECALL_DIR: recallDir,
        BACKUP_BASE: backupBase,
        RECALL_REPO_DIR: REPO,
        NO_CONFIRM: 'true',
        HAS_GUM: 'false',
        ...extraEnv,
      },
    });
  }

  /** Seed a backup snapshot as `recall_create_backup` would have written it. */
  function seedBackup(stamp: string, files: Record<string, string>, markLatest = true) {
    const dir = join(backupBase, stamp);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    writeFileSync(join(dir, 'manifest.txt'), `seeded ${stamp}\n`);
    if (markLatest) writeFileSync(join(backupBase, 'latest'), stamp);
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recall-restore-'));
    claudeDir = join(root, '.claude');
    recallDir = join(root, '.agents', 'Recall');
    backupBase = join(recallDir, 'backups');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(backupBase, { recursive: true });
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('restores the latest snapshot over the current files', () => {
    writeFileSync(join(claudeDir, 'settings.json'), '{"current":true}');
    writeFileSync(join(claudeDir, '.mcp.json'), '{"mcpServers":{"drifted":{}}}');
    seedBackup('20260101120000', {
      'settings.json': '{"restored":true}',
      '.mcp.json': '{"mcpServers":{"original":{}}}',
    });

    const result = sh('_confirm() { return 0; }\nrecall_do_restore ""');

    expect(result.status).toBe(0);
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe('{"restored":true}');
    expect(readFileSync(join(claudeDir, '.mcp.json'), 'utf-8')).toBe('{"mcpServers":{"original":{}}}');
  });

  test('snapshots the pre-restore state so a restore is itself reversible', () => {
    writeFileSync(join(claudeDir, 'settings.json'), '{"about-to-be-replaced":true}');
    seedBackup('20260101120000', { 'settings.json': '{"restored":true}' });

    const result = sh('_confirm() { return 0; }\nrecall_do_restore ""');
    expect(result.status).toBe(0);

    const preRestore = readdirSync(backupBase).filter(d => d.startsWith('pre_restore_'));
    expect(preRestore).toHaveLength(1);
    expect(readFileSync(join(backupBase, preRestore[0], 'settings.json'), 'utf-8'))
      .toBe('{"about-to-be-replaced":true}');
  });

  test('restores a specific timestamp rather than the latest', () => {
    seedBackup('20260101120000', { 'settings.json': '{"older":true}' }, false);
    seedBackup('20260202120000', { 'settings.json': '{"newer":true}' });

    const result = sh('_confirm() { return 0; }\nrecall_do_restore "20260101120000"');

    expect(result.status).toBe(0);
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe('{"older":true}');
  });

  test('an unknown timestamp fails without touching current files', () => {
    writeFileSync(join(claudeDir, 'settings.json'), '{"untouched":true}');
    seedBackup('20260101120000', { 'settings.json': '{"restored":true}' });

    const result = sh('_confirm() { return 0; }\nrecall_do_restore "20990101000000"');

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe('{"untouched":true}');
  });

  test('restore with no backups at all fails instead of reporting success', () => {
    const result = sh('_confirm() { return 0; }\nrecall_do_restore ""');

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('No backups found');
  });

  test('a non-interactive restore declines and changes nothing', () => {
    writeFileSync(join(claudeDir, 'settings.json'), '{"current":true}');
    seedBackup('20260101120000', { 'settings.json': '{"restored":true}' });

    // No _confirm override: this is exactly what CI or a script would hit.
    const result = sh('recall_do_restore ""');

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Restore cancelled');
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe('{"current":true}');
    expect(readdirSync(backupBase).filter(d => d.startsWith('pre_restore_'))).toHaveLength(0);
  });
});

/**
 * The other half of rollback: a user file sitting where Recall wants a symlink
 * must survive install as recoverable bytes, not be overwritten in place.
 */
describe('installer collision backup', () => {
  let root: string;
  let recallDir: string;
  let backupDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recall-collision-'));
    recallDir = join(root, '.agents', 'Recall');
    backupDir = join(recallDir, 'backups', 'testrun');
    mkdirSync(recallDir, { recursive: true });
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function sh(snippet: string) {
    return spawnSync('bash', ['-c', `set -uo pipefail\nsource "$REPO/lib/install-lib.sh" >/dev/null 2>&1\n${snippet}`], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        REPO,
        HOME: root,
        RECALL_DIR: recallDir,
        BACKUP_DIR: backupDir,
        RECALL_REPO_DIR: REPO,
        NO_CONFIRM: 'true',
        HAS_GUM: 'false',
      },
    });
  }

  test('a drifted user file is preserved byte-for-byte before being symlinked', () => {
    const canonical = join(recallDir, 'canonical.ts');
    writeFileSync(canonical, 'canonical body\n');
    const target = join(root, 'userland', 'canonical.ts');
    mkdirSync(join(root, 'userland'), { recursive: true });
    const userBody = 'the user hand-edited this and it must not vanish\n';
    writeFileSync(target, userBody);

    const result = sh(`recall_link "${target}" "${canonical}"`);
    expect(result.status).toBe(0);

    // Target is now Recall's symlink...
    expect(readFileSync(target, 'utf-8')).toBe('canonical body\n');
    // ...and the user's original bytes are recoverable from the backup tree.
    const preserved = join(backupDir, 'collisions', 'userland', 'canonical.ts');
    expect(existsSync(preserved)).toBe(true);
    expect(readFileSync(preserved, 'utf-8')).toBe(userBody);
  });

  test('a file identical to the canonical is replaced without a needless backup', () => {
    const canonical = join(recallDir, 'canonical.ts');
    writeFileSync(canonical, 'same body\n');
    const target = join(root, 'userland', 'same.ts');
    mkdirSync(join(root, 'userland'), { recursive: true });
    writeFileSync(target, 'same body\n');

    const result = sh(`recall_link "${target}" "${canonical}"`);
    expect(result.status).toBe(0);
    expect(existsSync(join(backupDir, 'collisions', 'userland', 'same.ts'))).toBe(false);
  });
});
