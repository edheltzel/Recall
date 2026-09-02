import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync, execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleHostHook } from '../../src/commands/host-hook';
import { runStart } from '../../src/commands/start';
import {
  MAX_L0_CHARS,
  MAX_L1_CHARS,
  MAX_TOTAL_CHARS,
  MEMORY_UNAVAILABLE,
  detectProject,
  buildL0,
  gatherContext,
  resolveSessionStartCwd,
} from '../../hooks/lib/session-start-context';
import * as recallStartHook from '../../hooks/RecallStart';
import { createLoaEntry, addBreadcrumb, createSession } from '../../src/lib/memory';
import { closeDb, initDb } from '../../src/db/connection';

const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'index.ts');
const CODEX_FIXTURE = join(REPO, 'tests', 'fixtures', 'host-lifecycle', 'codex-session-start.json');

function runCli(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('recall start public CLI', () => {
  test('help lists recall start', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/\sstart\s/);
    expect(help.stdout).toContain('L0/L1');
    expect(help.stdout).not.toContain('host-hook');
    const indexSource = readFileSync(join(REPO, 'src', 'index.ts'), 'utf-8');
    expect(indexSource).toContain("command('host-hook <host>', { hidden: true })");
  });

  test('start --help publishes the char caps', () => {
    const help = runCli(['start', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--format');
    expect(help.stdout).toContain('cursor');
    expect(MAX_L0_CHARS).toBe(1200);
    expect(MAX_L1_CHARS).toBe(6000);
    expect(MAX_TOTAL_CHARS).toBe(8000);
  });

  test('empty DB + missing identity.md exits 0 with a short degrade line', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-start-empty-'));
    try {
      const result = runCli(['start'], {
        RECALL_DB_PATH: join(root, 'missing.db'),
        RECALL_IDENTITY_PATH: join(root, 'missing-identity.md'),
        HOME: root,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(MEMORY_UNAVAILABLE);
      expect(result.stdout).not.toContain('### L0 — Identity');
      expect(result.stdout).not.toContain('### L1 — Top Memory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('one L0/L1 assembler', () => {
  test('Claude SessionStart and recall start share one assembler', () => {
    expect(recallStartHook.gatherContext).toBe(gatherContext);
  });

  test('with identity + ranked rows, stdout is L0/L1 markdown', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-start-full-'));
    const previousDb = process.env.RECALL_DB_PATH;
    const previousSkip = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
    const previousIdentity = process.env.RECALL_IDENTITY_PATH;
    try {
      process.env.RECALL_DB_PATH = join(root, 'recall.db');
      process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = '1';
      process.env.RECALL_IDENTITY_PATH = join(root, 'identity.md');
      writeFileSync(process.env.RECALL_IDENTITY_PATH, '# Ed\nDeveloper. Bun + TS.\n');
      initDb();
      createSession({ session_id: 'start-sess', started_at: new Date().toISOString() });
      createLoaEntry({ title: 'Reserved wisdom', fabric_extract: 'keep me', project: 'Recall' });
      addBreadcrumb({ content: 'ranked breadcrumb', project: 'Recall', importance: 9 });
      const out = gatherContext();
      expect(out).toContain('## Recall — Session Memory (tiered)');
      expect(out).toContain('### L0 — Identity');
      expect(out).toContain('Ed');
      expect(out).toContain('### L1 — Top Memory');
      expect(out).toContain('Reserved wisdom');
      expect(out).toContain('ranked breadcrumb');
    } finally {
      closeDb();
      if (previousDb === undefined) delete process.env.RECALL_DB_PATH;
      else process.env.RECALL_DB_PATH = previousDb;
      if (previousSkip === undefined) delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
      else process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = previousSkip;
      if (previousIdentity === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = previousIdentity;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('char cap drops L1 tail and never reserved LoA first', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-start-cap-'));
    const previousDb = process.env.RECALL_DB_PATH;
    const previousSkip = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
    const previousIdentity = process.env.RECALL_IDENTITY_PATH;
    try {
      process.env.RECALL_DB_PATH = join(root, 'recall.db');
      process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = '1';
      process.env.RECALL_IDENTITY_PATH = join(root, 'identity.md');
      writeFileSync(process.env.RECALL_IDENTITY_PATH, '# Cap\n');
      initDb();
      createSession({ session_id: 'cap-sess', started_at: new Date().toISOString() });
      for (let i = 0; i < 4; i++) {
        createLoaEntry({
          title: `Reserved LoA ${i} ${'L'.repeat(80)}`,
          fabric_extract: 'loa',
          project: 'Recall',
        });
      }
      for (let i = 0; i < 12; i++) {
        addBreadcrumb({
          content: `tail crumb ${i} ${'x'.repeat(400)}`,
          project: 'Recall',
          importance: 10,
        });
      }
      const out = gatherContext();
      expect(out).toContain('Reserved LoA 0');
      expect(out.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS + 80);
      const loaIdx = out.indexOf('Reserved LoA 0');
      const tailIdx = out.indexOf('tail crumb');
      if (tailIdx >= 0) expect(loaIdx).toBeLessThan(tailIdx);
    } finally {
      closeDb();
      if (previousDb === undefined) delete process.env.RECALL_DB_PATH;
      else process.env.RECALL_DB_PATH = previousDb;
      if (previousSkip === undefined) delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
      else process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = previousSkip;
      if (previousIdentity === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = previousIdentity;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Codex SessionStart JSON fixture', () => {
  test('fixture fails if Codex key becomes additional_context', () => {
    const fixture = JSON.parse(readFileSync(CODEX_FIXTURE, 'utf-8')) as Record<string, unknown>;
    expect(fixture).toHaveProperty('hookSpecificOutput');
    expect(fixture).not.toHaveProperty('additional_context');
    const inner = fixture.hookSpecificOutput as Record<string, unknown>;
    expect(inner.hookEventName).toBe('SessionStart');
    expect(inner).toHaveProperty('additionalContext');
    expect(inner).not.toHaveProperty('additional_context');

    const source = readFileSync(join(REPO, 'src', 'commands', 'host-hook.ts'), 'utf-8');
    const sessionStartJson = source.match(
      /stdout:\s*JSON\.stringify\(\{\s*hookSpecificOutput:[\s\S]*?additionalContext:[\s\S]*?\}\s*\),/,
    )?.[0];
    expect(sessionStartJson).toBeDefined();
    expect(sessionStartJson).toContain("hookEventName: 'SessionStart'");
    expect(sessionStartJson).toContain('additionalContext');
    expect(sessionStartJson).not.toMatch(/\badditional_context\b/);

    const result = handleHostHook(
      'codex',
      { hook_event_name: 'SessionStart', session_id: 'codex-native-123' },
      { renderContext: () => '## Recall context' },
    );
    expect(JSON.parse(result.stdout ?? '{}')).toEqual(fixture);
  });
});

describe('runStart format wrapper', () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';

  afterEach(() => {
    process.stdout.write = originalWrite;
    captured = '';
  });

  test('cursor format wraps markdown from the same assembler', () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    }) as typeof process.stdout.write;
    const root = mkdtempSync(join(tmpdir(), 'recall-start-cursor-fmt-'));
    const previousDb = process.env.RECALL_DB_PATH;
    const previousIdentity = process.env.RECALL_IDENTITY_PATH;
    try {
      process.env.RECALL_DB_PATH = join(root, 'missing.db');
      process.env.RECALL_IDENTITY_PATH = join(root, 'missing.md');
      runStart({ format: 'cursor' });
      const parsed = JSON.parse(captured);
      expect(parsed).toEqual({ additional_context: MEMORY_UNAVAILABLE });
      expect(parsed).not.toHaveProperty('hookSpecificOutput');
    } finally {
      if (previousDb === undefined) delete process.env.RECALL_DB_PATH;
      else process.env.RECALL_DB_PATH = previousDb;
      if (previousIdentity === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = previousIdentity;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('host project dir env for session start', () => {
  test('resolveSessionStartCwd prefers CURSOR_PROJECT_DIR then CLAUDE_PROJECT_DIR', () => {
    expect(resolveSessionStartCwd({
      CURSOR_PROJECT_DIR: '/work/api',
      CLAUDE_PROJECT_DIR: '/work/other',
    }, '/home/me/.cursor')).toBe('/work/api');
    expect(resolveSessionStartCwd({
      CLAUDE_PROJECT_DIR: '/work/other',
    }, '/home/me/.cursor')).toBe('/work/other');
    expect(resolveSessionStartCwd({
      CURSOR_PROJECT_DIR: '  ',
      CLAUDE_PROJECT_DIR: '/work/other',
    }, '/home/me/.cursor')).toBe('/work/other');
    expect(resolveSessionStartCwd({}, '/home/me/.cursor')).toBe('/home/me/.cursor');
  });

  test('detectProject uses git-remote/basename of CURSOR_PROJECT_DIR, not process.cwd()', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-start-cursor-dir-'));
    const previousCursor = process.env.CURSOR_PROJECT_DIR;
    const previousClaude = process.env.CLAUDE_PROJECT_DIR;
    try {
      const project = join(root, 'api');
      mkdirSync(project, { recursive: true });
      execFileSync('git', ['init'], { cwd: project, stdio: 'pipe' });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], {
        cwd: project,
        stdio: 'pipe',
      });
      process.env.CURSOR_PROJECT_DIR = project;
      delete process.env.CLAUDE_PROJECT_DIR;
      expect(detectProject()).toBe('widget');

      delete process.env.CURSOR_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = join(root, 'plain-project');
      mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
      expect(detectProject()).toBe('plain-project');
    } finally {
      if (previousCursor === undefined) delete process.env.CURSOR_PROJECT_DIR;
      else process.env.CURSOR_PROJECT_DIR = previousCursor;
      if (previousClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousClaude;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('buildL0 reads project-local identity.md from CURSOR_PROJECT_DIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-start-cursor-id-'));
    const previousCursor = process.env.CURSOR_PROJECT_DIR;
    const previousIdentity = process.env.RECALL_IDENTITY_PATH;
    const previousHome = process.env.HOME;
    try {
      const project = join(root, 'api');
      mkdirSync(join(project, '.atlas-recall'), { recursive: true });
      writeFileSync(join(project, '.atlas-recall', 'identity.md'), '# Widget identity\nKeep the locale in the cache key.\n');
      process.env.CURSOR_PROJECT_DIR = project;
      process.env.HOME = join(root, 'home');
      delete process.env.RECALL_IDENTITY_PATH;
      expect(buildL0()).toContain('Widget identity');
    } finally {
      if (previousCursor === undefined) delete process.env.CURSOR_PROJECT_DIR;
      else process.env.CURSOR_PROJECT_DIR = previousCursor;
      if (previousIdentity === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = previousIdentity;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recall start cwd ~/.cursor still filters L1 to CURSOR_PROJECT_DIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-start-cursor-cwd-'));
    const previousDb = process.env.RECALL_DB_PATH;
    const previousSkip = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
    const previousIdentity = process.env.RECALL_IDENTITY_PATH;
    const previousCursor = process.env.CURSOR_PROJECT_DIR;
    const previousHome = process.env.HOME;
    try {
      const cursorHome = join(root, '.cursor');
      const project = join(root, 'widget');
      mkdirSync(cursorHome, { recursive: true });
      mkdirSync(join(project, '.atlas-recall'), { recursive: true });
      writeFileSync(join(project, '.atlas-recall', 'identity.md'), '# Widget identity\n');
      execFileSync('git', ['init'], { cwd: project, stdio: 'pipe' });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], {
        cwd: project,
        stdio: 'pipe',
      });

      const dbPath = join(root, 'recall.db');
      process.env.RECALL_DB_PATH = dbPath;
      process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = '1';
      initDb();
      createSession({ session_id: 'cursor-env-sess', started_at: new Date().toISOString() });
      createLoaEntry({ title: 'workspace loa', fabric_extract: 'keep me', project: 'widget' });
      createLoaEntry({ title: 'hooks-dir loa', fabric_extract: 'wrong cwd', project: '.cursor' });
      addBreadcrumb({ content: 'workspace crumb', project: 'widget', importance: 9 });
      addBreadcrumb({ content: 'hooks-dir crumb', project: '.cursor', importance: 9 });
      closeDb();

      const result = runCli(['start'], {
        RECALL_DB_PATH: dbPath,
        RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
        RECALL_IDENTITY_PATH: '',
        CURSOR_PROJECT_DIR: project,
        HOME: join(root, 'home'),
      }, cursorHome);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('**Project:** widget');
      expect(result.stdout).toContain('Widget identity');
      expect(result.stdout).toContain('workspace loa');
      expect(result.stdout).toContain('workspace crumb');
      expect(result.stdout).not.toContain('hooks-dir loa');
      expect(result.stdout).not.toContain('hooks-dir crumb');
    } finally {
      closeDb();
      if (previousDb === undefined) delete process.env.RECALL_DB_PATH;
      else process.env.RECALL_DB_PATH = previousDb;
      if (previousSkip === undefined) delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
      else process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = previousSkip;
      if (previousIdentity === undefined) delete process.env.RECALL_IDENTITY_PATH;
      else process.env.RECALL_IDENTITY_PATH = previousIdentity;
      if (previousCursor === undefined) delete process.env.CURSOR_PROJECT_DIR;
      else process.env.CURSOR_PROJECT_DIR = previousCursor;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
