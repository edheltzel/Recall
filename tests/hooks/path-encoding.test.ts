// Claude Code's project folder names under ~/.claude/projects/ only use
// [a-zA-Z0-9-]; every other character becomes "-". A narrower rule silently
// fails for worktrees (".claude/worktrees/..."), dotfile roots (".dotfiles",
// ".config/..."), and iCloud paths with spaces/tildes/unicode.

import { describe, test, expect } from 'bun:test';
import { encodeProjectDir } from '../../hooks/lib/path-encoding';

describe('encodeProjectDir', () => {
  test('plain path', () => {
    expect(encodeProjectDir('/Users/ed/Developer/atlas-recall')).toBe(
      '-Users-ed-Developer-atlas-recall'
    );
  });

  test('replaces underscores', () => {
    expect(encodeProjectDir('/Users/ed/my_project/src')).toBe(
      '-Users-ed-my-project-src'
    );
  });

  test('replaces dots — worktree path', () => {
    const cwd = '/Users/ed/Sites/peptideHub/.claude/worktrees/fix-calculator-dose-unit';
    expect(encodeProjectDir(cwd)).toBe(
      '-Users-ed-Sites-peptideHub--claude-worktrees-fix-calculator-dose-unit'
    );
  });

  test('replaces dots — dotfile root', () => {
    expect(encodeProjectDir('/Users/ed/.dotfiles')).toBe('-Users-ed--dotfiles');
  });

  test('replaces dots — in-name dot', () => {
    expect(encodeProjectDir('/Users/ed/Sites/alianza.health')).toBe(
      '-Users-ed-Sites-alianza-health'
    );
  });

  test('replaces spaces, tildes, and unicode', () => {
    const cwd =
      '/Users/ed/Library/Mobile Documents/iCloud~md~obsidian/Documents/FieldNotes✱';
    expect(encodeProjectDir(cwd)).toBe(
      '-Users-ed-Library-Mobile-Documents-iCloud-md-obsidian-Documents-FieldNotes-'
    );
  });

  test('replaces plus signs', () => {
    expect(
      encodeProjectDir(
        '/Users/ed/Developer/GAT/peptidewareApps/Hub/.claude/worktrees/feature+anchor-urls-share'
      )
    ).toBe(
      '-Users-ed-Developer-GAT-peptidewareApps-Hub--claude-worktrees-feature-anchor-urls-share'
    );
  });

  test('preserves hyphens and digits', () => {
    expect(encodeProjectDir('/a-b/0-1-2')).toBe('-a-b-0-1-2');
  });

  test('multiple dots collapse into multiple dashes', () => {
    expect(encodeProjectDir('/a/.b/.c')).toBe('-a--b--c');
  });
});
