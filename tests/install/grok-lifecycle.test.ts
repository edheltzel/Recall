import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const installLib = join(repoRoot, 'lib', 'install-lib.sh');
let tempRoot = '';
let home = '';
let recallDir = '';
let grokDir = '';
let backupDir = '';

function helper(name: string) {
  return spawnSync('bash', ['-c', `source ${JSON.stringify(installLib)}; ${name}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      RECALL_REPO_DIR: repoRoot,
      RECALL_DIR: recallDir,
      GROK_CONFIG_DIR: grokDir,
      BACKUP_DIR: backupDir,
      NO_COLOR: '1',
    },
  });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'recall-grok-install-'));
  home = join(tempRoot, 'home');
  recallDir = join(home, '.agents', 'Recall');
  grokDir = join(home, '.grok');
  backupDir = join(recallDir, 'backups', 'test');
  mkdirSync(join(grokDir, 'hooks'), { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('Grok lifecycle hook ownership', () => {
  test('install, update, and uninstall delegate to the shared lifecycle helpers', () => {
    const install = readFileSync(join(repoRoot, 'install.sh'), 'utf-8');
    const update = readFileSync(join(repoRoot, 'update.sh'), 'utf-8');
    const uninstall = readFileSync(join(repoRoot, 'uninstall.sh'), 'utf-8');

    expect(install).toContain('recall_install_grok_platform');
    expect(update).toContain('recall_install_grok_platform');
    expect(uninstall).toContain('recall_uninstall_grok_platform');
    expect(uninstall).toContain('--skip-grok');
  });

  test('installs one managed global hook with capture events and no injection claim', () => {
    const result = helper('recall_install_grok_platform');
    expect(result.status).toBe(0);

    const target = join(grokDir, 'hooks', 'RecallLifecycle.json');
    const canonical = join(recallDir, 'grok', 'hooks', 'RecallLifecycle.json');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(canonical);

    const config = JSON.parse(readFileSync(canonical, 'utf-8'));
    expect(Object.keys(config.hooks).sort()).toEqual([
      'PostCompact',
      'PreCompact',
      'SessionEnd',
      'Stop',
    ]);
    expect(config.hooks.SessionStart).toBeUndefined();
    for (const groups of Object.values(config.hooks) as any[]) {
      expect(groups[0].hooks[0].command).toBe('recall host-hook grok');
    }

    const second = helper('recall_install_grok_platform');
    expect(second.status).toBe(0);
    expect(readlinkSync(target)).toBe(canonical);
  });

  test('backs up a foreign collision and removes only the managed symlink', () => {
    const target = join(grokDir, 'hooks', 'RecallLifecycle.json');
    writeFileSync(target, '{"user":"owned"}\n');

    expect(helper('recall_install_grok_platform').status).toBe(0);
    const backup = join(backupDir, 'collisions', '.grok', 'hooks', 'RecallLifecycle.json');
    expect(readFileSync(backup, 'utf-8')).toBe('{"user":"owned"}\n');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);

    expect(helper('recall_uninstall_grok_platform').status).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(backup)).toBe(true);
  });

  test('uninstall preserves a foreign file at the owned path', () => {
    const target = join(grokDir, 'hooks', 'RecallLifecycle.json');
    writeFileSync(target, '{"foreign":true}\n');
    expect(helper('recall_uninstall_grok_platform').status).toBe(0);
    expect(readFileSync(target, 'utf-8')).toBe('{"foreign":true}\n');
  });
});
