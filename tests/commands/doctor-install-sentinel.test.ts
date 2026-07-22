// Unit tests for the completion-sentinel probe used by `recall doctor` (#27).
// probeInstallSentinel() is pure with respect to its arg (the marker path), so
// we drive it directly against a temp file rather than invoking runDoctor
// end-to-end — same approach as doctor-mcp-env.test.ts for probeMcpEnv.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeInstallSentinel } from '../../src/commands/doctor';

const CLI_ENTRY = join(process.cwd(), 'src', 'index.ts');

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

// Behavioral guard (#27): a doctor WARN must NEVER become a non-zero exit. The
// sentinel marker is necessarily present during install's own self-check (it is
// cleared only after the check passes); if `recall doctor` ever mapped that WARN
// to a non-zero exit, the install self-check would read as a 100% failure. Run
// the real CLI in a subprocess with HOME pointed at a temp dir that contains the
// marker — a subprocess is required because bun snapshots $HOME at startup, so
// homedir() (which the probe uses) can't be redirected in-process.
describe('recall doctor exit code with a stale marker present', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'recall-doctor-exit-'));
    mkdirSync(join(home, '.agents', 'Recall'), { recursive: true });
    writeFileSync(
      join(home, '.agents', 'Recall', '.install-incomplete'),
      'interrupted_at=2026-06-19T00:00:00Z version=9.9.9\n',
    );
  });

  afterEach(() => {
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  test('exits 0 (WARN does not propagate to process exit code)', () => {
    const r = spawnSync('bun', ['run', CLI_ENTRY, 'doctor'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        RECALL_HOME: join(home, '.agents', 'Recall'),
        RECALL_DB_PATH: join(home, '.agents', 'Recall', 'recall.db'),
      },
    });
    expect(r.status).toBe(0);
    // And the run actually exercised the WARN path (marker was seen).
    expect(`${r.stdout}${r.stderr}`).toContain('did not finish');
  });
});
