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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const UPDATE = join(REPO, 'update.sh');

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
        '_recall_ensure_mcp_entry "/bin/bun" "/new/path/recall-mcp"',
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
    // Regression: the refresh step must also narrate OpenCode/Pi guide +
    // agent-prompt propagation (see "refresh path propagates" tests below).
    expect(r.stdout).toMatch(/would: refresh OpenCode\/Pi guide/);
  });

  // Regression: recall_copy_runtime_files only refreshes the Claude guide +
  // slash commands. recall_install_pi_guide / recall_install_opencode_guide /
  // recall_install_opencode_agent were called ONLY from install.sh, so existing
  // OpenCode/Pi users never received guide/prompt updates on `update.sh`. The
  // refresh path must call the shared installers (DRY — reused, not duplicated).
  describe('refresh path propagates OpenCode/Pi guides and prompts', () => {
    const src = readFileSync(UPDATE, 'utf-8');

    test('reuses recall_detect_platforms to gate (no duplicated command -v)', () => {
      expect(src).toContain('recall_detect_platforms');
      // Must reuse the shared detector, not re-implement detection inline.
      expect(src).not.toContain('command -v opencode');
      expect(src).not.toContain('command -v pi');
    });

    test('routes OpenCode refresh through recall_install_opencode_platform helper', () => {
      // The helper composes recall_configure_opencode_mcp + plugins + agent +
      // guide (lib/install-lib.sh). install.sh and update.sh both call this
      // single entry point so a new OpenCode surface added inside the helper
      // applies to both scripts — the DRY mandate from CLAUDE.md.
      expect(src).toContain('recall_install_opencode_platform');
      expect(src).toMatch(/OPENCODE_DETECTED.*==.*true/);
    });

    test('routes Pi refresh through recall_install_pi_platform helper', () => {
      expect(src).toContain('recall_install_pi_platform');
      expect(src).toMatch(/PI_DETECTED.*==.*true/);
    });
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
    function runRefresh(env: { OPENCODE_DETECTED: string; PI_DETECTED: string }) {
      const harness = `
        set -e
        source "${REPO}/lib/install-lib.sh" >/dev/null 2>&1

        # Silence log helpers — only stub output should appear on stdout.
        log_info() { :; }
        log_success() { :; }
        log_warn() { :; }
        log_error() { :; }

        # Stub every install/configure function step_refresh_runtime might call.
        # Each prints CALL:<name> so test assertions can grep for invocations.
        recall_copy_runtime_files()      { echo "CALL:recall_copy_runtime_files"; }
        recall_detect_platforms()        { echo "CALL:recall_detect_platforms"; }
        recall_install_opencode_agent()  { echo "CALL:recall_install_opencode_agent"; }
        recall_install_opencode_guide()  { echo "CALL:recall_install_opencode_guide"; }
        recall_configure_opencode_mcp()  { echo "CALL:recall_configure_opencode_mcp"; }
        recall_install_opencode_plugins(){ echo "CALL:recall_install_opencode_plugins"; }
        recall_install_pi_adapter()      { echo "CALL:recall_install_pi_adapter"; }
        recall_configure_pi_mcp()        { echo "CALL:recall_configure_pi_mcp"; }
        recall_install_pi_extensions()   { echo "CALL:recall_install_pi_extensions"; }
        recall_install_pi_guide()        { echo "CALL:recall_install_pi_guide"; }
        recall_install_opencode_platform() { echo "CALL:recall_install_opencode_platform"; }
        recall_install_pi_platform()     { echo "CALL:recall_install_pi_platform"; }

        CLAUDE_CODE_DETECTED=false
        OPENCODE_DETECTED=${env.OPENCODE_DETECTED}
        PI_DETECTED=${env.PI_DETECTED}
        DRY_RUN=false

        # Pull step_refresh_runtime out of update.sh and define it inline.
        # awk over sed: more robust to inline shell that might confuse sed's
        # range matcher.
        eval "$(awk '/^step_refresh_runtime\\(\\)/{p=1} p; p && /^}$/{exit}' "${REPO}/update.sh")"

        step_refresh_runtime
      `;
      return spawnSync('bash', ['-c', harness], { encoding: 'utf-8' });
    }

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

    test('Pi: invokes all 4 install functions when PI_DETECTED=true', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'false', PI_DETECTED: 'true' });
      expect(r.status).toBe(0);
      // Original install.sh order (lib/install-lib.sh:1750-1854):
      //   recall_install_pi_adapter
      //   recall_configure_pi_mcp
      //   recall_install_pi_extensions
      //   recall_install_pi_guide
      const ok =
        r.stdout.includes('CALL:recall_install_pi_platform') ||
        (
          r.stdout.includes('CALL:recall_install_pi_adapter') &&
          r.stdout.includes('CALL:recall_configure_pi_mcp') &&
          r.stdout.includes('CALL:recall_install_pi_extensions') &&
          r.stdout.includes('CALL:recall_install_pi_guide')
        );
      expect(ok).toBe(true);
    });

    test('No platforms: skips all platform install calls', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'false', PI_DETECTED: 'false' });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('CALL:recall_install_opencode_');
      expect(r.stdout).not.toContain('CALL:recall_configure_opencode_');
      expect(r.stdout).not.toContain('CALL:recall_install_pi_');
      expect(r.stdout).not.toContain('CALL:recall_configure_pi_');
    });
  });
});
