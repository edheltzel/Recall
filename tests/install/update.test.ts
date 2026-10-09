// update.sh: version check, dry-run, rollback recipe emission.
//
// The script shells out to git/gh/curl and `recall`. Tests here exercise the
// orchestration logic that does NOT require network or a real release —
// --check in the current repo's state and --dry-run against a scratch tree.
//
// Destructive paths (git pull, bun install, recall init) are validated only
// via --dry-run narration so we never mutate the working tree.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const UPDATE = join(REPO, 'packaging', 'update.sh');

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [UPDATE, ...args], {
    encoding: 'utf-8',
    cwd: REPO,
    env: { ...process.env, ...env },
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? 1,
  };
}

function refreshRuntimeDriver(tempRoot: string, claudeDir: string, setup = '') {
  return [
    'set -e',
    `export HOME="${tempRoot}"`,
    `export CLAUDE_DIR="${claudeDir}"`,
    `export RECALL_DIR="${join(tempRoot, '.agents', 'Recall')}"`,
    'source "$REPO/packaging/update.sh"',
    'log_info() { :; }',
    'log_success() { :; }',
    'log_warn() { :; }',
    'log_error() { :; }',
    'recall_copy_runtime_files() { :; }',
    'recall_configure_claude_md() { :; }',
    'recall_detect_platforms() { :; }',
    'recall_claude_plugin_active() { return 0; }',
    'OPENCODE_DETECTED=false',
    'PI_DETECTED=false',
    'GROK_DETECTED=false',
    'OMP_DETECTED=false',
    'DRY_RUN=false',
    setup,
    'step_refresh_runtime',
  ].join('\n');
}

