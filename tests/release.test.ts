import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repo = join(import.meta.dir, '..');
const manifestPaths = ['package.json', 'plugins/recall/.codex-plugin/plugin.json', 'plugins/recall-claude/.claude-plugin/plugin.json'];
let stage: string;
let checkout: string;
let remote: string;
let env: Record<string, string>;

function command(binary: string, args: string[], cwd = checkout) {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  return { code: result.status, output: result.stdout + result.stderr, stdout: result.stdout.trim() };
}

function git(...args: string[]): string {
  const result = command('git', args);
  expect(result.code, result.output).toBe(0);
  return result.stdout;
}

function release(level = 'patch', ...options: string[]) {
  return command('npm', ['run', `release:${level}`, '--', ...options]);
}

beforeEach(() => {
  stage = mkdtempSync(join(tmpdir(), 'recall-release-'));
  checkout = join(stage, 'checkout');
  remote = join(stage, 'origin.git');
  const bin = join(stage, 'bin');
  for (const path of [checkout, bin, join(stage, 'home')]) mkdirSync(path, { recursive: true });
  env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: join(stage, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'release@example.invalid',
    RELEASE_REAL_GIT: Bun.which('git')!,
    RELEASE_REMOTE: remote, RELEASE_RECORD: join(stage, 'github-release.json'),
  };
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(process.env.FAIL_GH_AUTH ? 1 : 0);
if (args[0] === 'repo' && args[1] === 'view') { console.log('test/recall'); process.exit(0); }
if (args[0] === 'api') {
  if (process.env.FAIL_GH_API) { console.error('network unavailable'); process.exit(1); }
  console.log(process.env.RELEASE_TAGS ?? ''); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create') {
  if (process.env.FAIL_GH_RELEASE) { console.error('release creation unavailable'); process.exit(1); }
  const tag = args[2];
  const target = Bun.spawnSync(['git', '--git-dir', process.env.RELEASE_REMOTE, 'rev-parse', tag + '^{}']);
  if (target.exitCode !== 0) process.exit(1);
  const notes = await Bun.stdin.text();
  writeFileSync(process.env.RELEASE_RECORD, JSON.stringify({ tag, commit: target.stdout.toString().trim(), notes,
    latest: args.includes('--latest'), title: args[args.indexOf('--title') + 1] }));
  console.log('https://github.com/test/recall/releases/tag/' + tag); process.exit(0);
}
console.error('Unexpected gh invocation: ' + args.join(' ')); process.exit(1);
`, { mode: 0o755 });
  const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts;
  for (const [index, path] of manifestPaths.entries()) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), JSON.stringify(index === 0
      ? { name: 'release-fixture', version: '1.2.3', scripts: { ...Object.fromEntries(Object.entries(scripts).filter(([name]) => name.startsWith('release'))), lint: 'true', test: 'true', build: 'true' } }
      : { name: 'recall', version: '0.1.0' }, null, 2) + '\n');
  }
  mkdirSync(join(checkout, 'scripts'));
  mkdirSync(join(checkout, 'src', 'lib'), { recursive: true });
  copyFileSync(join(repo, 'scripts/release.ts'), join(checkout, 'scripts/release.ts'));
  copyFileSync(join(repo, 'src/lib/version-guard.ts'), join(checkout, 'src/lib/version-guard.ts'));
  writeFileSync(join(checkout, 'src/version.ts'), 'export const VERSION = "unknown";\n');
  writeFileSync(join(checkout, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Release fixture feature.\n\n## [1.2.3] - 2026-01-01\n\n- Earlier release.\n');
  writeFileSync(join(checkout, 'AGENTS.md'), 'Fixture context.\n');
  symlinkSync('AGENTS.md', join(checkout, 'CLAUDE.md'));
  git('init', '--initial-branch=main');
  git('init', '--bare', '--initial-branch=main', remote);
  git('remote', 'add', 'origin', remote);
  git('add', '.');
  git('commit', '-m', 'initial fixture');
  git('push', '-u', 'origin', 'main');
});

afterEach(() => rmSync(stage, { recursive: true, force: true }));

describe('release commands', () => {
  test.each([['major', '2.0.0'], ['minor', '1.3.0'], ['patch', '1.2.4']])('%s keeps committed manifests, annotated tag, and release aligned', (level, version) => {
    const result = release(level);
    expect(result.code, result.output).toBe(0);
    const tag = `v${version}`;
    expect(git('cat-file', '-t', tag)).toBe('tag');
    const head = git('rev-parse', 'HEAD');
    expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(head);
    expect(git('--git-dir', remote, 'rev-parse', `${tag}^{}`)).toBe(head);
    for (const path of manifestPaths) {
      expect(JSON.parse(git('--git-dir', remote, 'show', `${tag}:${path}`)).version).toBe(version);
    }
    const notes = '### Added\n\n- Release fixture feature.\n';
    expect(JSON.parse(readFileSync(env.RELEASE_RECORD, 'utf8'))).toEqual({ tag, commit: head, notes, latest: true, title: tag });
    expect(git('show', `${tag}:CHANGELOG.md`)).toContain(`## [Unreleased]\n\n## [${version}] - `);
    expect(git('status', '--porcelain')).toBe('');
  });

  test('dry run leaves versions, history, and publication unchanged', () => {
    const head = git('rev-parse', 'HEAD');
    const result = release('minor', '--dry-run');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('1.2.3 -> 1.3.0');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('tag', '--list')).toBe('');
    expect(existsSync(env.RELEASE_RECORD)).toBe(false);
  });

  test('redacts HTTPS remote credentials from command failures', () => {
    const credential = 'release-user:synthetic-token';
    git('remote', 'set-url', '--push', 'origin', `https://${credential}@github.com/test/recall.git`);
    writeFileSync(join(stage, 'bin', 'git'), `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  printf 'fatal: unable to access %s\n' "$2" >&2
  exit 1
fi
exec "$RELEASE_REAL_GIT" "$@"
`, { mode: 0o755 });
    const result = release();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('https://[REDACTED]@github.com/test/recall.git');
    expect(result.output).not.toContain(credential);
  });

  test.each(['dirty', 'feature', 'unsynced', 'collision', 'collision-build', 'remote-tag', 'notes', 'github-auth', 'github-unavailable'])('rejects %s before modifying release files', condition => {
    if (condition === 'dirty') writeFileSync(join(checkout, 'personal.txt'), 'keep this');
    if (condition === 'feature') git('switch', '-c', 'feature');
    if (condition === 'unsynced') git('commit', '--allow-empty', '-m', 'local only');
    if (condition === 'collision') env.RELEASE_TAGS = 'v1.2.4';
    if (condition === 'collision-build') env.RELEASE_TAGS = 'v1.2.4+build-1';
    if (condition === 'remote-tag') git('--git-dir', remote, 'tag', 'v1.2.4', 'refs/heads/main');
    if (condition === 'github-auth') env.FAIL_GH_AUTH = '1';
    if (condition === 'github-unavailable') env.FAIL_GH_API = '1';
    if (condition === 'notes') {
      writeFileSync(join(checkout, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n');
      git('add', 'CHANGELOG.md');
      git('commit', '-m', 'empty release notes');
      git('push', 'origin', 'main');
    }
    const head = git('rev-parse', 'HEAD');
    const status = git('status', '--porcelain');
    const files = manifestPaths.map(path => readFileSync(join(checkout, path), 'utf8'));
    const result = release();
    expect(result.code, result.output).toBe(1);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe(status);
    expect(manifestPaths.map(path => readFileSync(join(checkout, path), 'utf8'))).toEqual(files);
    expect(git('tag', '--list')).toBe('');
    expect(existsSync(env.RELEASE_RECORD)).toBe(false);
  });

  test('only publishes the selected tag when push.followTags is enabled', () => {
    git('config', 'push.followTags', 'true');
    git('tag', '-a', 'v1.2.3-preview', '-m', 'Keep this local');
    const result = release();
    expect(result.code, result.output).toBe(0);
    expect(git('--git-dir', remote, 'tag', '--list')).toBe('v1.2.4');
    expect(git('tag', '--list')).toBe('v1.2.3-preview\nv1.2.4');
  });

  test('rejected main push cannot publish a tag alone', () => {
    const head = git('rev-parse', 'HEAD');
    writeFileSync(join(remote, 'hooks', 'update'), '#!/bin/sh\ntest "$1" != refs/heads/main\n', { mode: 0o755 });
    const result = release();
    expect(result.code, result.output).toBe(1);
    expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(head);
    expect(git('--git-dir', remote, 'tag', '--list')).toBe('');
    expect(existsSync(env.RELEASE_RECORD)).toBe(false);
    expect(JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version).toBe('1.2.4');
    expect(git('cat-file', '-t', 'v1.2.4')).toBe('tag');
  });

  test('failed validation leaves remote history and release tags untouched', () => {
    const path = join(checkout, 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.scripts.lint = 'false';
    writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    git('add', 'package.json');
    git('commit', '-m', 'Fail validation');
    git('push', 'origin', 'main');
    const head = git('rev-parse', 'HEAD');
    const result = release();
    expect(result.code, result.output).toBe(1);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(head);
    expect(git('tag', '--list')).toBe('');
    expect(existsSync(env.RELEASE_RECORD)).toBe(false);
  });

  test('GitHub failure retains the aligned published tag and commit for recovery', () => {
    env.FAIL_GH_RELEASE = '1';
    const result = release();
    expect(result.code, result.output).toBe(1);
    const head = git('rev-parse', 'HEAD');
    expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(head);
    expect(git('--git-dir', remote, 'rev-parse', 'v1.2.4^{}')).toBe(head);
    expect(JSON.parse(git('--git-dir', remote, 'show', 'v1.2.4:package.json')).version).toBe('1.2.4');
    expect(existsSync(env.RELEASE_RECORD)).toBe(false);
  });
});
