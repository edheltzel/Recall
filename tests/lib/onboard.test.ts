// Tests for the onboard renderer + path resolution + length guard +
// multi-value splitter. The interactive `runInterview` path uses readline
// against process.stdin and is exercised by manual smoke-test (see PR
// description); the rest is covered here.

import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from 'fs';
import {
  renderIdentityMarkdown,
  resolveOutputPath,
  splitMultiline,
  exceedsMaxL0,
  writeIdentityAtomic,
  type IdentityAnswers,
} from '../../src/commands/onboard';

const fullAnswers: IdentityAnswers = {
  name: 'Ed Heltzel',
  role: 'solo developer',
  machine: 'macOS · Bun 1.3.12',
  projects: [
    'atlas-recall (~/Developer/atlas-recall) — persistent memory for AI agents',
    'gstack — browser automation toolkit',
  ],
  preferences: [
    'plans live in .atlas/plans/',
    'handoffs live in .atlas/handoffs/',
    'work in git worktrees',
    'no force-push without asking',
  ],
  hosts: ['Claude Code', 'OpenCode'],
  notes: 'Direction: shared memory layer across all agents.',
};

describe('renderIdentityMarkdown', () => {
  test('emits the H1 with the user name', () => {
    const md = renderIdentityMarkdown(fullAnswers);
    expect(md.startsWith('# Ed Heltzel')).toBe(true);
  });

  test('includes role and machine on a single summary line', () => {
    const md = renderIdentityMarkdown(fullAnswers);
    expect(md).toContain('solo developer · macOS · Bun 1.3.12.');
  });

  test('emits Active projects, Working preferences, Hosts I use, Notes sections in order', () => {
    const md = renderIdentityMarkdown(fullAnswers);
    const idxProjects = md.indexOf('## Active projects');
    const idxPrefs = md.indexOf('## Working preferences');
    const idxHosts = md.indexOf('## Hosts I use');
    const idxNotes = md.indexOf('## Notes');
    expect(idxProjects).toBeGreaterThan(0);
    expect(idxPrefs).toBeGreaterThan(idxProjects);
    expect(idxHosts).toBeGreaterThan(idxPrefs);
    expect(idxNotes).toBeGreaterThan(idxHosts);
  });

  test('renders each project as a bullet line', () => {
    const md = renderIdentityMarkdown(fullAnswers);
    expect(md).toContain('- atlas-recall (~/Developer/atlas-recall) — persistent memory for AI agents');
    expect(md).toContain('- gstack — browser automation toolkit');
  });

  test('omits empty sections gracefully', () => {
    const md = renderIdentityMarkdown({
      name: 'X',
      role: '',
      machine: '',
      projects: [],
      preferences: [],
      hosts: [],
      notes: '',
    });
    expect(md.startsWith('# X')).toBe(true);
    expect(md).not.toContain('## Active projects');
    expect(md).not.toContain('## Working preferences');
    expect(md).not.toContain('## Hosts I use');
    expect(md).not.toContain('## Notes');
  });

  test('falls back to "You" when name is blank', () => {
    const md = renderIdentityMarkdown({
      name: '',
      role: 'developer',
      machine: '',
      projects: [],
      preferences: [],
      hosts: [],
      notes: '',
    });
    expect(md.startsWith('# You')).toBe(true);
  });

  test('skips empty entries inside list sections', () => {
    const md = renderIdentityMarkdown({
      name: 'X',
      role: '',
      machine: '',
      projects: ['real project', '', '   '],
      preferences: [],
      hosts: [],
      notes: '',
    });
    expect(md).toContain('- real project');
    // No empty bullets
    expect(md.split('\n').filter(l => l === '- ').length).toBe(0);
  });

  test('ends with exactly one trailing newline', () => {
    const md = renderIdentityMarkdown(fullAnswers);
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });
});

describe('resolveOutputPath', () => {
  test('defaults to the canonical Recall identity when no Claude alias exists', () => {
    const p = resolveOutputPath({}, { HOME: '/test-home' });
    expect(p).toBe('/test-home/.agents/Recall/MEMORY/identity.md');
  });

  test('--project resolves to project-local .atlas-recall/identity.md', () => {
    const p = resolveOutputPath({ project: true }, {});
    expect(p).toBe(join(process.cwd(), '.atlas-recall', 'identity.md'));
  });

  test('--out wins over --project, env, and default', () => {
    const p = resolveOutputPath(
      { project: true, out: '/tmp/custom.md' },
      { RECALL_IDENTITY_PATH: '/tmp/env.md' },
    );
    expect(p).toBe('/tmp/custom.md');
  });

  test('RECALL_IDENTITY_PATH is honored over --project and default', () => {
    // Guarantees onboard writes to the same file RecallStart reads from.
    const p = resolveOutputPath({ project: true }, { RECALL_IDENTITY_PATH: '/custom/identity.md' });
    expect(p).toBe('/custom/identity.md');
  });

  test('RECALL_IDENTITY_PATH is trimmed of whitespace', () => {
    const p = resolveOutputPath({}, { RECALL_IDENTITY_PATH: '  /padded/identity.md  ' });
    expect(p).toBe('/padded/identity.md');
  });

  test('empty RECALL_IDENTITY_PATH falls through to --project then default', () => {
    const p = resolveOutputPath({ project: true }, { RECALL_IDENTITY_PATH: '   ' });
    expect(p).toBe(join(process.cwd(), '.atlas-recall', 'identity.md'));
  });
});

