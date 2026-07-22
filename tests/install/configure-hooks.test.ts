// Regression: install.sh configure_hooks() must be per-hook idempotent.
//
// Pre-0.7.0.1 bug: a blanket `grep -q RecallExtract ... return` short-circuit
// ran AFTER copying hook files but BEFORE registering RecallTelosSync, RecallStart,
// and RecallPreCompact. Any re-install where RecallExtract was already in
// settings.json silently skipped the other three — leaving v0.7.0's tiered
// RecallStart architecturally inactive despite passing fresh-install tests.
//
// These tests drive the bash function directly against a tmpdir-scoped
// CLAUDE_DIR + fake repo layout, exercising both the fresh-install and
// re-install paths.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const INSTALL_LIB = join(process.cwd(), 'lib', 'install-lib.sh');
const HOOK_NAMES = [
  'RecallExtract',
  'RecallBatchExtract',
  'RecallTelosSync',
  'RecallStart',
  'RecallPreCompact',
  'RecallClearExtract',
] as const;

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

describe('install.sh configure_hooks()', () => {
  let tempRoot: string;
  let claudeDir: string;
  let recallDir: string;
  let fakeRepo: string;
  let settingsFile: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-install-'));

    // Target filesystem layout that install.sh operates on
    claudeDir = join(tempRoot, '.claude');
    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    settingsFile = join(claudeDir, 'settings.json');

    // Recall's canonical install root. install-lib.sh defaults this to
    // $HOME/.agents/Recall; the driver below overrides RECALL_DIR to it so the
    // canonical hook copies stay inside the sandbox instead of the real install.
    recallDir = join(tempRoot, '.agents', 'Recall');

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
    mkdirSync(join(fakeRepo, 'hooks', 'lib', 'hosts', 'claude'), { recursive: true });
    writeFileSync(join(fakeRepo, 'hooks', 'lib', 'hosts', 'claude', 'provider.ts'), '// nested stub');
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
      // Sandbox every path install-lib.sh can derive. CLAUDE_DIR alone is NOT
      // enough: configure_hooks copies the canonical hooks to
      // $RECALL_DIR/shared/hooks, and RECALL_DIR defaults to $HOME/.agents/Recall.
      // Without these HOME + RECALL_DIR overrides, sourcing install-lib.sh and
      // running configure_hooks() copies this test's stub fixtures straight onto
      // the user's REAL ~/.agents/Recall install (which is how the live hooks
      // were once overwritten with stubs).
      `export HOME="${tempRoot}"`,
      `export CLAUDE_DIR="${claudeDir}"`,
      `export RECALL_DIR="${recallDir}"`,
      // install-lib.sh resolves its source files via $RECALL_REPO_DIR
      // (anchored on BASH_SOURCE, not $(pwd) — the cwd-fragility fix that
      // caused install/update to skip the slash-command loop when invoked
      // from a non-repo cwd). Sandbox it to the fake repo so the canonical
      // copies come from the test fixtures, not the real repo on disk.
      `export RECALL_REPO_DIR="${fakeRepo}"`,
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

    expect(stop.some(c => c.includes('RecallExtract'))).toBe(true);
    expect(start.some(c => c.includes('RecallTelosSync'))).toBe(true);
    expect(start.some(c => c.includes('RecallStart'))).toBe(true);
    expect(pre.some(c => c.includes('RecallPreCompact'))).toBe(true);
  });

  test('re-install with RecallExtract present: the other three are still registered (regresses the pre-0.7.0.1 early-return bug)', () => {
    // First run gets everything into settings.json.
    runConfigureHooks();

    // Simulate the drift state that the original bug produced: RecallExtract
    // is registered in Stop, but SessionStart / PreCompact were wiped (or
    // never made it in because a previous buggy install aborted before them).
    const pre = readSettings() as { hooks?: Record<string, unknown> };
    pre.hooks = pre.hooks ?? {};
    (pre.hooks as Record<string, unknown[]>).SessionStart = [];
    (pre.hooks as Record<string, unknown[]>).PreCompact = [];
    writeFileSync(settingsFile, JSON.stringify(pre, null, 2));

    // Re-run configure_hooks(). Pre-0.7.0.1 this early-returned after finding
    // RecallExtract, leaving the three below permanently unregistered.
    const r = runConfigureHooks();
    expect(r.status).toBe(0);

    const s = readSettings();
    const start = hooksForEvent(s, 'SessionStart');
    const preCompact = hooksForEvent(s, 'PreCompact');
    const stop = hooksForEvent(s, 'Stop');

    // The critical assertions — these would ALL be empty/false under the
    // pre-fix behavior.
    expect(start.some(c => c.includes('RecallTelosSync'))).toBe(true);
    expect(start.some(c => c.includes('RecallStart'))).toBe(true);
    expect(preCompact.some(c => c.includes('RecallPreCompact'))).toBe(true);

    // RecallExtract still there (no regression on the happy path).
    expect(stop.some(c => c.includes('RecallExtract'))).toBe(true);
  });

  test('idempotent: running twice does not duplicate any hook entry', () => {
    runConfigureHooks();
    runConfigureHooks();

    const s = readSettings();
    const countIncludes = (event: string, needle: string): number =>
      hooksForEvent(s, event).filter(c => c.includes(needle)).length;

    expect(countIncludes('Stop', 'RecallExtract')).toBe(1);
    expect(countIncludes('SessionStart', 'RecallTelosSync')).toBe(1);
    expect(countIncludes('SessionStart', 'RecallStart')).toBe(1);
    expect(countIncludes('PreCompact', 'RecallPreCompact')).toBe(1);
    expect(countIncludes('SessionStart', 'RecallClearExtract')).toBe(1);
  });

  test('RecallClearExtract is registered on SessionStart with matcher="clear"', () => {
    runConfigureHooks();
    const s = readSettings();
    const sessionStart = ((s as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> }).hooks?.SessionStart) ?? [];
    const clearEntry = sessionStart.find(entry =>
      (entry.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes('RecallClearExtract'))
    );
    expect(clearEntry).toBeDefined();
    expect(clearEntry!.matcher).toBe('clear');

    // Sanity: the other SessionStart hooks have matcher="" so they fire on all sources.
    const recallEntry = sessionStart.find(entry =>
      (entry.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes('RecallStart'))
    );
    expect(recallEntry).toBeDefined();
    expect(recallEntry!.matcher).toBe('');
  });

  // Regression: configure_hooks() copies the canonical hooks to
  // $RECALL_DIR/shared/hooks. RECALL_DIR defaults to $HOME/.agents/Recall, so a
  // harness that sandboxes CLAUDE_DIR but not RECALL_DIR copies these stub
  // fixtures onto the user's real install — exactly the bug that left the live
  // hooks as `// stub RecallExtract` no-ops. This asserts the copies, and the
  // platform symlinks back to them, are confined to the sandbox.
  test('configure_hooks confines canonical hook copies to the sandboxed RECALL_DIR', () => {
    const r = runConfigureHooks();
    expect(r.status).toBe(0);

    const canonicalDir = join(recallDir, 'shared', 'hooks');
    for (const name of HOOK_NAMES) {
      const canonical = join(canonicalDir, `${name}.ts`);
      expect(existsSync(canonical)).toBe(true);
      // The copy is our fake-repo fixture — proof it came from the sandbox source.
      expect(readFileSync(canonical, 'utf-8')).toBe(`// stub ${name}`);
    }

    // The ~/.claude/hooks symlink must resolve back inside the sandbox, never out.
    // Resolve tempRoot too: macOS canonicalizes /var -> /private/var in realpath.
    const resolved = realpathSync(join(claudeDir, 'hooks', 'RecallExtract.ts'));
    expect(resolved.startsWith(realpathSync(tempRoot))).toBe(true);

    const nestedCanonical = join(canonicalDir, 'lib', 'hosts', 'claude', 'provider.ts');
    expect(readFileSync(nestedCanonical, 'utf-8')).toBe('// nested stub');
    expect(realpathSync(join(claudeDir, 'hooks', 'lib', 'hosts', 'claude', 'provider.ts')))
      .toBe(realpathSync(nestedCanonical));
  });
});
