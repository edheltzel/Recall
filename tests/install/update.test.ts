// update.sh: version check, dry-run, rollback recipe emission.
//
// The script shells out to git/gh/curl and `recall`. Tests here exercise the
// orchestration logic that does NOT require network or a real release —
// --check in the current repo's state and --dry-run against a scratch tree.
//
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

  test('documents the old-updater transition and re-executes on the forced second run', () => {
    const upgradingGuide = readFileSync(join(REPO, 'docs', 'upgrading.md'), 'utf-8');
    expect(upgradingGuide).toContain('One-time transition for older updaters');
    expect(upgradingGuide).toContain('./update.sh --force');
    const tempRoot = mkdtempSync(join(tmpdir(), 'recall-update-reexec-'));
    try {
      const checkout = join(tempRoot, 'checkout');
      const remote = join(tempRoot, 'remote.git');
      const home = join(tempRoot, 'home');
      const backupBase = join(home, 'backups');
      const marker = join(tempRoot, 'reexec-marker');
      const stubDir = join(tempRoot, 'bin');
      const customDb = join(tempRoot, 'custom-db', 'memory.sqlite');
      mkdirSync(join(checkout, 'lib'), { recursive: true });
      mkdirSync(join(checkout, 'hooks', 'lib'), { recursive: true });
      mkdirSync(stubDir, { recursive: true });
      mkdirSync(join(home, '.claude'), { recursive: true });
      mkdirSync(join(tempRoot, 'custom-db'), { recursive: true });
      writeFileSync(customDb, 'pre-update-memory');
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
        mcpServers: {
          'recall-memory': { env: { RECALL_DB_PATH: customDb } },
        },
      }));
      const current = readFileSync(UPDATE, 'utf-8');
      const functionNeedle = 'step_install_and_build() {\n  log_info "Installing dependencies (bun install)..."';
      const reexecNeedle = '    step_fetch_and_pull\n    step_reexec_after_pull';
      expect(current).toContain(functionNeedle);
      expect(current).toContain(reexecNeedle);
      const oldUpdater = current
        .replace(reexecNeedle, '    step_fetch_and_pull')
        .replace(
          functionNeedle,
          'step_install_and_build() {\n  printf "old\\n" > "$RECALL_REEXEC_MARKER"\n  exit 0\n  log_info "Installing dependencies (bun install)..."'
        );
      writeFileSync(join(checkout, 'update.sh'), oldUpdater, { mode: 0o755 });
      writeFileSync(join(checkout, 'lib', 'install-lib.sh'), readFileSync(join(REPO, 'lib', 'install-lib.sh')));
      writeFileSync(join(checkout, 'hooks', 'lib', 'db-path.ts'), readFileSync(join(REPO, 'hooks', 'lib', 'db-path.ts')));
      writeFileSync(join(checkout, 'hooks', 'lib', 'jsonc.ts'), readFileSync(join(REPO, 'hooks', 'lib', 'jsonc.ts')));
      writeFileSync(join(checkout, 'package.json'), '{"version":"0.0.1"}\n');
      writeFileSync(join(stubDir, 'gh'), '#!/bin/sh\ncase "$*" in *tagName*) echo v999.0.0;; *) echo notes;; esac\n', { mode: 0o755 });

      const git = (args: string[], cwd = checkout) => spawnSync('git', args, {
        cwd,
        encoding: 'utf-8',
      });
      expect(git(['init', '-b', 'main']).status).toBe(0);
      expect(git(['config', 'user.name', 'Recall Test']).status).toBe(0);
      expect(git(['config', 'user.email', 'recall@example.test']).status).toBe(0);
      expect(git(['add', '.']).status).toBe(0);
      expect(git(['commit', '-m', 'old updater']).status).toBe(0);
      const first = git(['rev-parse', 'HEAD']).stdout.trim();
      expect(git(['init', '--bare', remote], tempRoot).status).toBe(0);
      expect(git(['remote', 'add', 'origin', remote]).status).toBe(0);
      expect(git(['push', '-u', 'origin', 'main']).status).toBe(0);

      writeFileSync(join(checkout, 'update.sh'), current.replace(
        functionNeedle,
        'step_install_and_build() {\n  printf "%s|%s\\n" "$UPDATE_AFTER_PULL" "${RECALL_UPDATE_AFTER_PULL-unset}" > "$RECALL_REEXEC_MARKER"\n  exit 0\n  log_info "Installing dependencies (bun install)..."'
      ), { mode: 0o755 });
      expect(git(['add', 'update.sh']).status).toBe(0);
      expect(git(['commit', '-m', 'fresh updater']).status).toBe(0);
      expect(git(['push', 'origin', 'main']).status).toBe(0);
      expect(git(['reset', '--hard', first]).status).toBe(0);

      const result = spawnSync('bash', [join(checkout, 'update.sh'), '--force', '--no-confirm', '--no-gum'], {
        cwd: checkout,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          RECALL_DIR: join(home, '.agents', 'Recall'),
          BACKUP_BASE: backupBase,
          RECALL_DB_PATH: '',
          MEM_DB_PATH: '',
          RECALL_NO_GUM: '1',
          RECALL_UPDATE_AFTER_PULL: '',
          RECALL_REEXEC_MARKER: marker,
          TIMESTAMP: 'first-run',
          NO_COLOR: '1',
          PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(marker, 'utf-8')).toBe('old\n');
      expect(readFileSync(join(backupBase, 'first-run', 'recall.db'), 'utf-8'))
        .toBe('pre-update-memory');
      expect(readFileSync(join(backupBase, 'first-run', 'recall.db.path'), 'utf-8'))
        .toBe(`${customDb}\n`);
      expect(readFileSync(join(home, '.agents', 'Recall', '.db-path'), 'utf-8'))
        .toBe(`${customDb}\n`);

      const second = spawnSync('bash', [join(checkout, 'update.sh'), '--force', '--no-confirm', '--no-gum'], {
        cwd: checkout,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          RECALL_DIR: join(home, '.agents', 'Recall'),
          BACKUP_BASE: backupBase,
          RECALL_DB_PATH: '',
          MEM_DB_PATH: '',
          RECALL_NO_GUM: '1',
          RECALL_UPDATE_AFTER_PULL: '',
          RECALL_REEXEC_MARKER: marker,
          TIMESTAMP: 'second-run',
          NO_COLOR: '1',
          PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        },
      });

      expect(second.status).toBe(0);
      expect(readFileSync(marker, 'utf-8')).toBe('true|unset\n');
      const backups = readdirSync(backupBase, { withFileTypes: true }).filter(entry => entry.isDirectory());
      expect(backups.map(entry => entry.name).sort()).toEqual(['first-run', 'second-run']);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

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
    // Regression: refresh must narrate owned-memory migration plus detected
    // platform guide, prompt, and skill propagation.
    expect(r.stdout).toMatch(/would: migrate Recall-owned Claude\/Pi MEMORY bootstraps/);
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
      mkdirSync(join(fakeRepo, 'agent-skills', 'recall-scout'), { recursive: true });
      writeFileSync(join(fakeRepo, 'agent-skills', 'recall-scout', 'SKILL.md'), '# scout\n');
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
      expect(existsSync(join(tempRoot, '.claude', 'skills', 'recall-scout', 'SKILL.md'))).toBe(true);
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
        source "${REPO}/lib/install-lib.sh" >/dev/null 2>&1

        # Silence log helpers — only stub output should appear on stdout.
        log_info() { :; }
        log_success() { :; }
        log_warn() { :; }
        log_error() { :; }

        # Stub every install/configure function step_refresh_runtime might call.
        # Each prints CALL:<name> so test assertions can grep for invocations.
        recall_copy_runtime_files()      { echo "CALL:recall_copy_runtime_files"; }
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

        # Pull step_refresh_runtime out of update.sh and define it inline.
        # awk over sed: more robust to inline shell that might confuse sed's
        # range matcher.
        eval "$(awk '/^step_refresh_runtime\\(\\)/{p=1} p; p && /^}$/{exit}' "${REPO}/update.sh")"

        step_refresh_runtime
      `;
      return spawnSync('bash', ['-c', harness], { encoding: 'utf-8' });
    }

    test('Claude: always invokes shared bootstrap migration during refresh', () => {
      const r = runRefresh({ OPENCODE_DETECTED: 'false', PI_DETECTED: 'false' });
      expect(r.status).toBe(0);
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
