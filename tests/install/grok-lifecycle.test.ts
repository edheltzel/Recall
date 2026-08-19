import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { resolveDbPath, resolveRecallRoot } from '../../hooks/lib/db-path';

const repoRoot = process.cwd();
const installLib = join(repoRoot, 'lib', 'install-lib.sh');
let tempRoot = '';
let home = '';
let recallDir = '';
let grokDir = '';
let backupDir = '';

function helper(name: string, overrides: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `source ${JSON.stringify(installLib)}; ${name}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      RECALL_REPO_DIR: repoRoot,
      RECALL_DIR: recallDir,
      GROK_CONFIG_DIR: grokDir,
      XDG_CONFIG_HOME: join(home, '.config'),
      OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
      BACKUP_DIR: backupDir,
      NO_COLOR: '1',
      RECALL_DB_PATH: '',
      MEM_DB_PATH: '',
      ...overrides,
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
      expect(groups[0].hooks[0].timeout).toBe(90);
    }

    const second = helper('recall_install_grok_platform');
    expect(second.status).toBe(0);
    expect(readlinkSync(target)).toBe(canonical);
  });

  test('uses the shared dynamic database resolver', () => {
    const customDb = `${join(tempRoot, "db path's")}/$(not-shell)/recall.db`;
    expect(helper(
      'recall_create_install_root; recall_persist_db_path "$(recall_resolve_db_path)"; recall_install_grok_platform',
      { RECALL_DB_PATH: customDb }
    ).status).toBe(0);
    expect(readFileSync(join(recallDir, '.db-path'), 'utf-8')).toBe(`${customDb}\n`);
    expect(helper(
      'export RECALL_DB_PATH="$(recall_resolve_db_path)"; recall_install_grok_platform',
      { RECALL_DB_PATH: '', MEM_DB_PATH: '' }
    ).status).toBe(0);
    const canonical = join(recallDir, 'grok', 'hooks', 'RecallLifecycle.json');
    const config = JSON.parse(readFileSync(canonical, 'utf-8'));
    const command = config.hooks.Stop[0].hooks[0].command as string;
    expect(command).toBe('recall host-hook grok');
    const resolved = helper('recall_resolve_db_path');
    expect(resolved.status).toBe(0);
    expect(resolved.stdout.trim()).toBe(customDb);
  });

  test('recovers a pre-state custom path from managed MCP configuration', () => {
    const customDb = join(tempRoot, 'legacy-custom', 'recall.db');
    const claudeDir = join(home, '.claude');
    const openCodeDir = join(home, '.config', 'opencode');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(openCodeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: {
        'recall-memory': { env: { RECALL_DB_PATH: join(recallDir, 'recall.db') } },
      },
    }));
    writeFileSync(join(openCodeDir, 'opencode.json'), `{
      // Existing custom install without .db-path state.
      "mcp": {
        "recall-memory": {
          "environment": { "RECALL_DB_PATH": ${JSON.stringify(customDb)} },
        },
      },
    }`);

    expect(existsSync(join(recallDir, '.db-path'))).toBe(false);
    const resolved = helper('recall_resolve_db_path');
    expect(resolved.status).toBe(0);
    expect(resolved.stdout.trim()).toBe(customDb);
  });

  test('discovers relocated state through the managed default-root link', () => {
    const relocatedRoot = join(tempRoot, 'relocated', 'Recall');
    const defaultRoot = join(home, '.agents', 'Recall');
    const customDb = join(tempRoot, 'custom-db', 'recall.db');
    mkdirSync(relocatedRoot, { recursive: true });
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(join(relocatedRoot, '.db-path'), `${customDb}\n`);
    symlinkSync(relocatedRoot, defaultRoot);
    const env = { HOME: home } as NodeJS.ProcessEnv;

    expect(resolveRecallRoot({ env, home })).toBe(relocatedRoot);
    expect(resolveDbPath({ env, home })).toBe(customDb);
  });

  test('discovers relocated state through the managed Claude guide link', () => {
    const relocatedRoot = join(tempRoot, 'guide-relocated', 'Recall');
    const guide = join(relocatedRoot, 'claude', 'Recall_GUIDE.md');
    const customDb = join(tempRoot, 'guide-custom-db', 'recall.db');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(relocatedRoot, 'claude'), { recursive: true });
    writeFileSync(guide, '# Guide\n');
    writeFileSync(join(relocatedRoot, '.db-path'), `${customDb}\n`);
    symlinkSync(guide, join(home, '.claude', 'Recall_GUIDE.md'));
    const env = { HOME: home } as NodeJS.ProcessEnv;

    expect(resolveRecallRoot({ env, home })).toBe(relocatedRoot);
    expect(resolveDbPath({ env, home })).toBe(customDb);
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
