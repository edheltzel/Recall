// Agent Skills (agent-skills/<name>/SKILL.md) are installed the same way as
// slash commands: canonical copy under $RECALL_SHARED_SKILLS_DIR/<name>/,
// per-file symlinks into each detected platform's skills directory
// (~/.claude/skills, ~/.pi/agent/skills, ~/.omp/agent/skills).
//
// Install-side tests drive lib/install-lib.sh directly against a
// tmpdir-scoped HOME/CLAUDE_DIR/RECALL_DIR/RECALL_REPO_DIR, mirroring
// tests/install/install-sentinel.test.ts. Uninstall-side tests shell out to
// `bash uninstall.sh`, mirroring tests/install/uninstall.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const INSTALL_LIB = join(REPO, 'lib', 'install-lib.sh');
const UNINSTALL = join(REPO, 'uninstall.sh');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

describe('Agent Skills install (lib/install-lib.sh)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let recallDir: string;
  let fakeRepo: string;
  let piConfigDir: string;
  let ompConfigDir: string;
  let driverSeq = 0;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-skills-'));
    claudeDir = join(tempRoot, '.claude');
    recallDir = join(tempRoot, '.agents', 'Recall');
    fakeRepo = join(tempRoot, 'repo');
    piConfigDir = join(tempRoot, '.pi', 'agent');
    ompConfigDir = join(tempRoot, '.omp', 'agent');

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(fakeRepo, 'agent-skills', 'recall-doctor'), { recursive: true });
    mkdirSync(join(fakeRepo, 'agent-skills', 'recall-stats'), { recursive: true });
    writeFileSync(
      join(fakeRepo, 'agent-skills', 'recall-doctor', 'SKILL.md'),
      '---\nname: "source-command-recall-doctor"\n---\n# doctor\n',
    );
    writeFileSync(
      join(fakeRepo, 'agent-skills', 'recall-stats', 'SKILL.md'),
      '---\nname: "source-command-recall-stats"\n---\n# stats\n',
    );
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function runDriver(body: string[]): RunResult {
    const driverPath = join(tempRoot, `drive-${++driverSeq}.sh`);
    const driver = [
      '#!/usr/bin/env bash',
      'set -eo pipefail',
      `export HOME="${tempRoot}"`,
      `export CLAUDE_DIR="${claudeDir}"`,
      `export RECALL_DIR="${recallDir}"`,
      `export RECALL_REPO_DIR="${fakeRepo}"`,
      `export PI_CONFIG_DIR="${piConfigDir}"`,
      `export OMP_CONFIG_DIR="${ompConfigDir}"`,
      'export NO_COLOR=1',
      `source "${INSTALL_LIB}"`,
      ...body,
    ].join('\n');
    writeFileSync(driverPath, driver, { mode: 0o755 });
    const r = spawnSync('bash', [driverPath], { encoding: 'utf-8' });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  test('recall_install_claude_skills copies canonicals and symlinks per file into ~/.claude/skills', () => {
    const r = runDriver(['recall_install_claude_skills']);
    expect(r.status).toBe(0);

    const doctorCanonical = join(recallDir, 'shared', 'skills', 'recall-doctor', 'SKILL.md');
    const doctorTarget = join(claudeDir, 'skills', 'recall-doctor', 'SKILL.md');
    const statsTarget = join(claudeDir, 'skills', 'recall-stats', 'SKILL.md');

    expect(existsSync(doctorCanonical)).toBe(true);
    expect(existsSync(doctorTarget)).toBe(true);
    expect(lstatSync(doctorTarget).isSymbolicLink()).toBe(true);
    expect(readlinkSync(doctorTarget)).toBe(doctorCanonical);
    expect(existsSync(statsTarget)).toBe(true);
  });

  test('idempotent: running twice does not fail or duplicate', () => {
    const r1 = runDriver(['recall_install_claude_skills']);
    expect(r1.status).toBe(0);
    const r2 = runDriver(['recall_install_claude_skills']);
    expect(r2.status).toBe(0);
    expect(existsSync(join(claudeDir, 'skills', 'recall-doctor', 'SKILL.md'))).toBe(true);
  });

  test('recall_install_pi_skills symlinks into $PI_CONFIG_DIR/skills, not $CLAUDE_DIR/skills', () => {
    const r = runDriver(['recall_install_pi_skills']);
    expect(r.status).toBe(0);

    const piTarget = join(piConfigDir, 'skills', 'recall-doctor', 'SKILL.md');
    expect(existsSync(piTarget)).toBe(true);
    expect(lstatSync(piTarget).isSymbolicLink()).toBe(true);
    expect(existsSync(join(claudeDir, 'skills'))).toBe(false);
  });

  test('recall_install_omp_platform symlinks into $OMP_CONFIG_DIR/skills', () => {
    const r = runDriver(['recall_install_omp_platform']);
    expect(r.status).toBe(0);

    const ompTarget = join(ompConfigDir, 'skills', 'recall-stats', 'SKILL.md');
    expect(existsSync(ompTarget)).toBe(true);
    expect(lstatSync(ompTarget).isSymbolicLink()).toBe(true);
  });

  test('a foreign (non-Recall) symlink at the target is backed up, not silently overwritten', () => {
    const foreignFile = join(tempRoot, 'foreign-skill.md');
    writeFileSync(foreignFile, '# not ours');
    const target = join(claudeDir, 'skills', 'recall-doctor', 'SKILL.md');
    mkdirSync(join(claudeDir, 'skills', 'recall-doctor'), { recursive: true });

    const r = runDriver([
      `mkdir -p "$(dirname "${target}")"`,
      `ln -s "${foreignFile}" "${target}"`,
      'recall_install_claude_skills',
    ]);
    expect(r.status).toBe(0);
    expect(readlinkSync(target)).toBe(
      join(recallDir, 'shared', 'skills', 'recall-doctor', 'SKILL.md'),
    );
  });
});

