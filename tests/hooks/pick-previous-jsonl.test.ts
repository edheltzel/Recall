import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pickPreviousJsonl, DEFAULT_MTIME_GUARD_SECONDS } from '../../hooks/lib/pick-previous-jsonl';
import { encodeProjectDir } from '../../hooks/lib/hosts/claude/path-encoding';

let tmp: string;
let projectsDir: string;
let cwd: string;
let projectDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-pick-'));
  projectsDir = join(tmp, 'projects');
  cwd = '/Users/test/some/project';
  projectDir = join(projectsDir, encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(name: string, mtimeMs: number, content: string = '{}\n'): string {
  const path = join(projectDir, name);
  writeFileSync(path, content);
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

describe('pickPreviousJsonl', () => {
  test('returns null when project dir does not exist', () => {
    const otherCwd = '/Users/test/nonexistent';
    expect(pickPreviousJsonl(projectsDir, otherCwd)).toBeNull();
  });

  test('returns null when project dir has no .jsonl files', () => {
    writeFileSync(join(projectDir, 'README.md'), 'not a jsonl');
    expect(pickPreviousJsonl(projectsDir, cwd)).toBeNull();
  });

  test('returns the only JSONL when only one exists (fallback)', () => {
    const now = Date.now();
    const path = writeJsonl('only.jsonl', now - 60_000);
    expect(pickPreviousJsonl(projectsDir, cwd, DEFAULT_MTIME_GUARD_SECONDS, now)).toBe(path);
  });

  test('with two JSONLs of different mtimes (newest older than guard), returns most-recent', () => {
    const now = Date.now();
    // Both older than guard — no "in-progress" suspect, return [0]
    const oldPath = writeJsonl('old.jsonl', now - 60_000);
    const newPath = writeJsonl('new.jsonl', now - 30_000);
    expect(pickPreviousJsonl(projectsDir, cwd, DEFAULT_MTIME_GUARD_SECONDS, now)).toBe(newPath);
    expect(oldPath).toBeTruthy(); // silence unused
  });

  test('with two JSONLs where newest is within guard window, returns second-most-recent', () => {
    const now = Date.now();
    // Newest is 1s old — within 5s guard. Return the older one.
    const oldPath = writeJsonl('old.jsonl', now - 60_000);
    writeJsonl('new.jsonl', now - 1_000);
    expect(pickPreviousJsonl(projectsDir, cwd, DEFAULT_MTIME_GUARD_SECONDS, now)).toBe(oldPath);
  });

  test('with three JSONLs and newest within guard, returns second-most-recent (not third)', () => {
    const now = Date.now();
    const oldPath = writeJsonl('old.jsonl', now - 600_000); // 10 min ago
    const midPath = writeJsonl('mid.jsonl', now - 60_000); // 1 min ago
    writeJsonl('fresh.jsonl', now - 2_000); // 2s ago — in-progress
    expect(pickPreviousJsonl(projectsDir, cwd, DEFAULT_MTIME_GUARD_SECONDS, now)).toBe(midPath);
    expect(oldPath).toBeTruthy(); // silence unused
  });

  test('skips agent-*.jsonl files', () => {
    const now = Date.now();
    writeJsonl('agent-foo.jsonl', now - 1_000);
    const real = writeJsonl('real.jsonl', now - 60_000);
    expect(pickPreviousJsonl(projectsDir, cwd, DEFAULT_MTIME_GUARD_SECONDS, now)).toBe(real);
  });

  test('ignores non-.jsonl files', () => {
    const now = Date.now();
    writeFileSync(join(projectDir, 'README.md'), 'noise');
    writeFileSync(join(projectDir, 'config.json'), '{}');
    const real = writeJsonl('real.jsonl', now - 60_000);
    expect(pickPreviousJsonl(projectsDir, cwd, DEFAULT_MTIME_GUARD_SECONDS, now)).toBe(real);
  });

  test('two JSONLs with identical mtimes — sort is stable, returns one deterministically without throwing', () => {
    const now = Date.now();
    const aPath = writeJsonl('a.jsonl', now - 60_000);
    const bPath = writeJsonl('b.jsonl', now - 60_000);
    const result = pickPreviousJsonl(projectsDir, cwd, DEFAULT_MTIME_GUARD_SECONDS, now);
    // Both have identical mtime and are older than guard — should return one of them, not throw.
    expect([aPath, bPath]).toContain(result);
  });

  test('respects custom mtimeGuardSeconds', () => {
    const now = Date.now();
    const oldPath = writeJsonl('old.jsonl', now - 60_000);
    writeJsonl('new.jsonl', now - 30_000); // 30s old
    // Default guard (5s) would return newPath. Custom guard 60s makes newPath suspect.
    expect(pickPreviousJsonl(projectsDir, cwd, 60, now)).toBe(oldPath);
  });
});
