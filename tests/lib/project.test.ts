import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { basename } from 'path';
import { detectProject } from '../../src/lib/project';

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
