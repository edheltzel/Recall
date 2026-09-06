import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CURSOR_SESSION_START_COMMAND,
  HARNESS_SEAMS,
  catalogCursorSessions,
  describeHarnessSeams,
  discoverCurrentSession,
  listStartFormats,
  markdownDropDirName,
  mergeCursorHooksJson,
  parseMarkdownDrop,
  registerSessionSource,
  registerStartFormat,
  registeredSessionSources,
  runStart,
} from '../src/api';

const REPO = join(import.meta.dir, '..');

describe('recall-memory/api harness seams', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  test('describeHarnessSeams lists start/drop/capture/inject and the issue 271 non-goals', () => {
    const described = describeHarnessSeams();
    expect(described.seams).toEqual(HARNESS_SEAMS);
    expect([...described.seams]).toEqual(['start', 'drop', 'capture', 'inject']);
    expect(described.start.formats).toEqual(['markdown', 'cursor']);
    expect(described.start.cli).toBe('recall start');
    expect(described.drop.dir).toBe('MEMORY/<host>-sessions/');
    expect(described.capture.cursor).toBe('catalogCursorSessions');
    expect(described.inject.cursorCommand).toBe(CURSOR_SESSION_START_COMMAND);
    expect(described.mcp.server).toBe('recall-memory');
    expect(described.mcp.bin).toBe('recall-mcp');
    expect(described.nonGoals).toContain('HostDescriptor');
    expect(described.nonGoals).toContain('Cursor marketplace plugin');
    expect(described.nonGoals).toContain('Cursor host-hook glue');
    expect(described.inject.note).toContain('FM-321/327');
  });

  test('registerStartFormat wraps gatherContext for in-process runStart callers', () => {
    disposers.push(registerStartFormat('acme', context => JSON.stringify({ prompt: context })));
    expect(listStartFormats()).toEqual(['markdown', 'cursor', 'acme']);

    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    }) as typeof process.stdout.write;
    const root = mkdtempSync(join(tmpdir(), 'recall-api-start-'));
    const previousDb = process.env.RECALL_DB_PATH;
    const previousIdentity = process.env.RECALL_IDENTITY_PATH;
    try {
      process.env.RECALL_DB_PATH = join(root, 'missing.db');
      process.env.RECALL_IDENTITY_PATH = join(root, 'missing.md');
      runStart({ format: 'acme' });
      const parsed = JSON.parse(captured) as { prompt: string };
      expect(parsed.prompt).toContain('Memory unavailable');
    } finally {
      process.stdout.write = originalWrite;
      if (previousDb === undefined) delete process.env.RECALL_DB_PATH;
      else process.env.RECALL_DB_PATH = previousDb;
      if (previousIdentity === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = previousIdentity;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('built-in start formats and session sources cannot be replaced', () => {
    expect(() => registerStartFormat('cursor', c => c)).toThrow(/built-in start format/);
    expect(() => registerStartFormat('markdown', c => c)).toThrow(/built-in start format/);
    expect(() => registerSessionSource({ id: 'claude', discover: () => null })).toThrow(/built-in session source/);
  });

  test('registerSessionSource is consulted by discoverCurrentSession without forking dump', () => {
    const session = {
      source: 'acme',
      sessionId: 'ses-acme',
      project: 'acme',
      messages: [{
        session_id: 'ses-acme',
        timestamp: new Date().toISOString(),
        role: 'user' as const,
        content: 'portable request from a third harness',
        project: 'acme',
      }],
      filePath: '/tmp/acme.md',
    };
    disposers.push(registerSessionSource({ id: 'acme', discover: () => session }));
    expect(registeredSessionSources().map(adapter => adapter.id)).toEqual(['acme']);
    expect(discoverCurrentSession(registeredSessionSources())?.sessionId).toBe('ses-acme');
    const dumpSource = readFileSync(join(REPO, 'src', 'hosts', 'session-sources.ts'), 'utf-8');
    expect(dumpSource).toContain('registeredSessionSources()');
  });

  test('drop seam is the MEMORY/<host>-sessions filesystem convention', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-api-drop-'));
    try {
      const dir = join(root, markdownDropDirName('acme'));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'ses_third.md');
      writeFileSync(file, '[USER]: Third host portable request here.\n\n[ASSISTANT]: Third host portable reply here.\n');
      expect(parseMarkdownDrop(file)?.sessionId).toBe('ses_third');
      expect(markdownDropDirName('acme')).toBe('acme-sessions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inject seam stays Cursor snippets + recall start, not a marketplace plugin', () => {
    const merged = mergeCursorHooksJson({ version: 1, hooks: {} });
    expect(merged.hooks.sessionStart).toEqual([{ command: CURSOR_SESSION_START_COMMAND }]);
    expect(existsSync(join(REPO, '.cursor-plugin'))).toBe(false);
    expect(existsSync(join(REPO, 'plugins', 'recall-cursor'))).toBe(false);
    const pluginDirs = existsSync(join(REPO, 'plugins')) ? readdirSync(join(REPO, 'plugins')) : [];
    expect(pluginDirs.some(name => name.toLowerCase().includes('cursor'))).toBe(false);
    expect(typeof catalogCursorSessions).toBe('function');
  });

  test('package.json exports recall-memory/api and does not add a HostDescriptor type', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    expect(pkg.exports?.['./api']?.import).toBe('./dist/api.js');
    expect(pkg.exports?.['./api']?.types).toBe('./dist/api.d.ts');
    const seams = readFileSync(join(REPO, 'src', 'lib', 'harness-seams.ts'), 'utf-8');
    expect(seams).not.toMatch(/export (type|interface) HostDescriptor/);
    const api = readFileSync(join(REPO, 'src', 'api.ts'), 'utf-8');
    expect(api).not.toMatch(/host-hook/);
    const published = readFileSync(join(REPO, 'src', 'api.public.d.ts'), 'utf-8');
    for (const name of [
      'registerStartFormat',
      'registerSessionSource',
      'runStart',
      'parseMarkdownDrop',
      'catalogCursorSessions',
      'mergeCursorHooksJson',
      'discoverCurrentSession',
      'describeHarnessSeams',
    ]) {
      expect(published).toContain(name);
    }
  });
});
