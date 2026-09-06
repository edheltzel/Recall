// Agent Skills (agent-skills/<name>/SKILL.md) are the single command surface
// (#228 — the old /Recall:* slash commands are gone): canonical copy under
// $RECALL_SHARED_SKILLS_DIR/<name>/, per-file symlinks into Claude Code and
// omp. Pi discovers the canonical sources through the root package manifest;
// that native-package contract is covered by tests/pi-integration.test.ts.
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
  symlinkSync,
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
  let ompConfigDir: string;
  let piConfigDir: string;
  let driverSeq = 0;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-skills-'));
    claudeDir = join(tempRoot, '.claude');
    recallDir = join(tempRoot, '.agents', 'Recall');
    fakeRepo = join(tempRoot, 'repo');
    ompConfigDir = join(tempRoot, '.omp', 'agent');
    piConfigDir = join(tempRoot, '.pi', 'agent');

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(fakeRepo, 'agent-skills', 'do-recall-doctor'), { recursive: true });
    mkdirSync(join(fakeRepo, 'agent-skills', 'do-recall-stats'), { recursive: true });
    writeFileSync(
      join(fakeRepo, 'agent-skills', 'do-recall-doctor', 'SKILL.md'),
      '---\nname: "source-command-do-recall-doctor"\n---\n# doctor\n',
    );
    writeFileSync(
      join(fakeRepo, 'agent-skills', 'do-recall-stats', 'SKILL.md'),
      '---\nname: "source-command-do-recall-stats"\n---\n# stats\n',
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
      `export OMP_CONFIG_DIR="${ompConfigDir}"`,
      `export PI_CONFIG_DIR="${piConfigDir}"`,
      'export NO_COLOR=1',
      `source "${INSTALL_LIB}"`,
      ...body,
    ].join('\n');
    writeFileSync(driverPath, driver, { mode: 0o755 });
    const r = spawnSync('bash', [driverPath], { encoding: 'utf-8' });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  function seedLegacyRecallAdd(): {
    legacyCanonicalDir: string;
    claudeLegacy: string;
    ompLegacyDir: string;
    piLegacy: string;
  } {
    const legacyCanonicalDir = join(recallDir, 'shared', 'skills', 'recall-add');
    const legacyCanonical = join(legacyCanonicalDir, 'SKILL.md');
    const claudeLegacyDir = join(claudeDir, 'skills', 'recall-add');
    const ompLegacyDir = join(ompConfigDir, 'skills', 'recall-add');
    const piLegacyDir = join(piConfigDir, 'skills', 'recall-add');
    mkdirSync(legacyCanonicalDir, { recursive: true });
    writeFileSync(legacyCanonical, '# legacy canonical\n');
    mkdirSync(claudeLegacyDir, { recursive: true });
    symlinkSync(legacyCanonical, join(claudeLegacyDir, 'SKILL.md'));
    writeFileSync(join(claudeLegacyDir, 'notes.md'), 'mine');
    mkdirSync(join(ompConfigDir, 'skills'), { recursive: true });
    symlinkSync(legacyCanonicalDir, ompLegacyDir);
    mkdirSync(piLegacyDir, { recursive: true });
    symlinkSync(legacyCanonical, join(piLegacyDir, 'SKILL.md'));
    return {
      legacyCanonicalDir,
      claudeLegacy: join(claudeLegacyDir, 'SKILL.md'),
      ompLegacyDir,
      piLegacy: join(piLegacyDir, 'SKILL.md'),
    };
  }

  test('recall_install_claude_skills copies canonicals and symlinks per file into ~/.claude/skills', () => {
    const r = runDriver(['recall_install_claude_skills']);
    expect(r.status).toBe(0);

    const doctorCanonical = join(recallDir, 'shared', 'skills', 'do-recall-doctor', 'SKILL.md');
    const doctorTarget = join(claudeDir, 'skills', 'do-recall-doctor', 'SKILL.md');
    const statsTarget = join(claudeDir, 'skills', 'do-recall-stats', 'SKILL.md');

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
    expect(existsSync(join(claudeDir, 'skills', 'do-recall-doctor', 'SKILL.md'))).toBe(true);
  });

  test('recall_install_omp_platform symlinks into $OMP_CONFIG_DIR/skills', () => {
    const r = runDriver(['recall_install_omp_platform']);
    expect(r.status).toBe(0);

    const ompTarget = join(ompConfigDir, 'skills', 'do-recall-stats', 'SKILL.md');
    expect(existsSync(ompTarget)).toBe(true);
    expect(lstatSync(ompTarget).isSymbolicLink()).toBe(true);
  });

  test('a foreign (non-Recall) symlink at the target is backed up, not silently overwritten', () => {
    const foreignFile = join(tempRoot, 'foreign-skill.md');
    writeFileSync(foreignFile, '# not ours');
    const target = join(claudeDir, 'skills', 'do-recall-doctor', 'SKILL.md');
    mkdirSync(join(claudeDir, 'skills', 'do-recall-doctor'), { recursive: true });

    const r = runDriver([
      `mkdir -p "$(dirname "${target}")"`,
      `ln -s "${foreignFile}" "${target}"`,
      'recall_install_claude_skills',
    ]);
    expect(r.status).toBe(0);
    expect(readlinkSync(target)).toBe(
      join(recallDir, 'shared', 'skills', 'do-recall-doctor', 'SKILL.md'),
    );
  });

  // The recall-* → do-recall-* rename: installs from before it carry the old
  // canonicals plus old-name host links. Cleanup runs inside _recall_copy_skill_files
  // so every linker (Claude skills AND omp) drops the retired surface.
  test('recall_install_claude_skills clears the pre-rename recall-* surface', () => {
    const seeded = seedLegacyRecallAdd();

    const r = runDriver(['recall_install_claude_skills']);
    expect(r.status).toBe(0);
    // lstatSync, not existsSync: existsSync follows the link and reads false
    // for a surviving DANGLING symlink, masking a failed removal; lstat throws
    // only when the link itself is gone.
    expect(() => lstatSync(seeded.claudeLegacy)).toThrow();
    expect(existsSync(join(claudeDir, 'skills', 'recall-add', 'notes.md'))).toBe(true);
    expect(() => lstatSync(seeded.ompLegacyDir)).toThrow();
    expect(() => lstatSync(seeded.piLegacy)).toThrow();
    expect(existsSync(seeded.legacyCanonicalDir)).toBe(false);
    expect(lstatSync(join(claudeDir, 'skills', 'do-recall-doctor', 'SKILL.md')).isSymbolicLink()).toBe(true);

    const r2 = runDriver(['recall_install_claude_skills']);
    expect(r2.status).toBe(0);
    expect(() => lstatSync(seeded.claudeLegacy)).toThrow();
  });

  // Red-team: recall_install_omp_platform used to copy then link every leftover
  // $RECALL_SHARED_SKILLS_DIR/*/ name, republishing recall-* onto omp.
  test('recall_install_omp_platform does not re-link leftover recall-* canonicals', () => {
    const seeded = seedLegacyRecallAdd();

    const r = runDriver(['recall_install_omp_platform']);
    expect(r.status).toBe(0);
    expect(() => lstatSync(seeded.ompLegacyDir)).toThrow();
    expect(existsSync(seeded.legacyCanonicalDir)).toBe(false);
    expect(lstatSync(join(ompConfigDir, 'skills', 'do-recall-stats', 'SKILL.md')).isSymbolicLink()).toBe(true);
    expect(() => lstatSync(join(ompConfigDir, 'skills', 'recall-add', 'SKILL.md'))).toThrow();
  });

  // Red-team: _recall_copy_skill_files returns 0 when agent-skills/ is absent,
  // so cleanup at the end of copy never runs; omp then re-links leftover
  // recall-* canonicals. The production path must still converge.
  test('omp install converges leftover recall-* when agent-skills source is missing', () => {
    const seeded = seedLegacyRecallAdd();
    rmSync(join(fakeRepo, 'agent-skills'), { recursive: true, force: true });

    const r = runDriver(['recall_install_omp_platform']);
    expect(r.status).toBe(0);
    expect(() => lstatSync(seeded.ompLegacyDir)).toThrow();
    expect(existsSync(seeded.legacyCanonicalDir)).toBe(false);
    expect(() => lstatSync(join(ompConfigDir, 'skills', 'recall-add', 'SKILL.md'))).toThrow();
  });

  // Red-team: plugin-active install unlinks ~/.claude/skills and returns, but
  // leftover recall-* managed links must still be gone.
  test('plugin-active install still removes managed recall-* links', () => {
    const first = runDriver(['recall_install_claude_skills']);
    expect(first.status).toBe(0);
    expect(lstatSync(join(claudeDir, 'skills', 'do-recall-doctor', 'SKILL.md')).isSymbolicLink()).toBe(true);

    const seeded = seedLegacyRecallAdd();
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'recall@recall-marketplace': [{ scope: 'user', version: '0.10.0' }] },
      }),
    );

    const r = runDriver(['recall_install_claude_skills']);
    expect(r.status).toBe(0);
    expect(() => lstatSync(seeded.claudeLegacy)).toThrow();
    expect(existsSync(join(claudeDir, 'skills', 'recall-add', 'notes.md'))).toBe(true);
    expect(() => lstatSync(join(claudeDir, 'skills', 'do-recall-doctor', 'SKILL.md'))).toThrow();
    expect(existsSync(join(recallDir, 'shared', 'skills', 'do-recall-doctor', 'SKILL.md'))).toBe(true);
    expect(existsSync(seeded.legacyCanonicalDir)).toBe(false);
  });
});

