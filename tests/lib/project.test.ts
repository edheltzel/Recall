import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { basename } from 'path';
import { detectProject, extractProjectFromPath } from '../../src/lib/project';

describe('extractProjectFromPath', () => {
  test('returns last segment after "Projects" in encoded path', () => {
    expect(extractProjectFromPath('-home-user-Projects-my-app')).toBe('my-app');
  });

  test('returns hyphenated name after "Projects" when project name contains hyphens', () => {
    expect(extractProjectFromPath('-home-user-Projects-foo-bar')).toBe('foo-bar');
  });

  test('returns last part when no "Projects" segment exists', () => {
    expect(extractProjectFromPath('-home-user-work-my-app')).toBe('app');
  });

  test('returns the segment itself when given a single segment with no hyphens', () => {
    expect(extractProjectFromPath('myproject')).toBe('myproject');
  });
});

describe('detectProject', () => {
  test('returns a string when called with the current repo directory', () => {
    const result = detectProject(process.cwd());
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  test('returns the basename of a non-git temp directory', () => {
    const tempDir = mkdtempSync(`${tmpdir()}/recall-test-`);
    try {
      const result = detectProject(tempDir);
      expect(result).toBe(basename(tempDir));
    } finally {
      rmdirSync(tempDir);
    }
  });
});
