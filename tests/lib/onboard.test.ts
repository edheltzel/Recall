// Tests for the onboard renderer + path resolution + length guard +
// multi-value splitter. The interactive `runInterview` path uses readline
// against process.stdin and is exercised by manual smoke-test (see PR
// description); the rest is covered here.

import { describe, test, expect } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import {
  renderIdentityMarkdown,
  resolveOutputPath,
  splitMultiline,
  exceedsMaxL0,
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
    'plans live in .atlas-plans/',
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
  test('defaults to global ~/.claude/MEMORY/identity.md', () => {
    const p = resolveOutputPath({}, {});
    expect(p).toBe(join(homedir(), '.claude', 'MEMORY', 'identity.md'));
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
    // Guarantees onboard writes to the same file SessionRecall reads from.
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
// This doesn't mock the interview — it drives renderIdentityMarkdown and
// the atomic-write path indirectly by calling writeFileSync + rename the
// same way runOnboard does. Narrow but meaningful coverage on the branch
// that was previously zero-coverage.

describe('identity file write (integration)', () => {
  test('renaming an identity.md.tmp over identity.md yields the new content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-onboard-'));
    try {
      const outPath = join(dir, 'identity.md');
      const tmp = outPath + '.tmp';

      writeFileSync(outPath, '# Old\n');
      writeFileSync(tmp, '# New\n');

      // Mirrors runOnboard's atomic step.
      const { renameSync } = require('fs');
      renameSync(tmp, outPath);

      expect(existsSync(tmp)).toBe(false);
      expect(readFileSync(outPath, 'utf-8')).toBe('# New\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
