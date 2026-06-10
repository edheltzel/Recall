// Unit tests for the symlink-repair primitive used by `recall doctor --fix`.
//
// We test probeSymlink() in isolation rather than invoking runDoctor end-to-end
// because the rest of doctor's checks reach for the real $HOME (Ollama, MCP
// settings, …), which we can't redirect cleanly from a unit test. The probe
// is pure with respect to its inputs, so direct testing covers the contract.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { probeSymlink } from '../../src/commands/doctor';

let tempDir: string;
let canonical: string;
let target: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-probe-'));
  mkdirSync(join(tempDir, 'canonical-dir'), { recursive: true });
  mkdirSync(join(tempDir, 'target-dir'), { recursive: true });
  canonical = join(tempDir, 'canonical-dir', 'thing.ts');
  target = join(tempDir, 'target-dir', 'thing.ts');
  writeFileSync(canonical, '// canonical content');
});

afterEach(() => {
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function probe() {
  return probeSymlink({ label: 'thing', target, canonical });
}

describe('probeSymlink', () => {
  test('target missing → WARN + repair creates symlink', () => {
    const { result, repair } = probe();
    expect(result.status).toBe('WARN');
    expect(repair).toBeDefined();
    const fixed = repair!();
    expect(fixed.status).toBe('PASS');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(canonical);
  });

  test('canonical missing → INFO (no repair)', () => {
    rmSync(canonical);
    const { result, repair } = probe();
    expect(result.status).toBe('INFO');
    expect(repair).toBeUndefined();
  });

  test('correct symlink already in place → PASS (no repair)', () => {
    symlinkSync(canonical, target);
    const { result, repair } = probe();
    expect(result.status).toBe('PASS');
    expect(repair).toBeUndefined();
  });

  test('regular file identical to canonical → WARN + repair converts to symlink', () => {
    writeFileSync(target, '// canonical content');
    const { result, repair } = probe();
    expect(result.status).toBe('WARN');
    expect(repair).toBeDefined();
    const fixed = repair!();
    expect(fixed.status).toBe('PASS');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(canonical);
  });

  test('regular file drifted from canonical → WARN with "Drifted" message', () => {
    writeFileSync(target, '// user-edited content (drift)');
    const { result, repair } = probe();
    expect(result.status).toBe('WARN');
    expect(result.message.toLowerCase()).toContain('drifted');
    expect(repair).toBeDefined();
    // Note: the repair function tries to back up to ~/.agents/Recall/backups,
    // which goes outside this tmpdir. We assert only on the contract surface
    // (status + message + repair availability), not on the side-effects of
    // running the repair fn, because backup-path mocking is out of scope.
  });

  test('foreign symlink (points elsewhere) → WARN', () => {
    const decoy = join(tempDir, 'decoy.ts');
    writeFileSync(decoy, '// decoy');
    symlinkSync(decoy, target);
    const { result } = probe();
    expect(result.status).toBe('WARN');
    expect(result.message.toLowerCase()).toContain('foreign');
  });
});