describe('update.sh', () => {
  test('--check prints current + latest and exits 0 when current', () => {
    const r = run(['--check']);
    // Status 0 either because we're current OR because the fetch failed
    // gracefully. Either way --check must NOT mutate, so an 0 exit is fine.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Current:');
  });

  test('--check survives gum being unavailable (CI runners have no gum)', () => {
    // Regression: _try_install_gum returned 1 after exhausting install paths,
    // which killed update.sh under `set -e` + ERR trap before --check ran.
    // Simulate a gum-less runner: local gum is "too old" via the min-version
    // floor, and stub curl/brew so every install path fails fast.
    const stubDir = mkdtempSync(join(tmpdir(), 'recall-no-gum-'));
    try {
      writeFileSync(join(stubDir, 'curl'), '#!/bin/bash\nexit 22\n', { mode: 0o755 });
      writeFileSync(join(stubDir, 'brew'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
      const r = run(['--check'], {
        PATH: `${stubDir}:${process.env.PATH}`,
        RECALL_GUM_MIN_MAJOR: '99',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Current:');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test('--help prints usage without mutating', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--check');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('--force');
    expect(r.stdout).toContain('--no-migrate');
  });

  test('unknown flag errors out', () => {
    const r = run(['--nope']);
    expect(r.status).not.toBe(0);
    // The error goes to stderr via log_error
    expect(r.stderr + r.stdout).toMatch(/Unknown flag/);
  });

  test('syntax check passes', () => {
    const r = spawnSync('bash', ['-n', UPDATE], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
  });

  test('legacy CLI bin cleanup removes only Recall-managed symlinks', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-bin-cleanup-'));
    try {
      const fakeRepo = join(tempRoot, 'repo');
      const distDir = join(fakeRepo, 'dist');
      const bunBin = join(tempRoot, '.bun', 'bin');
      const foreignDir = join(tempRoot, 'foreign');
      mkdirSync(distDir, { recursive: true });
      mkdirSync(bunBin, { recursive: true });
      mkdirSync(foreignDir, { recursive: true });
      writeFileSync(join(distDir, 'index.js'), '#!/usr/bin/env bun\n');
      writeFileSync(join(foreignDir, 'mcp-server.js'), '#!/usr/bin/env bun\n');
      symlinkSync(join(distDir, 'index.js'), join(bunBin, 'mem'));
      symlinkSync(join(foreignDir, 'mcp-server.js'), join(bunBin, 'mem-mcp'));

      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export RECALL_REPO_DIR="${fakeRepo}"`,
        'log_success() { :; }',
        'log_warn() { :; }',
        'source "$REPO/lib/install-lib.sh"',
        'recall_cleanup_legacy_bins',
      ].join('\n');
      const r = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO },
      });

      expect(r.status).toBe(0);
      expect(existsSync(join(bunBin, 'mem'))).toBe(false);
      expect(existsSync(join(bunBin, 'mem-mcp'))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Claude MCP refresh rewrites legacy server path and preserves custom env', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-mcp-refresh-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settingsFile, JSON.stringify({
        mcpServers: {
          'recall-memory': {
            command: 'bun',
            args: ['run', '/old/path/mem-mcp'],
            env: { MEM_DB_PATH: '/old/db', MY_CUSTOM_VAR: 'keep-me' },
          },
        },
      }, null, 2));

      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        'log_success() { :; }',
        'source "$REPO/lib/install-lib.sh"',
        '_recall_reconcile_claude_mcp user "/bin/bun" "/new/path/recall-mcp"',
      ].join('\n');
      const r = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO, RECALL_DB_PATH: '/new/db' },
      });

      expect(r.status).toBe(0);
      const after = JSON.parse(readFileSync(settingsFile, 'utf-8')) as {
        mcpServers: { 'recall-memory': { command: string; args: string[]; env: Record<string, string> } };
      };
      const entry = after.mcpServers['recall-memory'];
      expect(entry.command).toBe('/bin/bun');
      expect(entry.args).toEqual(['run', '/new/path/recall-mcp']);
      expect(entry.env.RECALL_DB_PATH).toBe('/new/db');
      expect(entry.env.MEM_DB_PATH).toBeUndefined();
      expect(entry.env.MY_CUSTOM_VAR).toBe('keep-me');
      const backups = join(tempRoot, '.agents', 'Recall', 'backups');
      expect(existsSync(backups)).toBe(true);
      const saved = readFileSync(join(backups, readdirSync(backups).find(name => name !== 'latest') ?? '', 'settings.json'), 'utf-8');
      expect(saved).toContain('/old/path/mem-mcp');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('update refresh preserves and repairs a stored custom Claude MCP registration', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-mcp-custom-pin-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      const stored = '/stored/custom.db';
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settingsFile, JSON.stringify({
        mcpServers: {
          'recall-memory': {
            command: 'bun',
            args: ['run', '/old/path/recall-mcp'],
            env: { RECALL_DB_PATH: '', MEM_DB_PATH: stored },
          },
        },
      }));

      const driver = refreshRuntimeDriver(
        tempRoot,
        claudeDir,
        'which() { if [[ "$1" == "recall-mcp" ]]; then echo "/new/path/recall-mcp"; else command -v "$1"; fi; }',
      );
      const {
        RECALL_DB_PATH: _recallDbPath,
        MEM_DB_PATH: _memDbPath,
        ...baseEnv
      } = process.env;
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...baseEnv, REPO },
      });

      expect(result.status).toBe(0);
      const entry = JSON.parse(readFileSync(settingsFile, 'utf-8')).mcpServers['recall-memory'];
      expect(entry.command).not.toBe('bun');
      expect(entry.args).toEqual(['run', '/new/path/recall-mcp']);
      expect(entry.env).toEqual({ RECALL_DB_PATH: stored });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('active Claude plugin persists a fresh explicit custom DB path', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-plugin-mcp-fresh-custom-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      const customDb = '/fresh/custom.db';
      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        `export RECALL_DIR="${join(tempRoot, '.agents', 'Recall')}"`,
        'source "$REPO/lib/install-lib.sh"',
        'recall_claude_plugin_active() { return 0; }',
        'recall_configure_mcp',
      ].join('\n');
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO, RECALL_DB_PATH: customDb },
      });

      expect(result.status).toBe(0);
      const entry = JSON.parse(readFileSync(settingsFile, 'utf-8')).mcpServers['recall-memory'];
      expect(entry.env).toEqual({ RECALL_DB_PATH: customDb });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Claude MCP configuration reuses a legacy custom owner without adding settings', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-mcp-legacy-owner-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const legacyFile = join(tempRoot, '.claude.json');
      const settingsFile = join(claudeDir, 'settings.json');
      const stored = '/stored/custom.db';
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(legacyFile, JSON.stringify({
        mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: stored } } },
      }));
      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        `export RECALL_DIR="${join(tempRoot, '.agents', 'Recall')}"`,
        'source "$REPO/lib/install-lib.sh"',
        'recall_claude_plugin_active() { return 1; }',
        'command() { if [[ "$1" == "-v" && "$2" == "claude" ]]; then return 1; fi; builtin command "$@"; }',
        'recall_configure_mcp',
      ].join('\n');
      const {
        RECALL_DB_PATH: _recallDbPath,
        MEM_DB_PATH: _memDbPath,
        ...baseEnv
      } = process.env;
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...baseEnv, REPO },
      });

      expect(result.status).toBe(0);
      const entry = JSON.parse(readFileSync(legacyFile, 'utf-8')).mcpServers['recall-memory'];
      expect(entry.env).toEqual({ RECALL_DB_PATH: stored });
      expect(existsSync(settingsFile)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('conflicting Claude MCP owners require an explicit path before convergence', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-mcp-conflict-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const legacyFile = join(tempRoot, '.claude.json');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      const legacyOriginal = JSON.stringify({
        mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: '/one.db' } } },
      });
      const settingsOriginal = JSON.stringify({
        mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: '/two.db' } } },
      });
      writeFileSync(legacyFile, legacyOriginal);
      writeFileSync(settingsFile, settingsOriginal);
      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        `export RECALL_DIR="${join(tempRoot, '.agents', 'Recall')}"`,
        'source "$REPO/lib/install-lib.sh"',
        'recall_claude_plugin_active() { return 0; }',
        'recall_configure_mcp',
      ].join('\n');
      const {
        RECALL_DB_PATH: _recallDbPath,
        MEM_DB_PATH: _memDbPath,
        ...baseEnv
      } = process.env;
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...baseEnv, REPO },
      });

      expect(result.status).toBe(3);
      expect(readFileSync(legacyFile, 'utf-8')).toBe(legacyOriginal);
      expect(readFileSync(settingsFile, 'utf-8')).toBe(settingsOriginal);

      const selected = '/selected.db';
      const converged = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...baseEnv, REPO, RECALL_DB_PATH: selected },
      });
      expect(converged.status).toBe(0);
      for (const path of [legacyFile, settingsFile]) {
        const entry = JSON.parse(readFileSync(path, 'utf-8')).mcpServers['recall-memory'];
        expect(entry.env).toEqual({ RECALL_DB_PATH: selected });
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Claude MCP reconciliation reports a failed second owner write as partial', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-mcp-partial-write-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const legacyFile = join(tempRoot, '.claude.json');
      const settingsFile = join(claudeDir, 'settings.json');
      const backupDir = join(tempRoot, 'backups');
      mkdirSync(claudeDir, { recursive: true });
      const legacyOriginal = JSON.stringify({
        mcpServers: { 'recall-memory': { command: 'bun', env: { RECALL_DB_PATH: '/old.db' } } },
      });
      const settingsOriginal = JSON.stringify({
        mcpServers: { 'recall-memory': { command: 'bun', env: { RECALL_DB_PATH: '/old.db' } } },
      });
      writeFileSync(legacyFile, legacyOriginal);
      writeFileSync(settingsFile, settingsOriginal);
      mkdirSync(`${settingsFile}.tmp`);

      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        `export BACKUP_DIR="${backupDir}"`,
        'source "$REPO/lib/install-lib.sh"',
        '_recall_reconcile_claude_mcp user "/bin/bun" "/new/path/recall-mcp"',
      ].join('\n');
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO, RECALL_DB_PATH: '/selected.db' },
      });

      expect(result.status).toBe(4);
      const legacyEntry = JSON.parse(readFileSync(legacyFile, 'utf-8')).mcpServers['recall-memory'];
      expect(legacyEntry.env.RECALL_DB_PATH).toBe('/selected.db');
      expect(readFileSync(settingsFile, 'utf-8')).toBe(settingsOriginal);
      expect(readFileSync(join(backupDir, '.claude.json'), 'utf-8')).toBe(legacyOriginal);
      expect(readFileSync(join(backupDir, 'settings.json'), 'utf-8')).toBe(settingsOriginal);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain('refusing to replace non-file temporary path');
      expect(output).toContain('config may be partially updated');
      expect(output).toContain(`Restore the Claude config backups from ${backupDir}, then rerun the command`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('symlinked settings.json is written through the link, with backup and no temp file', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-mcp-symlink-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const realDir = join(tempRoot, 'dotfiles');
      const realFile = join(realDir, 'settings.json');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });
      writeFileSync(realFile, JSON.stringify({
        mcpServers: { 'recall-memory': { command: 'bun', args: ['run', '/old/path/mem-mcp'], env: {} } },
      }));
      symlinkSync(realFile, settingsFile);

      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        'log_success() { :; }',
        'source "$REPO/lib/install-lib.sh"',
        '_recall_reconcile_claude_mcp user "/bin/bun" "/new/path/recall-mcp"',
      ].join('\n');
      const r = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO, RECALL_DB_PATH: '/new/db' },
      });

      expect(r.status).toBe(0);
      expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
      const after = JSON.parse(readFileSync(realFile, 'utf-8')) as {
        mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: string } } };
      };
      expect(after.mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe('/new/db');
      expect(existsSync(`${realFile}.tmp`)).toBe(false);
      expect(existsSync(`${settingsFile}.tmp`)).toBe(false);
      const backups = join(tempRoot, '.agents', 'Recall', 'backups');
      const stamp = readdirSync(backups).find(name => name !== 'latest') ?? '';
      expect(readFileSync(join(backups, stamp, 'settings.json'), 'utf-8')).toContain('/old/path/mem-mcp');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('MCP and hook registration fail closed on a dangling settings symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-settings-dangling-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const targetDir = join(tempRoot, 'dotfiles');
      const target = join(targetDir, 'settings.json');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });
      symlinkSync(target, settingsFile);

      const commands = [
        ['recall_claude_plugin_active() { return 0; }', 'recall_configure_mcp'],
        ['', 'recall_register_hook "Stop" "RecallExtract" "/bin/bun run RecallExtract.ts"'],
      ];
      for (const [setup, command] of commands) {
        const driver = [
          'set -e',
          `export HOME="${tempRoot}"`,
          `export CLAUDE_DIR="${claudeDir}"`,
          `export RECALL_DIR="${join(tempRoot, '.agents', 'Recall')}"`,
          'log_success() { :; }',
          'log_warn() { :; }',
          'log_error() { :; }',
          'source "$REPO/lib/install-lib.sh"',
          setup,
          command,
        ].join('\n');
        const result = spawnSync('bash', ['-c', driver], {
          encoding: 'utf-8',
          cwd: REPO,
          env: { ...process.env, REPO, RECALL_DB_PATH: '/custom/recall.db' },
        });

        expect(result.status).not.toBe(0);
        expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
        expect(existsSync(target)).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('update refresh removes the default Claude MCP registration through a settings symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-plugin-mcp-symlink-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const realDir = join(tempRoot, 'dotfiles');
      const realFile = join(realDir, 'settings.json');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });
      writeFileSync(realFile, JSON.stringify({
        mcpServers: { 'recall-memory': { command: 'recall-mcp' } },
      }));
      symlinkSync(realFile, settingsFile);

      const driver = refreshRuntimeDriver(tempRoot, claudeDir);
      const {
        RECALL_DB_PATH: _recallDbPath,
        MEM_DB_PATH: _memDbPath,
        ...baseEnv
      } = process.env;
      const r = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...baseEnv, REPO },
      });

      expect(r.status).toBe(0);
      expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(realFile, 'utf-8'))).toEqual({});
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Claude plugin reconciliation distinguishes invalid config from a custom DB pin', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-plugin-mcp-invalid-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      const original = '{"mcpServers":{"recall-memory":{}},"permissions":{},"permissions":{}}';
      writeFileSync(settingsFile, original);
      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        `export RECALL_DIR="${join(tempRoot, '.agents', 'Recall')}"`,
        'source "$REPO/lib/install-lib.sh"',
        '_recall_reconcile_claude_mcp plugin "/bin/bun" "/new/path/recall-mcp"',
      ].join('\n');
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO },
      });

      expect(result.status).not.toBe(0);
      expect(readFileSync(settingsFile, 'utf-8')).toBe(original);
      expect(`${result.stdout}${result.stderr}`).toContain('existing config is invalid');
      expect(`${result.stdout}${result.stderr}`).not.toContain('pins a custom RECALL_DB_PATH');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('plugin-active install rejects an MCP env array without changing either config', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-plugin-install-env-invalid-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const legacyFile = join(tempRoot, '.claude.json');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
      writeFileSync(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: { 'recall@recall-marketplace': [{ version: '1.0.0' }] } }),
      );
      const legacyOriginal = JSON.stringify({
        permissions: { allow: ['safe'] },
        mcpServers: { 'recall-memory': { env: [] } },
      });
      const settingsOriginal = JSON.stringify({
        permissions: { allow: ['safe'] },
        mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: join(tempRoot, 'custom.db') } } },
      });
      writeFileSync(legacyFile, legacyOriginal);
      writeFileSync(settingsFile, settingsOriginal);
      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        `export RECALL_DIR="${join(tempRoot, '.agents', 'Recall')}"`,
        'source "$REPO/lib/install-lib.sh"',
        'recall_configure_mcp',
      ].join('\n');
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO },
      });

      expect(result.status).not.toBe(0);
      expect(readFileSync(legacyFile, 'utf-8')).toBe(legacyOriginal);
      expect(readFileSync(settingsFile, 'utf-8')).toBe(settingsOriginal);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('plugin-active update rejects a non-string MCP path without changing either config', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-plugin-update-path-invalid-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const legacyFile = join(tempRoot, '.claude.json');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      const legacyOriginal = JSON.stringify({
        permissions: { allow: ['safe'] },
        mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: join(tempRoot, 'custom.db') } } },
      });
      const settingsOriginal = JSON.stringify({
        permissions: { allow: ['safe'] },
        mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: 5 } } },
      });
      writeFileSync(legacyFile, legacyOriginal);
      writeFileSync(settingsFile, settingsOriginal);
      const result = spawnSync('bash', ['-c', refreshRuntimeDriver(tempRoot, claudeDir)], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO },
      });

      expect(result.status).not.toBe(0);
      expect(readFileSync(legacyFile, 'utf-8')).toBe(legacyOriginal);
      expect(readFileSync(settingsFile, 'utf-8')).toBe(settingsOriginal);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('unparseable settings containing the name are not backed up', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-mcp-nobackup-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      const settingsFile = join(claudeDir, 'settings.json');
      const original = '{ recall-memory not json';
      writeFileSync(settingsFile, original);
      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        'log_success() { :; }',
        'source "$REPO/lib/install-lib.sh"',
        '_recall_reconcile_claude_mcp user "/bin/bun" "/new/path/recall-mcp"',
      ].join('\n');
      const r = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO, RECALL_DB_PATH: '/new/db' },
      });
      expect(r.status).not.toBe(0);
      expect(readFileSync(settingsFile, 'utf-8')).toBe(original);
      expect(existsSync(join(tempRoot, '.agents', 'Recall', 'backups'))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Claude settings writers reject duplicate-key JSONC without writing', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-settings-invalid-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      const original = '{"permissions":{"allow":["safe"]},"permissions":{"deny":["secret"]}}';
      const commands = [
        '_recall_reconcile_claude_mcp user "/bin/bun" "/new/path/recall-mcp"',
        'recall_register_hook "Stop" "RecallExtract" "/bin/bun run RecallExtract.ts"',
        'recall_rename_hooks_in_settings',
      ];

      for (const command of commands) {
        writeFileSync(settingsFile, original);
        const driver = [
          'set -e',
          `export HOME="${tempRoot}"`,
          `export CLAUDE_DIR="${claudeDir}"`,
          'log_success() { :; }',
          'log_error() { :; }',
          'source "$REPO/lib/install-lib.sh"',
          command,
        ].join('\n');
        const result = spawnSync('bash', ['-c', driver], {
          encoding: 'utf-8',
          cwd: REPO,
          env: { ...process.env, REPO },
        });

        expect(result.status).not.toBe(0);
        expect(readFileSync(settingsFile, 'utf-8')).toBe(original);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('hook rename rejects invalid nested Claude settings without writing', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-settings-shape-invalid-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      const invalidConfigs = [
        '{"hooks":[[{"hooks":[{"command":"bun run SessionExtract.ts"}]}]],"mcpServers":{}}',
        '{"hooks":{"Stop":{}},"mcpServers":{}}',
        '{"hooks":{"Stop":[{"hooks":[{"command":"bun run SessionExtract.ts"}]}]},"mcpServers":[]}',
      ];

      for (const original of invalidConfigs) {
        writeFileSync(settingsFile, original);
        const driver = [
          'set -e',
          `export HOME="${tempRoot}"`,
          `export CLAUDE_DIR="${claudeDir}"`,
          'log_error() { :; }',
          'source "$REPO/lib/install-lib.sh"',
          'recall_rename_hooks_in_settings',
        ].join('\n');
        const result = spawnSync('bash', ['-c', driver], {
          encoding: 'utf-8',
          cwd: REPO,
          env: { ...process.env, REPO },
        });

        expect(result.status).not.toBe(0);
        expect(readFileSync(settingsFile, 'utf-8')).toBe(original);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Claude settings writers reject an invalid Recall MCP entry without writing', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-settings-entry-invalid-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      const original = '{"mcpServers":{"recall-memory":[]}}';
      mkdirSync(claudeDir, { recursive: true });
      const commands = [
        '_recall_reconcile_claude_mcp user "/bin/bun" "/new/path/recall-mcp"',
        'recall_register_hook "Stop" "RecallExtract" "/bin/bun run RecallExtract.ts"',
        'recall_rename_hooks_in_settings',
      ];

      for (const command of commands) {
        writeFileSync(settingsFile, original);
        const driver = [
          'set -e',
          `export HOME="${tempRoot}"`,
          `export CLAUDE_DIR="${claudeDir}"`,
          `export BACKUP_DIR="${join(tempRoot, 'backups')}"`,
          'log_success() { :; }',
          'log_error() { :; }',
          'source "$REPO/lib/install-lib.sh"',
          command,
        ].join('\n');
        const result = spawnSync('bash', ['-c', driver], {
          encoding: 'utf-8',
          cwd: REPO,
          env: { ...process.env, REPO, RECALL_DB_PATH: '/new/db' },
        });

        expect(result.status).not.toBe(0);
        expect(readFileSync(settingsFile, 'utf-8')).toBe(original);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Claude settings writers preserve unrelated valid configuration', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-settings-valid-'));
    try {
      const claudeDir = join(tempRoot, '.claude');
      const settingsFile = join(claudeDir, 'settings.json');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settingsFile, '{"permissions":{"allow":["safe"]}}');
      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${claudeDir}"`,
        'log_success() { :; }',
        'source "$REPO/lib/install-lib.sh"',
        '_recall_reconcile_claude_mcp user "/bin/bun" "/new/path/recall-mcp"',
        'recall_register_hook "Stop" "RecallExtract" "/bin/bun run RecallExtract.ts"',
        'recall_rename_hooks_in_settings',
      ].join('\n');
      const result = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO },
      });

      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(settingsFile, 'utf-8')) as {
        permissions: { allow: string[] };
        mcpServers: Record<string, unknown>;
        hooks: { Stop: unknown[] };
      };
      expect(config.permissions.allow).toEqual(['safe']);
      expect(config.mcpServers['recall-memory']).toBeDefined();
      expect(config.hooks.Stop).toHaveLength(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });


  test('--dry-run --force narrates but does not mutate', () => {
    // With --dry-run, no git/bun/recall commands should actually execute.
    // The output should contain the telltale [dry-run] markers.
    const r = run(['--dry-run', '--force', '--no-confirm', '--no-migrate']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY-RUN');
    expect(r.stdout).toContain('[dry-run]');
    // Would-execute markers for the destructive steps
    expect(r.stdout).toMatch(/would: git pull/);
    expect(r.stdout).toMatch(/would: bun install/);
    expect(r.stdout).toMatch(/would: bun run build/);
    // Regression for 0.7.21: update.sh was missing `bun link` after
    // rebuild. Without it, a stale or vanished ~/.bun/bin/recall-mcp
    // symlink is never repaired and MCP fails silently on next
    // Claude Code restart.
    expect(r.stdout).toMatch(/would: bun link/);
    // Regression: refresh must narrate owned-memory migration plus detected
    // platform guide, prompt, and skill propagation.
    expect(r.stdout).toMatch(/would: migrate Recall-owned Claude\/Pi MEMORY bootstraps/);
  });

  test('a bootstrap-capable updater reloads a changed lifecycle library', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-update-reexec-'));
    try {
      const checkout = join(tempRoot, 'checkout');
      const checkoutLib = join(checkout, 'lib');
      const checkoutPackaging = join(checkout, 'packaging');
      const stubBin = join(tempRoot, 'bin');
      const home = join(tempRoot, 'home');
      const claudeDir = join(home, '.claude');
      const recallDir = join(home, '.agents', 'Recall');
      const bunBin = join(home, '.bun', 'bin');
      const targets = join(tempRoot, 'targets');
      const settingsFile = join(claudeDir, 'settings.json');
      const pullCount = join(tempRoot, 'pull-count');
      const realLib = join(REPO, 'lib', 'install-lib.sh');

      for (const dir of [checkoutLib, checkoutPackaging, stubBin, join(claudeDir, 'plugins'), bunBin, targets]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(join(checkoutPackaging, 'update.sh'), readFileSync(UPDATE, 'utf-8'), { mode: 0o755 });
      writeFileSync(join(checkoutLib, 'jsonc-mcp.ts'), readFileSync(join(REPO, 'lib', 'jsonc-mcp.ts'), 'utf-8'));
      writeFileSync(
        join(checkoutLib, 'install-lib.sh'),
        `source ${JSON.stringify(realLib)}\nrecall_configure_mcp() { :; }\n`,
      );
      writeFileSync(join(checkout, 'package.json'), JSON.stringify({ version: '9.9.9' }));
      writeFileSync(
        join(claudeDir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: { 'recall@recall-marketplace': [{ version: '9.9.9' }] } }),
      );
      writeFileSync(settingsFile, JSON.stringify({
        permissions: { allow: ['safe'] },
        mcpServers: {
          'recall-memory': {
            command: 'bun',
            args: ['run', '/old/recall-mcp'],
            env: { RECALL_DB_PATH: join(recallDir, 'recall.db') },
          },
        },
      }));

      writeFileSync(join(targets, 'recall'), '#!/bin/sh\n[ "$1" = "--version" ] && echo "recall 9.9.9"\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(targets, 'recall-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      symlinkSync(join(targets, 'recall'), join(bunBin, 'recall'));
      symlinkSync(join(targets, 'recall-mcp'), join(bunBin, 'recall-mcp'));

      writeFileSync(join(stubBin, 'git'), `#!/bin/bash
set -e
case "$1" in
  fetch) exit 0 ;;
  rev-parse) echo old-sha ;;
  pull)
    cp "$NEW_LIB" "$CHECKOUT/lib/install-lib.sh"
    count=0
    [[ -f "$PULL_COUNT" ]] && count="$(cat "$PULL_COUNT")"
    printf '%s\n' "$((count + 1))" > "$PULL_COUNT"
    ;;
  diff) exit 1 ;;
esac
`, { mode: 0o755 });
      writeFileSync(join(stubBin, 'bun'), `#!/bin/bash
if [[ "$1" == "-e" ]]; then exec "$REAL_BUN" "$@"; fi
exit 0
`, { mode: 0o755 });
      writeFileSync(join(stubBin, 'node'), '#!/bin/bash\nexec "$REAL_BUN" "$@"\n', { mode: 0o755 });
      writeFileSync(join(stubBin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(stubBin, 'gh'), `#!/bin/sh
case "$*" in
  *tagName*) echo v9.9.9 ;;
  *) echo notes ;;
esac
`, { mode: 0o755 });

      const env = { ...process.env };
      for (const name of [
        'BACKUP_DIR',
        'MEM_DB_PATH',
        'RECALL_DB_PATH',
        'RECALL_UPDATE_PRE_SHA',
        'RECALL_UPDATE_REEXECUTED',
        'TIMESTAMP',
      ]) delete env[name];
      Object.assign(env, {
        BACKUP_BASE: join(recallDir, 'backups'),
        CHECKOUT: checkout,
        CLAUDE_DIR: claudeDir,
        HOME: home,
        NEW_LIB: realLib,
        NO_COLOR: '1',
        PATH: `${stubBin}:/usr/bin:/bin`,
        PULL_COUNT: pullCount,
        REAL_BUN: process.execPath,
        RECALL_DIR: recallDir,
        RECALL_REPO_DIR: REPO,
      });

      const result = spawnSync(
        'bash',
        [join(checkoutPackaging, 'update.sh'), '--force', '--no-confirm', '--no-migrate', '--no-gum'],
        { cwd: checkout, encoding: 'utf-8', env, timeout: 10_000 },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(pullCount, 'utf-8').trim()).toBe('1');
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      expect(settings.permissions.allow).toEqual(['safe']);
      expect(settings.mcpServers?.['recall-memory']).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 10_000);

  // The /Recall:* slash commands migrated to Agent Skills (#228).
  // recall_copy_runtime_files must clean up what older releases installed —
  // Recall-managed symlinks at ~/.claude/commands/Recall/ plus the canonicals
  // under ~/.agents/Recall/claude/commands/Recall/ — WITHOUT touching
  // user-authored files that happen to live in the same directory, and must
  // install the skills that replaced the commands.
  test('runtime refresh removes legacy command symlinks, preserves user files, installs skills', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-commands-legacy-'));
    try {
      const fakeRepo = join(tempRoot, 'repo');
      mkdirSync(join(fakeRepo, 'agent-skills', 'do-recall-scout'), { recursive: true });
      writeFileSync(join(fakeRepo, 'agent-skills', 'do-recall-scout', 'SKILL.md'), '# scout\n');
      // _recall_copy_hook_files (also called by recall_copy_runtime_files)
      // bails with a non-zero return when this is missing — provide the
      // minimal fixture so the driver's `set -e` doesn't abort early.
      mkdirSync(join(fakeRepo, 'hooks'), { recursive: true });
      writeFileSync(join(fakeRepo, 'hooks', 'RecallExtract.ts'), '// stub\n');

      // Simulate a pre-migration install: command canonical + managed symlink,
      // plus a user-authored file sitting in the same directory.
      const cmdCanonicalDir = join(tempRoot, '.agents', 'Recall', 'claude', 'commands', 'Recall');
      mkdirSync(cmdCanonicalDir, { recursive: true });
      writeFileSync(join(cmdCanonicalDir, 'scout.md'), '# scout\n');
      const cmdDir = join(tempRoot, '.claude', 'commands', 'Recall');
      mkdirSync(cmdDir, { recursive: true });
      symlinkSync(join(cmdCanonicalDir, 'scout.md'), join(cmdDir, 'scout.md'));
      writeFileSync(join(cmdDir, 'mine.md'), '# user-authored\n');

      const driver = [
        'set -e',
        `export HOME="${tempRoot}"`,
        `export CLAUDE_DIR="${tempRoot}/.claude"`,
        `export RECALL_DIR="${tempRoot}/.agents/Recall"`,
        `export RECALL_REPO_DIR="${fakeRepo}"`,
        'log_info() { :; }',
        'log_success() { :; }',
        'log_warn() { :; }',
        'log_error() { :; }',
        'source "$REPO/lib/install-lib.sh"',
        'recall_copy_runtime_files',
      ].join('\n');
      const r = spawnSync('bash', ['-c', driver], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, REPO },
      });

      expect(r.status).toBe(0);
      // Managed symlink removed; user file survives; canonicals dropped.
      expect(existsSync(join(cmdDir, 'scout.md'))).toBe(false);
      expect(existsSync(join(cmdDir, 'mine.md'))).toBe(true);
      expect(existsSync(cmdCanonicalDir)).toBe(false);
      // The replacing skill is installed.
      expect(existsSync(join(tempRoot, '.claude', 'skills', 'do-recall-scout', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // ─── Cycle 2/3 — refresh-step call topology (red-team-driven) ───
  //
  // Behavioral assertion that update.sh's step_refresh_runtime actually invokes
  // ALL platform install functions install.sh calls, not just the subset
  // (recall_install_*_guide + recall_install_opencode_agent) that was wired up
  // initially. For symlinked surfaces (plugins, guide) a filesystem-state
  // assertion is a no-op — `recall_link` short-circuits on already-correct
  // targets — so the only honest check is whether the function ran. We do that
  // by stubbing each install/configure function to echo its name, sourcing
  // step_refresh_runtime, and asserting all expected stub lines appear.
  describe('step_refresh_runtime call topology', () => {
    function runRefresh(env: { OPENCODE_DETECTED: string; PI_DETECTED: string; OMP_DETECTED?: string }) {
      const harness = `
        set -e
        source "${UPDATE}" >/dev/null 2>&1

        # Silence log helpers — only stub output should appear on stdout.
        log_info() { :; }
        log_success() { :; }
        log_warn() { :; }
        log_error() { :; }

        # Stub every install/configure function step_refresh_runtime might call.
        # Each prints CALL:<name> so test assertions can grep for invocations.
        recall_copy_runtime_files()      { echo "CALL:recall_copy_runtime_files"; }
        recall_configure_mcp()           { echo "CALL:recall_configure_mcp"; }
        recall_configure_claude_md()      { echo "CALL:recall_configure_claude_md"; }
        recall_detect_platforms()        { echo "CALL:recall_detect_platforms"; }
        recall_install_opencode_agent()  { echo "CALL:recall_install_opencode_agent"; }
        recall_install_opencode_guide()  { echo "CALL:recall_install_opencode_guide"; }
        recall_configure_opencode_mcp()  { echo "CALL:recall_configure_opencode_mcp"; }
        recall_install_opencode_plugins(){ echo "CALL:recall_install_opencode_plugins"; }
        recall_install_pi_adapter()      { echo "CALL:recall_install_pi_adapter"; }
        recall_install_pi_package()      { echo "CALL:recall_install_pi_package"; }
        recall_configure_pi_mcp()        { echo "CALL:recall_configure_pi_mcp"; }
        recall_install_pi_guide()        { echo "CALL:recall_install_pi_guide"; }
        recall_install_opencode_platform() { echo "CALL:recall_install_opencode_platform"; }
        recall_install_pi_platform()     { echo "CALL:recall_install_pi_platform"; }
        recall_install_omp_platform()    { echo "CALL:recall_install_omp_platform"; }

        CLAUDE_CODE_DETECTED=false
        OPENCODE_DETECTED=${env.OPENCODE_DETECTED}
        PI_DETECTED=${env.PI_DETECTED}
        OMP_DETECTED=${env.OMP_DETECTED ?? 'false'}
        DRY_RUN=false

        step_refresh_runtime
      `;
      return spawnSync('bash', ['-c', harness], { encoding: 'utf-8' });
    }

    test('Claude: always invokes shared bootstrap migration during refresh', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'false', PI_DETECTED: 'false' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('CALL:recall_configure_mcp');
      expect(r.stdout).toContain('CALL:recall_configure_claude_md');
    });

    test('OpenCode: invokes all 4 install functions when OPENCODE_DETECTED=true', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'true', PI_DETECTED: 'false' });
      expect(r.status).toBe(0);
      // Original install.sh order (lib/install-lib.sh:1668-1747):
      //   recall_configure_opencode_mcp
      //   recall_install_opencode_plugins
      //   recall_install_opencode_agent
      //   recall_install_opencode_guide
      // After the refactor a single helper recall_install_opencode_platform
      // wraps these — accept either the helper or the four individual calls
      // so this test stays valid through Cycles 2 → refactor.
      const ok =
        r.stdout.includes('CALL:recall_install_opencode_platform') ||
        (
          r.stdout.includes('CALL:recall_configure_opencode_mcp') &&
          r.stdout.includes('CALL:recall_install_opencode_plugins') &&
          r.stdout.includes('CALL:recall_install_opencode_agent') &&
          r.stdout.includes('CALL:recall_install_opencode_guide')
        );
      expect(ok).toBe(true);
    });

    test('Pi: invokes its canonical separate-surface installer when PI_DETECTED=true', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'false', PI_DETECTED: 'true' });
      expect(r.status).toBe(0);
      // Canonical order:
      //   recall_install_pi_adapter
      //   recall_install_pi_package
      //   recall_configure_pi_mcp
      //   recall_install_pi_guide
      const ok =
        r.stdout.includes('CALL:recall_install_pi_platform') ||
        (
          r.stdout.includes('CALL:recall_install_pi_adapter') &&
          r.stdout.includes('CALL:recall_install_pi_package') &&
          r.stdout.includes('CALL:recall_configure_pi_mcp') &&
          r.stdout.includes('CALL:recall_install_pi_guide')
        );
      expect(ok).toBe(true);
    });

    test('omp: invokes recall_install_omp_platform when OMP_DETECTED=true', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'false', PI_DETECTED: 'false', OMP_DETECTED: 'true' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('CALL:recall_install_omp_platform');
    });

    test('No optional platforms: skips their install calls after Claude migration', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'false', PI_DETECTED: 'false', OMP_DETECTED: 'false' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('CALL:recall_configure_claude_md');
      expect(r.stdout).not.toContain('CALL:recall_install_opencode_');
      expect(r.stdout).not.toContain('CALL:recall_configure_opencode_');
      expect(r.stdout).not.toContain('CALL:recall_install_pi_');
      expect(r.stdout).not.toContain('CALL:recall_configure_pi_');
      expect(r.stdout).not.toContain('CALL:recall_install_omp_');
    });
  });
});
