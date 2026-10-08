import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  claudeHookPayload,
  discoverClaudePayloads,
  payloadsForTranscript,
} from '../../hooks/lib/hosts/claude/ambient-capture';

const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'index.ts');
const HOOK = join(REPO, 'hooks', 'RecallExtract.ts');
const WATCHER = join(REPO, 'hooks', 'lib', 'hosts', 'claude', 'ambient-capture.ts');
const PRODUCTION_DB = join(homedir(), '.agents', 'Recall', 'recall.db');
const TOKEN = 'capturequokka640';
const EARLIER = 'earlierturn640';

const roots: string[] = [];
const productionBefore = metadata(PRODUCTION_DB);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(metadata(PRODUCTION_DB)).toEqual(productionBefore);
});

function metadata(path: string): { exists: boolean; size?: number; mtimeMs?: number; ino?: number } {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

function isolationEnv(root: string): NodeJS.ProcessEnv {
  const dbPath = join(root, 'recall.db');
  expect(dbPath).not.toBe(PRODUCTION_DB);
  return {
    ...process.env,
    HOME: root,
    RECALL_DB_PATH: dbPath,
    RECALL_HOME: join(root, 'recall-home'),
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
  };
}

function writeJsonl(path: string, lines: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

function transcript(sessionId = 'ses-640', cwd = '/work/Recall'): unknown[] {
  return [
    {
      type: 'user',
      sessionId,
      cwd,
      message: { role: 'user', content: `Earlier note ${EARLIER} that must not be the Stop payload.` },
    },
    {
      type: 'assistant',
      sessionId,
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier reply.' }, { type: 'tool_use', name: 'bash' }] },
    },
    {
      type: 'user',
      sessionId,
      cwd,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'noise' }] },
    },
    {
      type: 'user',
      sessionId,
      cwd,
      message: { role: 'user', content: `Remember ${TOKEN} for the adapter door.` },
    },
    {
      type: 'assistant',
      sessionId,
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: `Stored ${TOKEN} as the ambient fact.` }] },
    },
  ];
}

describe('Claude ambient capture payloads', () => {
  test('Stop uses the latest turn; discover emits that same payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-claude-shape-'));
    roots.push(root);
    const file = join(root, '.claude', 'projects', '-work-Recall', 'ses-640.jsonl');
    writeJsonl(file, transcript());

    const hook = claudeHookPayload(file);
    const discovered = discoverClaudePayloads(join(root, '.claude', 'projects'));
    expect(hook).toEqual(discovered[discovered.length - 1]);
    expect(hook).toMatchObject({
      contract: 1,
      harness: 'claude',
      event: 'turn_end',
      session_id: 'ses-640',
      cwd: '/work/Recall',
      project: 'Recall',
    });
    expect(hook?.text).toContain(TOKEN);
    expect(hook?.text).not.toContain(EARLIER);
    expect(discovered).toHaveLength(2);
    expect(discovered[0]?.text).toContain(EARLIER);
  });

  test('SessionEnd sends the whole transcript once; no user turn is session_end', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-claude-session-end-'));
    roots.push(root);
    const file = join(root, 'session.jsonl');
    writeJsonl(file, transcript());
    const ended = claudeHookPayload(file, { hookEvent: 'SessionEnd' });
    expect(ended?.event).toBe('session_end');
    expect(ended?.text).toContain(TOKEN);
    expect(ended?.text).toContain(EARLIER);

    const loose = join(root, 'loose.jsonl');
    writeJsonl(loose, [{
      message: { role: 'assistant', content: 'assistant-only ambient text' },
    }]);
    expect(claudeHookPayload(loose)?.event).toBe('session_end');
    expect(payloadsForTranscript(loose)).toEqual([claudeHookPayload(loose)]);
  });

  test('discover skips agent transcripts unless subagents are included', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-claude-agent-'));
    roots.push(root);
    const projects = join(root, 'projects');
    writeJsonl(join(projects, '-work-Recall', 'agent-child.jsonl'), transcript('agent-child'));
    expect(discoverClaudePayloads(projects)).toEqual([]);
    const previous = process.env.RECALL_INCLUDE_SUBAGENTS;
    process.env.RECALL_INCLUDE_SUBAGENTS = '1';
    try {
      expect(discoverClaudePayloads(projects)).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.RECALL_INCLUDE_SUBAGENTS;
      else process.env.RECALL_INCLUDE_SUBAGENTS = previous;
    }
  });

  test('capture helper and Stop hook do not import src', () => {
    const helper = readFileSync(WATCHER, 'utf-8');
    const hook = readFileSync(HOOK, 'utf-8');
    expect(helper).not.toMatch(/from ['"][^'"]*\/src\//);
    expect(hook).not.toMatch(/from ['"][^'"]*\/src\//);
    expect(hook).toContain("spawn(bunPath, ['run', import.meta.path, '--extract'");
    expect(hook).toContain('runRecallCapture');
  });
});

describe('Claude Stop capture door', () => {
  test('Stop with transcript_path stores a searchable ambient fact', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-claude-stop-'));
    roots.push(root);
    const env = isolationEnv(root);
    const init = spawnSync('bun', [CLI, 'init'], { env, encoding: 'utf-8' });
    expect(init.status).toBe(0);

    const transcriptPath = join(root, 'session.jsonl');
    writeJsonl(transcriptPath, transcript());
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const recall = join(bin, 'recall');
    writeFileSync(recall, `#!/bin/sh\nexec bun ${JSON.stringify(CLI)} "$@"\n`);
    chmodSync(recall, 0o755);

    const hook = spawnSync('bun', [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'ses-640',
        transcript_path: transcriptPath,
        cwd: '/work/Recall',
      }),
      env: { ...env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(hook.status).toBe(0);

    const search = spawnSync('bun', [CLI, 'search', TOKEN, '-t', 'messages'], { env, encoding: 'utf-8' });
    expect(search.status).toBe(0);
    expect(search.stdout).toContain(TOKEN);
    expect(search.stdout).not.toContain(EARLIER);

    const db = new Database(join(root, 'recall.db'), { readonly: true });
    try {
      const loa = db.query<{ tags: string; importance: number }, []>(
        'SELECT tags, importance FROM loa_entries',
      ).all();
      expect(loa).toEqual([{ tags: 'automatic-capture,claude', importance: 6 }]);
    } finally {
      db.close();
    }
  }, 30_000);

  test('watcher emits the same capture JSON as the Stop payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-claude-watch-'));
    roots.push(root);
    const projects = join(root, 'projects');
    const file = join(projects, '-work-Recall', 'ses-640.jsonl');
    writeJsonl(file, transcript());
    const stdinPath = join(root, 'stdin');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const recall = join(bin, 'recall');
    writeFileSync(recall, `#!/bin/sh\ncat > ${JSON.stringify(stdinPath)}\nexit 0\n`);
    chmodSync(recall, 0o755);

    const watched = spawnSync('bun', [WATCHER, projects], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(watched.status).toBe(0);
    const sent = readFileSync(stdinPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    expect(sent[sent.length - 1]).toEqual(claudeHookPayload(file));
  });
});
