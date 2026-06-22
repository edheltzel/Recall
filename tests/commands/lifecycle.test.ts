// `recall update` / `recall uninstall` delegation layer.
//
// These subcommands forward verbatim to the canonical bash scripts
// (update.sh / uninstall.sh) — the single source of truth. The scripts' own
// behavior is covered by tests/install/update.test.ts and
// tests/install/uninstall.test.ts; here we test only the TypeScript delegation:
// repo-root resolution, the spawn seam, the missing-script guard, and the
// end-to-end CLI passthrough (Commander forwards flags + exit codes).

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveRepoRoot, runLifecycleScript } from '../../src/lib/lifecycle.js';
import { runUpdate } from '../../src/commands/update.js';
import { runUninstall } from '../../src/commands/uninstall.js';

const REPO = process.cwd();

describe('lifecycle: resolveRepoRoot', () => {
  test('honors $RECALL_REPO_DIR (trimmed) over derivation', () => {
    const root = resolveRepoRoot(
      { RECALL_REPO_DIR: '  /opt/recall  ' } as NodeJS.ProcessEnv,
      'file:///somewhere/dist/index.js',
    );
    expect(root).toBe('/opt/recall');
  });

  test('derives the repo root from the bundled dist/index.js location', () => {
    // The shipped CLI is bundled to <repo>/dist/index.js, so the repo root is
    // one directory above dist/.
    const root = resolveRepoRoot(
      {} as NodeJS.ProcessEnv,
      'file:///Users/x/Recall/dist/index.js',
    );
    expect(root).toBe('/Users/x/Recall');
  });

  test('falls back to derivation when the override is blank', () => {
    const root = resolveRepoRoot(
      { RECALL_REPO_DIR: '   ' } as NodeJS.ProcessEnv,
      'file:///a/b/dist/index.js',
    );
    expect(root).toBe('/a/b');
  });
});

describe('lifecycle: runLifecycleScript delegation seam', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('spawns the resolved script with forwarded args and returns its code', () => {
    root = mkdtempSync(join(tmpdir(), 'recall-lc-'));
    writeFileSync(join(root, 'update.sh'), '#!/bin/bash\nexit 0\n');

    const calls: Array<{ script: string; args: string[] }> = [];
    const code = runLifecycleScript('update', ['--check', '--force'], {
      repoRoot: root,
      spawn: (script, args) => {
        calls.push({ script, args });
        return 7;
      },
    });

    expect(code).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe(join(root, 'update.sh'));
    expect(calls[0].args).toEqual(['--check', '--force']);
  });

  test('missing script returns 1 and does not spawn', () => {
    root = mkdtempSync(join(tmpdir(), 'recall-lc-')); // no script inside
    let spawned = false;
    const code = runLifecycleScript('uninstall', ['--dry-run'], {
      repoRoot: root,
      spawn: () => {
        spawned = true;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(spawned).toBe(false);
  });

  test('runUpdate / runUninstall forward to the correct scripts', () => {
    root = mkdtempSync(join(tmpdir(), 'recall-lc-'));
    writeFileSync(join(root, 'update.sh'), '#!/bin/bash\nexit 0\n');
    writeFileSync(join(root, 'uninstall.sh'), '#!/bin/bash\nexit 0\n');

    const seen: Array<{ script: string; args: string[] }> = [];
    const spawn = (script: string, args: string[]) => {
      seen.push({ script, args });
      return 0;
    };

    runUpdate(['--dry-run'], { repoRoot: root, spawn });
    runUninstall(['--purge'], { repoRoot: root, spawn });

    expect(seen).toEqual([
      { script: join(root, 'update.sh'), args: ['--dry-run'] },
      { script: join(root, 'uninstall.sh'), args: ['--purge'] },
    ]);
  });
});

describe('lifecycle: end-to-end CLI passthrough (delegates to real scripts)', () => {
  // Run the real CLI against the worktree's actual update.sh / uninstall.sh.
  // RECALL_REPO_DIR pins the repo root so the test is hermetic regardless of
  // whether dist/ has been built (running unbundled src resolves relative to
  // src/lib/, not the repo root — the override is the same mechanism the bash
  // lifecycle tests use).
  function cli(
    args: string[],
    extraEnv: Record<string, string> = {},
    input?: string,
  ) {
    const r = spawnSync('bun', [join(REPO, 'src/index.ts'), ...args], {
      encoding: 'utf-8',
      cwd: REPO,
      input,
      env: { ...process.env, RECALL_REPO_DIR: REPO, ...extraEnv },
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status ?? 1,
    };
  }

  test('update --help forwards to update.sh usage and exits 0', () => {
    const r = cli(['update', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Recall Update Script');
    expect(r.stdout).toContain('--check');
    expect(r.stdout).toContain('--dry-run');
  });

  test('update unknown flag is forwarded and errors non-zero', () => {
    const r = cli(['update', '--definitely-not-a-flag']);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Unknown flag/);
  });

  test('uninstall --dry-run delegates, narrates, and does not mutate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'recall-cli-uninstall-'));
    try {
      const claudeDir = join(tmp, '.claude');
      mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
      const hook = join(claudeDir, 'hooks', 'RecallExtract.ts');
      writeFileSync(hook, '// stub');

      const r = cli(
        ['uninstall', '--dry-run', '--no-confirm', '--skip-opencode', '--skip-pi'],
        {
          CLAUDE_DIR: claudeDir,
          HOME: tmp,
          BACKUP_BASE: join(claudeDir, 'backups', 'recall'),
          RECALL_SKIP_BUN_UNLINK: 'true',
        },
      );

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('DRY-RUN');
      // Dry-run must not remove anything.
      expect(existsSync(hook)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
