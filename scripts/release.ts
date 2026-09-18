#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertVersionGuard, isStrictSemver, normalizeReleaseVersion } from '../src/lib/version-guard';

const manifests = [
  'package.json',
  'plugins/recall/.codex-plugin/plugin.json',
  'plugins/recall-claude/.claude-plugin/plugin.json',
];
const releaseFiles = [...manifests, 'CHANGELOG.md'];

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8', input, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function readManifest(path: string) {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !('version' in value) || typeof value.version !== 'string') {
    throw new Error(`${path} must contain a string version`);
  }
  return value;
}

function release(args: string[]): void {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: bun scripts/release.ts <major|minor|patch> [--dry-run]');
    return;
  }
  const [bump, ...options] = args;
  if (!['major', 'minor', 'patch'].includes(bump ?? '') ||
    options.length > 1 || options.some(option => option !== '--dry-run')) {
    throw new Error('Usage: npm run release -- <major|minor|patch> [--dry-run]');
  }
  const dryRun = options.includes('--dry-run');
  if (realpathSync(process.cwd()) !== realpathSync(run('git', ['rev-parse', '--show-toplevel']))) {
    throw new Error('Run releases from the repository root');
  }
  if (run('git', ['branch', '--show-current']) !== 'main') {
    throw new Error('Release only from main after the change has been reviewed and merged');
  }
  if (run('git', ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Release requires a clean working tree and index');
  }
  if (!lstatSync('CLAUDE.md').isSymbolicLink() || realpathSync('CLAUDE.md') !== realpathSync('AGENTS.md')) {
    throw new Error('CLAUDE.md must remain a symlink to AGENTS.md');
  }

  const { packageVersion } = assertVersionGuard({
    packageJsonPath: resolve('package.json'),
    versionSourcePath: resolve('src/version.ts'),
    env: {},
  });
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    throw new Error('Major/minor/patch releases require a stable package version');
  }
  const parts = packageVersion.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Package version exceeds safe integer range');
  const digit = ['major', 'minor', 'patch'].indexOf(bump);
  parts[digit]++;
  if (!Number.isSafeInteger(parts[digit])) throw new Error('Next version exceeds safe integer range');
  parts.fill(0, digit + 1);
  const version = parts.join('.');
  const tag = `v${version}`;

  const origin = run('git', ['remote', 'get-url', '--push', 'origin']);
  const remoteRefs = run('git', ['ls-remote', origin, 'refs/heads/main', 'refs/tags/*'])
    .split('\n').filter(Boolean).map(line => line.split(/\s+/));
  const head = run('git', ['rev-parse', 'HEAD']);
  if (remoteRefs.find(([, ref]) => ref === 'refs/heads/main')?.[0] !== head) {
    throw new Error('Local main must match origin/main exactly before releasing');
  }
  run('gh', ['auth', 'status']);
  const repository = run('gh', ['repo', 'view', origin, '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const releaseTags = run('gh', ['api', '--paginate', `repos/${repository}/releases`, '--jq', '.[].tag_name']);
  const existingTags = [
    ...run('git', ['tag', '--list']).split('\n'),
    ...remoteRefs.filter(([, ref]) => ref.startsWith('refs/tags/') && !ref.endsWith('^{}'))
      .map(([, ref]) => ref.slice('refs/tags/'.length)),
    ...releaseTags.split('\n'),
  ];
  for (const existing of existingTags) {
    const published = normalizeReleaseVersion(existing);
    const precedence = published.split('+')[0];
    if (isStrictSemver(published) && !precedence.includes('-') &&
      Bun.semver.order(version, precedence) <= 0) {
      throw new Error(`${tag} must be newer than existing tag/release ${existing}; reconcile versions first`);
    }
  }

  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const sections = [...changelog.matchAll(/^## \[([^\]]+)\].*$/gm)];
  const unreleased = sections[0];
  if (!unreleased || unreleased[1] !== 'Unreleased' ||
    sections.filter(section => section[1] === 'Unreleased').length !== 1) {
    throw new Error('CHANGELOG.md must start its releases with exactly one ## [Unreleased] section');
  }
  if (sections.some(section => section[1] === version)) {
    throw new Error(`CHANGELOG.md already contains version ${version}`);
  }
  const start = unreleased.index!;
  const end = sections[1]?.index ?? changelog.length;
  const notes = changelog.slice(start + unreleased[0].length, end).trim();
  if (!notes.replace(/^###.*$/gm, '').trim()) {
    throw new Error('Add release notes to CHANGELOG.md [Unreleased] before releasing');
  }
  const date = new Date().toISOString().slice(0, 10);
  const updates = manifests.map(path => ({
    path,
    content: `${JSON.stringify({ ...readManifest(path), version }, null, 2)}\n`,
  }));
  updates.push({
    path: 'CHANGELOG.md',
    content: `${changelog.slice(0, start)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n\n${changelog.slice(end)}`,
  });
  console.log(`${packageVersion} -> ${version}: ${releaseFiles.join(', ')}`);
  console.log(`Publish annotated ${tag} and GitHub release to ${repository} from main`);
  if (dryRun) {
    console.log('Dry run: no files, commits, tags, or releases changed');
    return;
  }

  for (const update of updates) writeFileSync(update.path, update.content);
  assertVersionGuard({
    packageJsonPath: resolve('package.json'),
    versionSourcePath: resolve('src/version.ts'),
    env: { RELEASE_VERSION: version },
  });
  for (const script of ['lint', 'test', 'build']) {
    console.log(`Validating release: ${script}`);
    run('bun', ['run', script]);
  }
  if (run('git', ['branch', '--show-current']) !== 'main' || run('git', ['rev-parse', 'HEAD']) !== head) {
    throw new Error('Validation changed the release branch or commit; inspect history before continuing');
  }
  if (run('git', ['diff', '--name-only']).split('\n').some(path => !releaseFiles.includes(path)) ||
    run('git', ['diff', '--cached', '--name-only']) ||
    run('git', ['ls-files', '--others', '--exclude-standard'])) {
    throw new Error('Validation changed or staged files outside the release set; inspect git status before continuing');
  }
  run('git', ['add', '--', ...releaseFiles]);
  run('git', ['commit', '--only', '-m', `chore(release): ${tag}`, '--', ...releaseFiles]);
  if (run('git', ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Release commit left a dirty tree; inspect it before tagging or publishing');
  }
  for (const path of manifests) {
    const committed: unknown = JSON.parse(run('git', ['show', `HEAD:${path}`]));
    if (!committed || typeof committed !== 'object' || !('version' in committed) || committed.version !== version) {
      throw new Error(`Committed ${path} does not match ${tag}; nothing was tagged or pushed`);
    }
  }
  run('git', ['tag', '-a', tag, '-m', tag]);
  run('git', ['push', '--atomic', origin, 'HEAD:refs/heads/main', `refs/tags/${tag}`]);
  const url = run('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag',
    '--title', tag, '--notes-file', '-', '--latest'], `${notes}\n`);
  console.log(`Released ${tag}: ${url}`);
}

if (import.meta.main) {
  try {
    release(process.argv.slice(2));
  } catch (error) {
    console.error(`Release stopped: ${error instanceof Error ? error.message : String(error)}`);
    console.error('No existing tags were moved. If publication partially completed, follow docs/releasing.md before retrying.');
    process.exitCode = 1;
  }
}
