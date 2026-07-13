// Unit tests for the skill-surface floor probe used by `recall doctor` (#235).
// probeSkillSurface() is pure with respect to its arg (the install root), so we
// drive it directly against a temp root rather than invoking runDoctor
// end-to-end — same approach as doctor-install-sentinel.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeSkillSurface } from '../../src/commands/doctor';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recall-doctor-skills-'));
});

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('probeSkillSurface', () => {
  test('install root absent → INFO (nothing to check)', () => {
    const r = probeSkillSurface(join(root, 'does-not-exist'));
    expect(r.status).toBe('INFO');
  });

  test('root present but zero skill canonicals → WARN (blank command surface)', () => {
    const r = probeSkillSurface(root);
    expect(r.status).toBe('WARN');
    expect(r.message).toContain('command surface');
  });

  test('root with a skill canonical → PASS', () => {
    const skillDir = join(root, 'shared', 'skills', 'recall-scout');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# scout\n');
    const r = probeSkillSurface(root);
    expect(r.status).toBe('PASS');
    expect(r.message).toContain('1 agent skill file');
  });
});
