import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('legacy slash-command cleanup', () => {
  test('a user file in commands/Recall survives, a managed link does not', () => {
    root = mkdtempSync(join(tmpdir(), 'recall-slash-'));
    const claude = join(root, '.claude');
    const recall = join(root, 'recall-home');
    const dir = join(claude, 'commands', 'Recall');
    mkdirSync(dir, { recursive: true });
    mkdirSync(recall, { recursive: true });
    writeFileSync(join(recall, 'owned.md'), 'recall');
    writeFileSync(join(dir, 'mine.md'), 'user');
    symlinkSync(join(recall, 'owned.md'), join(dir, 'Recall.md'));

    const result = spawnSync('bash', ['-c', `
      set -euo pipefail
      source "$REPO/lib/install-lib.sh" >/dev/null 2>&1
      recall_remove_legacy_slash_commands
    `], {
      encoding: 'utf-8',
      env: { ...process.env, REPO, HOME: root, CLAUDE_DIR: claude, RECALL_DIR: recall },
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'mine.md'))).toBe(true);
    expect(existsSync(join(dir, 'Recall.md'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});