describe('Agent Skills uninstall (uninstall.sh)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let recallDir: string;
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
          RECALL_DIR: recallDir,
          RECALL_SKIP_BUN_UNLINK: 'true',
          ...extraEnv,
        },
      },
    );
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  function plantManagedSkill(skillsRoot: string, name: string): { skillMd: string; dir: string } {
    const canonical = join(recallDir, 'shared', 'skills', name, 'SKILL.md');
    mkdirSync(join(recallDir, 'shared', 'skills', name), { recursive: true });
    writeFileSync(canonical, `# ${name}\n`);
    const dir = join(skillsRoot, name);
    mkdirSync(dir, { recursive: true });
    const skillMd = join(dir, 'SKILL.md');
    symlinkSync(canonical, skillMd);
    return { skillMd, dir };
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-skills-uninstall-'));
    claudeDir = join(tempRoot, '.claude');
    recallDir = join(tempRoot, '.agents', 'Recall');
    backupBase = join(claudeDir, 'backups', 'recall');
    mkdirSync(backupBase, { recursive: true });
    plantManagedSkill(join(claudeDir, 'skills'), 'do-recall-doctor');
    mkdirSync(join(claudeDir, 'skills', 'some-other-skill'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'some-other-skill', 'SKILL.md'), '# not ours');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('removes only Recall-owned skill directories, preserves foreign ones', () => {
    const r = runUninstall();
    expect(r.status).toBe(0);
    expect(existsSync(join(claudeDir, 'skills', 'do-recall-doctor'))).toBe(false);
    expect(existsSync(join(claudeDir, 'skills', 'some-other-skill', 'SKILL.md'))).toBe(true);
  });

  test('--dry-run narrates without touching the filesystem', () => {
    const r = runUninstall(['--dry-run']);
    expect(r.status).toBe(0);
    expect(existsSync(join(claudeDir, 'skills', 'do-recall-doctor', 'SKILL.md'))).toBe(true);
  });

  test('legacy pre-rename recall-* skill dirs are removed too', () => {
    plantManagedSkill(join(claudeDir, 'skills'), 'recall-doctor');
    const r = runUninstall();
    expect(r.status).toBe(0);
    expect(existsSync(join(claudeDir, 'skills', 'recall-doctor'))).toBe(false);
    expect(existsSync(join(claudeDir, 'skills', 'do-recall-doctor'))).toBe(false);
  });

  // Red-team: install cleanup preserves user notes.md next to a managed SKILL.md
  // link; uninstall rm -rf of the named dir destroyed that file.
  test('uninstall preserves user notes.md beside a managed recall-* skill link', () => {
    const planted = plantManagedSkill(join(claudeDir, 'skills'), 'recall-add');
    writeFileSync(join(planted.dir, 'notes.md'), 'mine');
    const r = runUninstall();
    expect(r.status).toBe(0);
    expect(() => lstatSync(planted.skillMd)).toThrow();
    expect(existsSync(join(planted.dir, 'notes.md'))).toBe(true);
  });

  test('without --skip-omp, both eras are removed from the omp skills root', () => {
    const ompSkills = join(tempRoot, '.omp', 'agent', 'skills');
    plantManagedSkill(ompSkills, 'do-recall-stats');
    const leftover = plantManagedSkill(ompSkills, 'recall-add');
    writeFileSync(join(leftover.dir, 'notes.md'), 'mine');
    mkdirSync(join(ompSkills, 'user-skill'), { recursive: true });
    writeFileSync(join(ompSkills, 'user-skill', 'SKILL.md'), '# mine');

    const r = spawnSync(
      'bash',
      [UNINSTALL, '--no-confirm', '--skip-opencode', '--skip-pi'],
      {
        encoding: 'utf-8',
        cwd: REPO,
        env: {
          ...process.env,
          CLAUDE_DIR: claudeDir,
          BACKUP_BASE: backupBase,
          HOME: claudeDir,
          RECALL_DIR: recallDir,
          OMP_CONFIG_DIR: join(tempRoot, '.omp', 'agent'),
          RECALL_SKIP_BUN_UNLINK: 'true',
        },
      },
    );
    expect(r.status).toBe(0);
    expect(existsSync(join(ompSkills, 'do-recall-stats'))).toBe(false);
    expect(() => lstatSync(leftover.skillMd)).toThrow();
    expect(existsSync(join(leftover.dir, 'notes.md'))).toBe(true);
    expect(existsSync(join(ompSkills, 'user-skill', 'SKILL.md'))).toBe(true);
  });
});
