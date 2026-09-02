import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseMarkdownDrop, listMarkdownDropDirs, findAllMarkdownDropFiles, findLatestMarkdownDrop } from '../../src/hosts/markdown-session-source';
import { findMarkdownDropFiles } from '../../hooks/lib/markdown-drop';
import { findMarkdownSessions } from '../../hooks/RecallBatchExtract';

const REPO = join(import.meta.dir, '..', '..');

describe('shared drop-dir ingest', () => {
  test('OpenCode and Pi markdown drops still parse through parseMarkdownDrop', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-md-drop-'));
    try {
      const opencode = join(root, 'opencode.md');
      const pi = join(root, 'pi.md');
      writeFileSync(opencode, '[USER]: OpenCode portable request here.\n\n[ASSISTANT]: OpenCode portable reply here.\n');
      writeFileSync(pi, '# User\nPi portable request here.\n\n## Assistant\nPi portable reply here.\n');
      expect(parseMarkdownDrop(opencode)?.messages.map(m => m.content)).toEqual([
        'OpenCode portable request here.',
        'OpenCode portable reply here.',
      ]);
      expect(parseMarkdownDrop(pi)?.messages.map(m => m.content)).toEqual([
        'Pi portable request here.',
        'Pi portable reply here.',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('adding a third drop-dir host does not require copying extract/precompact templates', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-md-third-'));
    try {
      const memory = join(root, 'MEMORY');
      mkdirSync(join(memory, 'acme-sessions'), { recursive: true });
      writeFileSync(
        join(memory, 'acme-sessions', 'ses_third.md'),
        '[USER]: Third host portable request here.\n\n[ASSISTANT]: Third host portable reply here.\n',
      );
      expect(listMarkdownDropDirs(memory).map(d => d.host)).toEqual(['acme']);
      const files = findAllMarkdownDropFiles(memory);
      expect(files).toHaveLength(1);
      expect(files[0].project).toBe('acme');
      expect(findMarkdownSessions(join(memory, 'acme-sessions'), 'acme')).toHaveLength(1);
      expect(parseMarkdownDrop(files[0].path)?.sessionId).toBe('ses_third');

      const extract = readFileSync(join(REPO, 'opencode', 'RecallExtract.ts'), 'utf-8');
      const precompact = readFileSync(join(REPO, 'pi', 'RecallPreCompact.ts'), 'utf-8');
      expect(extract).toContain('Host parser — not a template');
      expect(precompact).toContain('Host parser — not a template');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('findLatestMarkdownDrop is max-mtime over findMarkdownDropFiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-md-latest-'));
    try {
      writeFileSync(join(root, 'older.md'), '[USER]: older portable request here.\n');
      writeFileSync(join(root, 'newer.md'), '[USER]: newer portable request here.\n');
      const now = Date.now() / 1000;
      utimesSync(join(root, 'older.md'), now - 60, now - 60);
      utimesSync(join(root, 'newer.md'), now, now);
      const files = findMarkdownDropFiles(root, 'acme');
      expect(files).toHaveLength(2);
      const latestFromScan = files.reduce((a, b) => a.mtime >= b.mtime ? a : b);
      expect(findLatestMarkdownDrop(root)).toBe(latestFromScan.path);
      expect(findLatestMarkdownDrop(root)).toBe(join(root, 'newer.md'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('host-ingest.ts gains no drop-dir branch', () => {
    const source = readFileSync(join(REPO, 'src', 'lib', 'host-ingest.ts'), 'utf-8');
    expect(source).not.toMatch(/drop[-_]?dir/i);
    expect(source).not.toContain('opencode-sessions');
    expect(source).not.toContain('pi-sessions');
    expect(source).not.toContain('parseMarkdownDrop');
  });
});
