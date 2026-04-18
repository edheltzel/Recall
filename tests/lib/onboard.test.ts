// Tests for the onboard renderer + path resolution.
//
// We test the pure functions only — `renderIdentityMarkdown` and
// `resolveOutputPath`. The interactive `runInterview` path uses Node's
// readline against process.stdin and is brittle to mock cleanly; manual
// verification is the right tool for that part.

import { describe, test, expect } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { renderIdentityMarkdown, resolveOutputPath, type IdentityAnswers } from '../../src/commands/onboard';

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
    const p = resolveOutputPath({});
    expect(p).toBe(join(homedir(), '.claude', 'MEMORY', 'identity.md'));
  });

  test('--project resolves to project-local .atlas-recall/identity.md', () => {
    const p = resolveOutputPath({ project: true });
    expect(p).toBe(join(process.cwd(), '.atlas-recall', 'identity.md'));
  });

  test('--out wins over both', () => {
    const p = resolveOutputPath({ project: true, out: '/tmp/custom.md' });
    expect(p).toBe('/tmp/custom.md');
  });
});
