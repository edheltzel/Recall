// Regression: install.sh configure_hooks() must be per-hook idempotent.
//
// Pre-0.7.0.1 bug: a blanket `grep -q SessionExtract ... return` short-circuit
// ran AFTER copying hook files but BEFORE registering TelosSync, SessionRecall,
// and SessionPreCompact. Any re-install where SessionExtract was already in
// settings.json silently skipped the other three — leaving v0.7.0's tiered
// SessionRecall architecturally inactive despite passing fresh-install tests.
//
// These tests drive the bash function directly against a tmpdir-scoped
// CLAUDE_DIR + fake repo layout, exercising both the fresh-install and
// re-install paths.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const INSTALL_LIB = join(process.cwd(), 'lib', 'install-lib.sh');
const HOOK_NAMES = [
  'SessionExtract',
  'BatchExtract',
  'TelosSync',
  'SessionRecall',
  'SessionPreCompact',
  'ClearExtract',
] as const;

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

describe('install.sh configure_hooks()', () => {
  let tempRoot: string;
  let claudeDir: string;
  let fakeRepo: string;
  let settingsFile: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-install-'));

    // Target filesystem layout that install.sh operates on
    claudeDir = join(tempRoot, '.claude');
    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    settingsFile = join(claudeDir, 'settings.json');

    // Fake source checkout: install.sh reads $(pwd)/hooks for the file copies
    fakeRepo = join(tempRoot, 'repo');
    mkdirSync(join(fakeRepo, 'hooks', 'lib'), { recursive: true });
    for (const name of HOOK_NAMES) {
      writeFileSync(join(fakeRepo, 'hooks', `${name}.ts`), `// stub ${name}`);
    }
    writeFileSync(join(fakeRepo, 'hooks', 'extract_prompt.md'), '# stub');
    // install.sh does `cp hooks/lib/*.ts` which would fail if the glob expands
    // to nothing. Mirror the real repo layout by dropping one stub shared lib.
    writeFileSync(join(fakeRepo, 'hooks', 'lib', 'stub.ts'), '// stub');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // Source lib/install-lib.sh and drive configure_hooks() against a
  // tmpdir-scoped CLAUDE_DIR + fake repo layout. The library respects
  // pre-set CLAUDE_DIR and pre-existing log_* function definitions, so we
  // stub the loggers to no-ops first and then source.
  //
  // Write the driver to a file and invoke it with `bash <path>` to keep shell
  // quoting predictable across Bun's spawnSync and platforms.
  function runConfigureHooks(): RunResult {
    const driverPath = join(tempRoot, 'drive.sh');
    const driver = [
      '#!/usr/bin/env bash',
      'set -eo pipefail',
      `export CLAUDE_DIR="${claudeDir}"`,
      `cd "${fakeRepo}"`,
      'log_success() { :; }',
      'log_warn()    { :; }',
      'log_info()    { :; }',
      'log_error()   { :; }',
      `source "${INSTALL_LIB}"`,
      'configure_hooks',
    ].join('\n');
    writeFileSync(driverPath, driver, { mode: 0o755 });

    const r = spawnSync('bash', [driverPath], { encoding: 'utf-8' });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status ?? 1,
    };
  }

  function readSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
  }

  function hooksForEvent(settings: Record<string, unknown>, event: string): string[] {
    const hooks = (settings as { hooks?: Record<string, unknown[]> }).hooks ?? {};
    const entries = hooks[event] ?? [];
    const commands: string[] = [];
    for (const entry of entries) {
      const inner = (entry as { hooks?: Array<{ command?: string }> }).hooks ?? [];
      for (const h of inner) {
        if (typeof h.command === 'string') commands.push(h.command);
      }
    }
    return commands;
  }

  test('fresh install: all four hooks land in settings.json', () => {
    const r = runConfigureHooks();
    expect(r.status).toBe(0);

    const s = readSettings();
    const stop = hooksForEvent(s, 'Stop');
    const start = hooksForEvent(s, 'SessionStart');
    const pre = hooksForEvent(s, 'PreCompact');

    expect(stop.some(c => c.includes('SessionExtract'))).toBe(true);
    expect(start.some(c => c.includes('TelosSync'))).toBe(true);
    expect(start.some(c => c.includes('SessionRecall'))).toBe(true);
    expect(pre.some(c => c.includes('SessionPreCompact'))).toBe(true);
  });

  test('re-install with SessionExtract present: the other three are still registered (regresses the pre-0.7.0.1 early-return bug)', () => {
    // First run gets everything into settings.json.
    runConfigureHooks();

    // Simulate the drift state that the original bug produced: SessionExtract
    // is registered in Stop, but SessionStart / PreCompact were wiped (or
    // never made it in because a previous buggy install aborted before them).
    const pre = readSettings() as { hooks?: Record<string, unknown> };
    pre.hooks = pre.hooks ?? {};
    (pre.hooks as Record<string, unknown[]>).SessionStart = [];
    (pre.hooks as Record<string, unknown[]>).PreCompact = [];
    writeFileSync(settingsFile, JSON.stringify(pre, null, 2));

    // Re-run configure_hooks(). Pre-0.7.0.1 this early-returned after finding
    // SessionExtract, leaving the three below permanently unregistered.
    const r = runConfigureHooks();
    expect(r.status).toBe(0);

    const s = readSettings();
    const start = hooksForEvent(s, 'SessionStart');
    const preCompact = hooksForEvent(s, 'PreCompact');
    const stop = hooksForEvent(s, 'Stop');

    // The critical assertions — these would ALL be empty/false under the
    // pre-fix behavior.
    expect(start.some(c => c.includes('TelosSync'))).toBe(true);
    expect(start.some(c => c.includes('SessionRecall'))).toBe(true);
    expect(preCompact.some(c => c.includes('SessionPreCompact'))).toBe(true);

    // SessionExtract still there (no regression on the happy path).
    expect(stop.some(c => c.includes('SessionExtract'))).toBe(true);
  });

  test('idempotent: running twice does not duplicate any hook entry', () => {
    runConfigureHooks();
    runConfigureHooks();

    const s = readSettings();
    const countIncludes = (event: string, needle: string): number =>
      hooksForEvent(s, event).filter(c => c.includes(needle)).length;

    expect(countIncludes('Stop', 'SessionExtract')).toBe(1);
    expect(countIncludes('SessionStart', 'TelosSync')).toBe(1);
    expect(countIncludes('SessionStart', 'SessionRecall')).toBe(1);
    expect(countIncludes('PreCompact', 'SessionPreCompact')).toBe(1);
    expect(countIncludes('SessionStart', 'ClearExtract')).toBe(1);
  });

  test('ClearExtract is registered on SessionStart with matcher="clear"', () => {
    runConfigureHooks();
    const s = readSettings();
    const sessionStart = ((s as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> }).hooks?.SessionStart) ?? [];
    const clearEntry = sessionStart.find(entry =>
      (entry.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes('ClearExtract'))
    );
    expect(clearEntry).toBeDefined();
    expect(clearEntry!.matcher).toBe('clear');

    // Sanity: the other SessionStart hooks have matcher="" so they fire on all sources.
    const recallEntry = sessionStart.find(entry =>
      (entry.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes('SessionRecall'))
    );
    expect(recallEntry).toBeDefined();
    expect(recallEntry!.matcher).toBe('');
  });
});