describe('splitMultiline', () => {
  test('splits on pipe and trims', () => {
    expect(splitMultiline('a | b | c')).toEqual(['a', 'b', 'c']);
  });

  test('preserves commas inside a single value', () => {
    // The reason we moved off comma/semicolon — natural phrases survive.
    expect(splitMultiline('no force-push, ever | work in worktrees')).toEqual([
      'no force-push, ever',
      'work in worktrees',
    ]);
  });

  test('drops empty segments', () => {
    expect(splitMultiline('a | | b |')).toEqual(['a', 'b']);
  });

  test('empty input yields empty array', () => {
    expect(splitMultiline('')).toEqual([]);
  });
});

describe('exceedsMaxL0', () => {
  test('returns false for short content', () => {
    expect(exceedsMaxL0('# short\n')).toBe(false);
  });

  test('returns true once output passes 1200 chars', () => {
    const big = '# x\n' + 'y'.repeat(1300);
    expect(exceedsMaxL0(big)).toBe(true);
  });

  test('boundary: exactly 1200 chars is not "exceeds"', () => {
    expect(exceedsMaxL0('z'.repeat(1200))).toBe(false);
    expect(exceedsMaxL0('z'.repeat(1201))).toBe(true);
  });
});

// ─── Integration: atomic write via rename ────────────────────────────
describe('identity file write (integration)', () => {
  test('resolves installer-relocated identity ownership from RECALL_DIR', () => {
    const path = resolveOutputPath({}, {
      HOME: '/test-home',
      RECALL_DIR: '/relocated/Recall',
      RECALL_HOME: '/runtime/Recall',
    });

    expect(path).toBe('/relocated/Recall/MEMORY/identity.md');
  });

  test('writes a fresh identity into the root discovered from the Claude guide link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-onboard-'));
    try {
      const home = join(dir, 'home');
      const claudeDir = join(home, '.claude');
      const installRoot = join(dir, 'relocated', 'Recall');
      const guide = join(installRoot, 'claude', 'Recall_GUIDE.md');
      const canonical = join(installRoot, 'MEMORY', 'identity.md');
      const identity = join(claudeDir, 'MEMORY', 'identity.md');
      mkdirSync(dirname(guide), { recursive: true });
      mkdirSync(dirname(canonical), { recursive: true });
      mkdirSync(dirname(identity), { recursive: true });
      writeFileSync(guide, '# Guide\n');
      symlinkSync(guide, join(claudeDir, 'Recall_GUIDE.md'));

      const outPath = resolveOutputPath({}, { HOME: home });
      writeIdentityAtomic(outPath, '# New\n');

      expect(outPath).toBe(canonical);
      expect(existsSync(identity)).toBe(false);
      expect(readFileSync(canonical, 'utf-8')).toBe('# New\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('renaming an identity.md.tmp over identity.md yields the new content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-onboard-'));
    try {
      const outPath = join(dir, 'identity.md');
      writeFileSync(outPath, '# Old\n');
      writeIdentityAtomic(outPath, '# New\n');

      expect(existsSync(outPath + '.tmp')).toBe(false);
      expect(readFileSync(outPath, 'utf-8')).toBe('# New\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('updates a symlink target without replacing the identity symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-onboard-'));
    try {
      const home = join(dir, 'home');
      const installRoot = join(dir, 'relocated', 'Recall');
      const guide = join(installRoot, 'claude', 'Recall_GUIDE.md');
      const canonicalPath = join(installRoot, 'MEMORY', 'identity.md');
      const claudePath = join(home, '.claude', 'MEMORY', 'identity.md');
      mkdirSync(dirname(guide), { recursive: true });
      mkdirSync(dirname(canonicalPath), { recursive: true });
      mkdirSync(dirname(claudePath), { recursive: true });
      writeFileSync(guide, '# Guide\n');
      writeFileSync(canonicalPath, '# Old\n');
      symlinkSync(guide, join(home, '.claude', 'Recall_GUIDE.md'));
      symlinkSync(canonicalPath, claudePath);

      const outPath = resolveOutputPath({}, { HOME: home });
      writeIdentityAtomic(outPath, '# New\n');

      expect(outPath).toBe(canonicalPath);
      expect(lstatSync(claudePath).isSymbolicLink()).toBe(true);
      expect(readFileSync(canonicalPath, 'utf-8')).toBe('# New\n');
      expect(existsSync(canonicalPath + '.tmp')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replaces an arbitrary symlink without overwriting its target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-onboard-'));
    try {
      const targetPath = join(dir, 'unrelated.md');
      const projectPath = join(dir, 'identity.md');
      writeFileSync(targetPath, '# Unrelated\n');
      symlinkSync(targetPath, projectPath);

      writeIdentityAtomic(projectPath, '# Identity\n');

      expect(lstatSync(projectPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(projectPath, 'utf-8')).toBe('# Identity\n');
      expect(readFileSync(targetPath, 'utf-8')).toBe('# Unrelated\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
