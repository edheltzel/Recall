import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { GROK_CAPTURE_COMMAND, grokCaptureFromHook } from '../../hooks/grok/capture';
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
    const install = readFileSync(join(repoRoot, 'packaging', 'install.sh'), 'utf-8');
    const update = readFileSync(join(repoRoot, 'packaging', 'update.sh'), 'utf-8');
    const uninstall = readFileSync(join(repoRoot, 'packaging', 'uninstall.sh'), 'utf-8');

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
    for (const group of Object.values(config.hooks)) {
      if (!Array.isArray(group)) continue;
      const hook = group[0]?.hooks?.[0];
      expect(hook?.command).toBe(GROK_CAPTURE_COMMAND);
      expect(hook?.timeout).toBe(90);
    }
    expect(existsSync(join(recallDir, 'grok', 'hooks', 'capture.ts'))).toBe(true);

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

describe('Grok capture adapter', () => {
  test('Stop exports session text and maps SessionEnd to session_end', () => {
    const stop = grokCaptureFromHook(
      { hookEventName: 'Stop', sessionId: 'grok-1', workspaceRoot: '/work/Recall' },
      () => '# export\n\nRemember the amber dock.\n',
    );
    expect(stop).toEqual({
      event: 'turn_end',
      text: '# export\n\nRemember the amber dock.\n',
      sessionId: 'grok-1',
      cwd: '/work/Recall',
    });
    const end = grokCaptureFromHook(
      { hook_event_name: 'SessionEnd', session_id: 'grok-1' },
      () => 'final text',
    );
    expect(end).toMatchObject({ event: 'session_end', text: 'final text' });
  });

  test('skips subagents, session start, and empty exports', () => {
    expect(grokCaptureFromHook(
      { hookEventName: 'Stop', sessionId: 'child', agent_id: 'child' },
      () => 'should not export',
    )).toEqual({ skipped: 'subagent' });
    expect(grokCaptureFromHook(
      { hookEventName: 'session_start', sessionId: 'grok-1' },
      () => 'no injection',
    )).toEqual({ skipped: 'unsupported-event' });
    expect(grokCaptureFromHook(
      { hookEventName: 'Stop', sessionId: 'grok-1' },
      () => '   ',
    )).toEqual({ skipped: 'empty-export' });
  });
});
