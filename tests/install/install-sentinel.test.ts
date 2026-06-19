// Completion sentinel for interrupt-safe installs (issue #27).
//
// Recall heals a partial install on a plain re-run (every step runs
// unconditionally; the copy/link primitives are idempotent). The one uncovered
// gap is an interrupt *before* the post-install self-check (SIGKILL, closed
// terminal, power loss): nothing durable recorded that an install was in
// flight. The sentinel ($RECALL_DIR/.install-incomplete) closes that gap.
//
// These tests drive the install-lib.sh helpers directly against a tmpdir-scoped
// HOME / CLAUDE_DIR / RECALL_DIR, mirroring tests/install/configure-hooks.test.ts.
// Running the full install.sh (bun install/build/link, recall init) is out of
// scope here — we exercise the sentinel primitives and the real copy/link loop
// that reproduces #27's exact filesystem state.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const INSTALL_LIB = join(process.cwd(), 'lib', 'install-lib.sh');
const INSTALL_SH = join(process.cwd(), 'install.sh');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

describe('install.sh completion sentinel (#27)', () => {
  let tempRoot: string;
  let claudeDir: string;
  let recallDir: string;
  let fakeRepo: string;
  let marker: string;
  let cmdCanonical: string;
  let cmdTarget: string;
  let driverSeq = 0;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-sentinel-'));
    claudeDir = join(tempRoot, '.claude');
    recallDir = join(tempRoot, '.agents', 'Recall');
    fakeRepo = join(tempRoot, 'repo');
    marker = join(recallDir, '.install-incomplete');
    cmdCanonical = join(recallDir, 'claude', 'commands', 'Recall', 'scout.md');
    cmdTarget = join(claudeDir, 'commands', 'Recall', 'scout.md');

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(fakeRepo, 'commands', 'Recall'), { recursive: true });
    writeFileSync(join(fakeRepo, 'commands', 'Recall', 'scout.md'), '# scout\n');
    writeFileSync(join(fakeRepo, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // Source install-lib.sh against the sandbox and run the given body lines.
  // Real loggers stay in place (NO_COLOR=1 strips ANSI) so we can assert on
  // their output.
  function runDriver(body: string[]): RunResult {
    const driverPath = join(tempRoot, `drive-${++driverSeq}.sh`);
    const driver = [
      '#!/usr/bin/env bash',
      'set -eo pipefail',
      `export HOME="${tempRoot}"`,
      `export CLAUDE_DIR="${claudeDir}"`,
      `export RECALL_DIR="${recallDir}"`,
      `export RECALL_REPO_DIR="${fakeRepo}"`,
      'export NO_COLOR=1',
      `source "${INSTALL_LIB}"`,
      ...body,
    ].join('\n');
    writeFileSync(driverPath, driver, { mode: 0o755 });
    const r = spawnSync('bash', [driverPath], { encoding: 'utf-8' });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  // ── Sentinel lifecycle ─────────────────────────────────────────────────────

  test('mark writes a marker with timestamp + version; clear removes it', () => {
    const r = runDriver(['recall_mark_install_incomplete']);
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const content = readFileSync(marker, 'utf-8');
    expect(content).toContain('interrupted_at=');
    expect(content).toContain('version=');

    const r2 = runDriver(['recall_mark_install_incomplete', 'recall_clear_install_marker']);
    expect(r2.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('happy-path proxy: finalize(true) clears the marker', () => {
    const r = runDriver(['recall_mark_install_incomplete', 'recall_finalize_install true']);
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  // ── Stale-marker warning ───────────────────────────────────────────────────

  test('warn is silent when no marker is present', () => {
    const r = runDriver(['recall_warn_if_install_incomplete', 'echo SENTINEL_DONE']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SENTINEL_DONE');
    expect(r.stdout).not.toContain('did not finish');
  });

  test('warn fires (warn-only) when a stale marker is present, pointing at re-run', () => {
    const r = runDriver(['recall_mark_install_incomplete', 'recall_warn_if_install_incomplete']);
    expect(r.status).toBe(0); // warn-only: never aborts, never auto-repairs
    expect(r.stdout).toContain('did not finish');
    expect(r.stdout).toContain('re-run ./install.sh');
    expect(existsSync(marker)).toBe(true); // left in place; not auto-cleared
  });

  // ── Interrupt simulation + self-heal (the load-bearing pair) ────────────────

  test('interrupt mid-Commands-step leaves a canonical with no symlink, marker present', () => {
    // Reproduce #27's exact state: mark in-flight, copy the canonical, then die
    // before recall_link (the non-atomic window between copy and link).
    const r = runDriver([
      'recall_create_install_root',
      'recall_mark_install_incomplete',
      `recall_copy_canonical "$RECALL_REPO_DIR/commands/Recall/scout.md" "${cmdCanonical}"`,
      '# interrupted here — before recall_link',
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);            // durable incompleteness signal
    expect(existsSync(cmdCanonical)).toBe(true);      // canonical landed
    expect(existsSync(cmdTarget)).toBe(false);        // symlink never created
  });

  test('re-run heals the missing symlink and clears the marker', () => {
    // First: the interrupted state from the test above.
    runDriver([
      'recall_create_install_root',
      'recall_mark_install_incomplete',
      `recall_copy_canonical "$RECALL_REPO_DIR/commands/Recall/scout.md" "${cmdCanonical}"`,
    ]);
    expect(existsSync(cmdTarget)).toBe(false);

    // Then: a convergence pass runs the full copy→link loop and finalizes.
    const r = runDriver([
      'recall_create_install_root',
      'recall_mark_install_incomplete',
      `recall_copy_canonical "$RECALL_REPO_DIR/commands/Recall/scout.md" "${cmdCanonical}"`,
      `recall_link "${cmdTarget}" "${cmdCanonical}"`,
      'recall_finalize_install true',
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(cmdTarget)).toBe(true);
    expect(lstatSync(cmdTarget).isSymbolicLink()).toBe(true);
    expect(readlinkSync(cmdTarget)).toBe(cmdCanonical);
    expect(existsSync(marker)).toBe(false); // gate passed → marker cleared
  });

  // ── Gate fails loudly (OQ#3) ────────────────────────────────────────────────

  test('finalize(false) exits non-zero, preserves the marker, and prints recovery', () => {
    const r = runDriver(['recall_mark_install_incomplete', 'recall_finalize_install false']);
    expect(r.status).not.toBe(0);             // no more "installed with warnings"
    expect(existsSync(marker)).toBe(true);    // marker left for the next run / doctor
    expect(r.stderr).toContain('re-run ./install.sh'); // recovery via log_error → stderr
  });

  // ── DRY: one canonical recovery story ───────────────────────────────────────

  test('recovery wording has a single source of truth (recall_print_recovery)', () => {
    const src = readFileSync(INSTALL_LIB, 'utf-8');
    // The "alternative" line is unique to recall_print_recovery; it must not be
    // hand-copied into recall_verify_install or the stale-marker warning.
    const alt = src.match(/Alternative: run 'recall doctor --fix'/g) ?? [];
    expect(alt.length).toBe(1);
    // Definition + the three callers (verify gate, stale warning, finalizer).
    const refs = src.match(/recall_print_recovery/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(4);
  });

  // ── Regression: no new step-skip ────────────────────────────────────────────
  //
  // #27's premise — a "step already done" early-return that skips the symlink
  // half — does not exist; every _step runs unconditionally. This guards against
  // anyone removing or skip-wrapping a step. (A true runtime double-run assertion
  // needs the full installer — bun install/build/link — and is out of unit scope.)
  test('install.sh still invokes every core step unconditionally', () => {
    const src = readFileSync(INSTALL_SH, 'utf-8');
    for (const step of [
      'Backup', 'Migrate', 'Installing', 'Building', 'Linking', 'Database',
      'MCP', 'Hooks', 'Guide', 'Commands', 'CLAUDE.md',
    ]) {
      expect(src).toContain(`_step "${step}"`);
    }
    // The sentinel must not gate any step behind a "skip if already installed"
    // early return — there is no such return inside do_install.
    const doInstall = src.slice(src.indexOf('do_install() {'));
    expect(doInstall).not.toContain('already installed; skipping');
  });

  // Ordering guard: the marker must be written BEFORE the first artifact-mutating
  // step (recall_auto_migrate) and AFTER the install root exists. A future
  // reorder that moves the mark after a mutating step would silently reopen #27
  // (an interrupt during that step would leave no incompleteness signal).
  test('install.sh writes the sentinel after the install root and before the first mutating step', () => {
    const src = readFileSync(INSTALL_SH, 'utf-8');
    const doInstall = src.slice(src.indexOf('do_install() {'));
    const rootIdx = doInstall.indexOf('recall_create_install_root');
    const markIdx = doInstall.indexOf('recall_mark_install_incomplete');
    const migrateIdx = doInstall.indexOf('recall_auto_migrate');
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThan(rootIdx);   // root exists before we mark
    expect(markIdx).toBeLessThan(migrateIdx);   // mark before the first mutation
  });
});
