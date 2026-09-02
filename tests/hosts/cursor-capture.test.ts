import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  catalogCursorSessions,
  cursorChatsDir,
  encodedProjectFromTranscriptPath,
  MAX_WORKSPACE_STATE_DBS,
} from '../../src/hosts/cursor-capture';
import { initDb, closeDb } from '../../src/db/connection';
import { search } from '../../src/lib/memory';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'cursor');

function writeVscdb(path: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'composerData:composer-7',
    readFileSync(join(FIXTURES, 'composer.json'), 'utf-8').trim(),
  );
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId::composer-7:bubble-1',
    readFileSync(join(FIXTURES, 'bubble-user.json'), 'utf-8').trim(),
  );
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId::composer-7:bubble-2',
    readFileSync(join(FIXTURES, 'bubble-assistant.json'), 'utf-8').trim(),
  );
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId::composer-7:empty',
    JSON.stringify({ type: 1, text: '   ', timestamp: 1 }),
  );
  db.close();
}

describe('Cursor capture catalog', () => {
  test('catalogs composers/bubbles from fixture state.vscdb and messages from fixture JSONL', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-cursor-cap-'));
    try {
      const ideUserDir = join(root, 'Cursor', 'User');
      mkdirSync(join(ideUserDir, 'globalStorage'), { recursive: true });
      const vscdb = join(ideUserDir, 'globalStorage', 'state.vscdb');
      writeVscdb(vscdb);

      const cliRoot = join(root, '.cursor');
      const transcripts = join(cliRoot, 'projects', 'Users-x-api', 'agent-transcripts');
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(
        join(transcripts, 'cli-chat-1.jsonl'),
        readFileSync(join(FIXTURES, 'agent-transcript.jsonl')),
      );
      mkdirSync(join(transcripts, 'subagents'), { recursive: true });
      writeFileSync(
        join(transcripts, 'subagents', 'child.jsonl'),
        '{"role":"user","message":{"content":[{"type":"text","text":"subagent should skip"}]}}\n',
      );

      const sessions = catalogCursorSessions({
        ideUserDir,
        cliRoot,
        cwd: '/work/api',
      });

      const ide = sessions.find(s => s.store === 'ide-vscdb');
      expect(ide?.sessionId).toBe('composer-7');
      expect(ide?.workspace).toBe('/work/api');
      expect(ide?.project).toBe('api');
      expect(ide?.messageCount).toBe(2);
      expect(ide).not.toHaveProperty('turns');
      expect(ide?.quality).toBe('transcript');
      expect(ide?.size).toBe(0);
      expect(ide?.size).not.toBe(statSync(vscdb).size);

      const jsonl = sessions.find(s => s.store === 'cli-jsonl');
      expect(jsonl?.sessionId).toBe('cli-chat-1');
      expect(jsonl?.messageCount).toBe(2);
      expect(jsonl?.project).toBe('api');
      expect(jsonl).not.toHaveProperty('turns');
      expect(jsonl?.sourcePath.endsWith('.jsonl')).toBe(true);
      expect(jsonl?.size).toBe(statSync(jsonl!.sourcePath).size);
      expect(sessions.some(s => s.sourcePath.includes('subagents'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('nested agent-transcripts/<session>/<session>.jsonl uses the encoded project dir', () => {
    const nested = join(
      '/home',
      '.cursor',
      'projects',
      'Users-x-api',
      'agent-transcripts',
      'cli-chat-1',
      'cli-chat-1.jsonl',
    );
    expect(encodedProjectFromTranscriptPath(nested)).toBe('Users-x-api');
    expect(encodedProjectFromTranscriptPath(
      join('/home', '.cursor', 'projects', 'Users-x-api', 'agent-transcripts', 'cli-chat-1.jsonl'),
    )).toBe('Users-x-api');

    const root = mkdtempSync(join(tmpdir(), 'recall-cursor-nested-'));
    try {
      const cliRoot = join(root, '.cursor');
      const nestedDir = join(cliRoot, 'projects', 'Users-x-api', 'agent-transcripts', 'cli-chat-1');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(
        join(nestedDir, 'cli-chat-1.jsonl'),
        readFileSync(join(FIXTURES, 'agent-transcript.jsonl')),
      );
      const sessions = catalogCursorSessions({
        cliRoot,
        cwd: '/work/api',
        ideUserDir: join(root, 'no-ide'),
      });
      const jsonl = sessions.find(s => s.store === 'cli-jsonl');
      expect(jsonl?.project).toBe('api');
      expect(jsonl?.workspace).toBe('/Users/x/api');
      expect(jsonl?.sessionId).toBe('cli-chat-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('workspaceStorage vscdb opens are capped', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-cursor-ws-'));
    try {
      const ideUserDir = join(root, 'Cursor', 'User');
      mkdirSync(join(ideUserDir, 'globalStorage'), { recursive: true });
      writeVscdb(join(ideUserDir, 'globalStorage', 'state.vscdb'));
      const now = Date.now() / 1000;
      for (let i = 0; i < MAX_WORKSPACE_STATE_DBS + 3; i++) {
        const dir = join(ideUserDir, 'workspaceStorage', `ws-${i}`);
        mkdirSync(dir, { recursive: true });
        const dbPath = join(dir, 'state.vscdb');
        writeVscdb(dbPath);
        utimesSync(dbPath, now - i, now - i);
      }
      const sessions = catalogCursorSessions({
        ideUserDir,
        cliRoot: join(root, '.cursor'),
        cwd: '/work/api',
        maxWorkspaceDbs: MAX_WORKSPACE_STATE_DBS,
      });
      const vscdbSessions = sessions.filter(s => s.store === 'ide-vscdb');
      expect(vscdbSessions.length).toBe(1 + MAX_WORKSPACE_STATE_DBS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing ~/.cursor/chats/<md5>/ is a skip, present blobs are breadcrumbs-quality', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-cursor-chats-'));
    try {
      const cliRoot = join(root, '.cursor');
      mkdirSync(cliRoot, { recursive: true });
      const cwd = '/work/api';
      const missing = catalogCursorSessions({ cliRoot, cwd, ideUserDir: join(root, 'no-ide') });
      expect(missing.some(s => s.store === 'chats-blob')).toBe(false);

      const chats = cursorChatsDir(cliRoot, cwd);
      mkdirSync(chats, { recursive: true });
      writeFileSync(join(chats, 'blob.bin'), 'unordered blob');
      const present = catalogCursorSessions({ cliRoot, cwd, ideUserDir: join(root, 'no-ide') });
      const blob = present.find(s => s.store === 'chats-blob');
      expect(blob).toBeDefined();
      expect(blob?.quality).toBe('breadcrumbs');
      expect(blob).not.toHaveProperty('turns');
      expect(blob?.messageCount).toBe(0);
      expect(createHash('md5').update(cwd).digest('hex')).toBe(chats.split('/').pop());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('JSONL remains the CLI transcript source and catalog does not bubble-scan', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'hosts', 'cursor-capture.ts'), 'utf-8');
    expect(source).toContain("store: 'cli-jsonl'");
    expect(source).toContain('agent-transcripts');
    expect(source).toContain("mode=ro&immutable=1");
    expect(source).not.toContain("LIKE 'bubbleId::%'");
    expect(source).not.toMatch(/size:\s*fileSize\(dbPath\)/);
    expect(source).not.toMatch(/from ['"].*host-hook/);
    expect(source).not.toMatch(/from ['"].*host-ingest/);
  });

  test('query/search never receives raw transcript bodies from this parser', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-cursor-query-'));
    const previousDb = process.env.RECALL_DB_PATH;
    const previousSkip = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
    try {
      process.env.RECALL_DB_PATH = join(root, 'recall.db');
      process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = '1';
      initDb();
      const ideUserDir = join(root, 'Cursor', 'User');
      mkdirSync(join(ideUserDir, 'globalStorage'), { recursive: true });
      writeVscdb(join(ideUserDir, 'globalStorage', 'state.vscdb'));
      const cataloged = catalogCursorSessions({
        ideUserDir,
        cliRoot: join(root, '.cursor'),
        cwd: '/work/api',
      });
      expect(JSON.stringify(cataloged)).not.toContain('Why is this stale?');
      const hits = search('stale', { limit: 20 });
      expect(hits).toEqual([]);
    } finally {
      closeDb();
      if (previousDb === undefined) delete process.env.RECALL_DB_PATH;
      else process.env.RECALL_DB_PATH = previousDb;
      if (previousSkip === undefined) delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
      else process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = previousSkip;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor capture tests do not wire host-hook ingest', () => {
    const self = readFileSync(join(import.meta.dir, 'cursor-capture.test.ts'), 'utf-8');
    expect(self).not.toMatch(/from ['"].*host-hook/);
    expect(self).not.toMatch(/from ['"].*host-ingest/);
  });
});