describe('Agent Skills uninstall (uninstall.sh)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let backupBase: string;

  function runUninstall(extraArgs: string[] = [], extraEnv: Record<string, string> = {}): RunResult {
    const r = spawnSync(
      'bash',
      [UNINSTALL, '--no-confirm', '--skip-opencode', '--skip-pi', '--skip-omp', ...extraArgs],
      {
        encoding: 'utf-8',
        cwd: REPO,
        env: {
          ...process.env,
          CLAUDE_DIR: claudeDir,
          BACKUP_BASE: backupBase,
          HOME: claudeDir,
          RECALL_SKIP_BUN_UNLINK: 'true',
          ...extraEnv,
        },
      },
    );
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-skills-uninstall-'));
    claudeDir = join(tempRoot, '.claude');
    backupBase = join(claudeDir, 'backups', 'recall');
    mkdirSync(backupBase, { recursive: true });

    // Recall-owned skill
    mkdirSync(join(claudeDir, 'skills', 'recall-doctor'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'recall-doctor', 'SKILL.md'), '# doctor');

    // Foreign, non-Recall skill in the same directory — MUST survive
    mkdirSync(join(claudeDir, 'skills', 'some-other-skill'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'some-other-skill', 'SKILL.md'), '# not ours');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('removes only Recall-owned skill directories, preserves foreign ones', () => {
    const r = runUninstall();
    expect(r.status).toBe(0);
    expect(existsSync(join(claudeDir, 'skills', 'recall-doctor'))).toBe(false);
    expect(existsSync(join(claudeDir, 'skills', 'some-other-skill', 'SKILL.md'))).toBe(true);
  });

  test('--dry-run narrates without touching the filesystem', () => {
    const r = runUninstall(['--dry-run']);
    expect(r.status).toBe(0);
    expect(existsSync(join(claudeDir, 'skills', 'recall-doctor'))).toBe(true);
  });
});
