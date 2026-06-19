// Unit tests for the completion-sentinel probe used by `recall doctor` (#27).
// probeInstallSentinel() is pure with respect to its arg (the marker path), so
// we drive it directly against a temp file rather than invoking runDoctor
// end-to-end — same approach as doctor-mcp-env.test.ts for probeMcpEnv.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeInstallSentinel } from '../../src/commands/doctor';

let tempDir: string;
let marker: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-doctor-sentinel-'));
  marker = join(tempDir, '.install-incomplete');
});

afterEach(() => {
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('probeInstallSentinel', () => {
  test('no marker → PASS', () => {
    const r = probeInstallSentinel(marker);
    expect(r.status).toBe('PASS');
    expect(r.message).toContain('No interrupted');
  });

  test('stale marker → WARN with recovery guidance', () => {
    writeFileSync(marker, 'interrupted_at=2026-06-19T00:00:00Z version=9.9.9\n');
    const r = probeInstallSentinel(marker);
    expect(r.status).toBe('WARN');
    expect(r.message).toContain('did not finish');
    expect(r.message).toContain('re-run ./install.sh');
  });

  test('stale marker WARN surfaces the recorded marker detail', () => {
    writeFileSync(marker, 'interrupted_at=2026-06-19T12:34:56Z version=9.9.9\n');
    const r = probeInstallSentinel(marker);
    expect(r.status).toBe('WARN');
    expect(r.message).toContain('version=9.9.9');
  });
});
