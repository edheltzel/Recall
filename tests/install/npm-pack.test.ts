// #35 — npm publish packaging.
//
// Two guarantees:
//   1. The `files` whitelist bundles the bash lifecycle scripts (the #162
//      shims delegate to update.sh / uninstall.sh / install.sh) + everything
//      lib/install-lib.sh reads, and excludes dev/local bloat.
//   2. Under a packaged layout (mimicking node_modules/<pkg>/ after `npm pack`
//      + extract), `recall update` / `uninstall` / `install` resolve the
//      BUNDLED scripts via resolveRepoRoot — proving the merged shims work
//      under npx / global install without a git checkout.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();

// CI runs `bun test` BEFORE the `bun run build` step, so dist/ may not exist
// yet. The published tarball always contains dist/ (prepublishOnly builds it),
// so build once here — unconditionally, so a stale dist/ can't mask a current
// source change — to make the packaging assertions faithful and deterministic.
// Explicit 180s timeout: a cold `bun run build` on the macOS CI runner exceeds
// bun:test's default 5s hook timeout (timeout, not a build error).
beforeAll(() => {
  execFileSync('bun', ['run', 'build'], { cwd: REPO, stdio: 'ignore' });
}, 180_000);

function packFileList(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO,
    encoding: 'utf-8',
  });
  const data = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return data[0].files.map(f => f.path);
}

describe('npm package: files whitelist', () => {
  let files: string[];
  beforeAll(() => {
    files = packFileList();
  });

  const has = (p: string) => files.some(f => f === p || f.startsWith(`${p}/`));
  const hasUnder = (prefix: string) => files.some(f => f.startsWith(prefix));

  test('bundles the 3 lifecycle scripts + shared install library (the #162 fix)', () => {
    expect(has('install.sh')).toBe(true);
    expect(has('update.sh')).toBe(true);
    expect(has('uninstall.sh')).toBe(true);
    expect(has('lib/install-lib.sh')).toBe(true);
  });

  test('bundles the runtime assets install.sh / install-lib.sh read', () => {
    expect(hasUnder('dist/')).toBe(true);
    expect(hasUnder('hooks/lib/')).toBe(true); // hooks need their lib/ subtree
    expect(hasUnder('commands/Recall/')).toBe(true);
    expect(hasUnder('opencode/')).toBe(true);
    expect(hasUnder('pi/')).toBe(true);
    expect(has('FOR_CLAUDE.md')).toBe(true);
    expect(has('FOR_OPENCODE.md')).toBe(true);
    expect(has('FOR_PI.md')).toBe(true);
  });

  test('excludes dev / local bloat', () => {
    for (const bad of [
      'tests/',
      'assets/',
      'benchmarks/',
      'docs/',
      'scripts/',
      '.agents/',
      '.claude/',
    ]) {
      expect(hasUnder(bad)).toBe(false);
    }
  });
});

describe('npm package: shims resolve bundled scripts under a packaged layout', () => {
  let stage: string; // tmpdir holding the .tgz, extracted package/, and a bin/
  let pkgRoot: string; // <stage>/package — mimics node_modules/<pkg>/
  let binLink: string; // <stage>/bin/recall — mimics a global-install bin symlink

  beforeAll(() => {
    // dist/ is guaranteed by the file-level beforeAll above. Pack + extract to
    // mimic a node_modules/<pkg>/ install.
    stage = mkdtempSync(join(tmpdir(), 'recall-pack-'));
    execFileSync('npm', ['pack', '--pack-destination', stage], {
      cwd: REPO,
      stdio: 'ignore',
    });
    const tgz = readdirSync(stage).find(f => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack produced no .tgz');
    execFileSync('tar', ['-xzf', join(stage, tgz), '-C', stage]);
    pkgRoot = join(stage, 'package'); // npm tarballs root every entry under package/

    const binDir = join(stage, 'bin');
    mkdirSync(binDir, { recursive: true });
    binLink = join(binDir, 'recall');
    symlinkSync(join(pkgRoot, 'dist', 'index.js'), binLink);
  });

  afterAll(() => {
    if (stage) rmSync(stage, { recursive: true, force: true });
  });

  // Child env with RECALL_REPO_DIR stripped, so we exercise the dist-relative
  // derivation (not the override) unless a test sets it explicitly.
  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
    delete e.RECALL_REPO_DIR;
    return e;
  }

  function runBin(binPath: string, args: string[], e: NodeJS.ProcessEnv) {
    const r = spawnSync('bun', [binPath, ...args], { encoding: 'utf-8', env: e });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  test('bundled package resolves update.sh (npx realpath case)', () => {
    const r = runBin(join(pkgRoot, 'dist', 'index.js'), ['update', '--help'], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Recall Update Script');
  });

  test('bundled package resolves install.sh via `recall install`', () => {
    const r = runBin(join(pkgRoot, 'dist', 'index.js'), ['install', '--help'], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Recall Install Script');
  });

  test('bundled package resolves uninstall.sh (dry-run, no mutation)', () => {
    const home = mkdtempSync(join(tmpdir(), 'recall-home-'));
    try {
      const r = runBin(
        join(pkgRoot, 'dist', 'index.js'),
        ['uninstall', '--dry-run', '--no-confirm', '--skip-opencode', '--skip-pi'],
        env({ HOME: home, CLAUDE_DIR: join(home, '.claude'), RECALL_SKIP_BUN_UNLINK: 'true' }),
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('DRY-RUN');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('global-bin symlink layout resolves bundled scripts (realpath derivation)', () => {
    const r = runBin(binLink, ['update', '--help'], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Recall Update Script');
  });

  test('RECALL_REPO_DIR override is the guaranteed fallback for any layout', () => {
    // Run from the bin symlink but force the override — the documented escape
    // hatch when a runtime preserves symlinks instead of resolving realpath.
    const r = runBin(binLink, ['update', '--help'], env({ RECALL_REPO_DIR: pkgRoot }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Recall Update Script');
  });
});
