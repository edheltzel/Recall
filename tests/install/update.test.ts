// update.sh: version check, dry-run, rollback recipe emission.
//
// The script shells out to git/gh/curl and `mem`. Tests here exercise the
// orchestration logic that does NOT require network or a real release —
// --check in the current repo's state and --dry-run against a scratch tree.
//
// Destructive paths (git pull, bun install, mem init) are validated only
// via --dry-run narration so we never mutate the working tree.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
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

  test('--dry-run --force narrates but does not mutate', () => {
    // With --dry-run, no git/bun/mem commands should actually execute.
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
    // rebuild. Without it, a stale or vanished ~/.bun/bin/mem-mcp
    // symlink is never repaired and MCP fails silently on next
    // Claude Code restart.
    expect(r.stdout).toMatch(/would: bun link/);
  });
});
