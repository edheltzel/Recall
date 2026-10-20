import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { CAPTURE_MAX_BYTES, payloadBytes } from '../../hooks/lib/hosts/capture-door';
import { empryoHookPayload, isEmpryoTranscript } from '../../hooks/lib/hosts/empryo/ambient-capture';

const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'index.ts');
const HOOK = join(REPO, 'hooks', 'RecallExtract.ts');
const ADAPTER = join(REPO, 'hooks', 'lib', 'hosts', 'empryo', 'ambient-capture.ts');
const PRODUCTION_DB = join(homedir(), '.agents', 'Recall', 'recall.db');
const LATEST = 'empryoquokka812';
const EARLIER = 'empryoearlier812';
const HIDDEN = 'empryohidden812';
const CLAUDE_ONLY = 'claudeonly812';

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

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function isolationEnv(root: string, bin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RECALL_DB_PATH: join(root, 'recall.db'),
    RECALL_HOME: join(root, 'recall-home'),
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
  };
}

function writeJsonl(path: string, lines: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

function sessionLog(project: string, id = 'mvf812-abc', version = 1): string {
  const path = join(project, '.empryo', 'sessions', id, 'session.jsonl');
  const ui = (content: string, hidden?: boolean) => ({ id: 'x', role: 'r', content, timestamp: 1, ...(hidden ? { hidden } : {}) });
  writeJsonl(path, [
    { k: 'meta', v: version, id, cwd: project, host: 'desktop', startedAt: 1, seq: 1, ts: 1 },
    { k: 'user', tabId: 'main', turnId: 't1', ui: ui(`Earlier ask ${EARLIER}`), seq: 2, ts: 10 },
    { k: 'tool-start', tabId: 'main', turnId: 't1', name: 'shell', args: { command: 'secret noise' }, seq: 3, ts: 11 },
    { k: 'assistant', tabId: 'main', turnId: 't1', status: 'complete', ui: ui('Earlier answer.'), seq: 4, ts: 20 },
    { k: 'user', tabId: 'tab2', turnId: 'link1', ui: ui(`Agent link ${HIDDEN}`, true), seq: 5, ts: 25 },
    { k: 'assistant', tabId: 'tab2', turnId: 'link1', status: 'complete', ui: ui('Acknowledged.'), seq: 6, ts: 26 },
    { k: 'user', tabId: 'main', turnId: 't2', ui: ui(`Remember ${LATEST} for Empryo.`), seq: 7, ts: 30 },
    { k: 'assistant', tabId: 'main', turnId: 't2', status: 'complete', ui: ui(`Stored ${LATEST}.`), seq: 8, ts: 40 },
    { k: 'user', tabId: 'main', turnId: 't3', ui: ui('Still running'), seq: 9, ts: 50 },
  ]);
  return path;
}

function recallShim(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const recall = join(bin, 'recall');
  writeFileSync(recall, `#!/bin/sh\nexec bun ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(recall, 0o755);
  return bin;
}

function search(env: NodeJS.ProcessEnv, term: string): string {
  const result = spawnSync('bun', [CLI, 'search', term, '-t', 'messages'], { env, encoding: 'utf-8' });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('Empryo session log payloads', () => {
  test('recognizes only Empryo session logs', () => {
    expect(isEmpryoTranscript('/p/.empryo/sessions/abc/session.jsonl')).toBe(true);
    expect(isEmpryoTranscript('/home/u/.claude/projects/-p/abc.jsonl')).toBe(false);
    expect(isEmpryoTranscript('/p/.empryo/sessions/abc/session.jsonl.bak')).toBe(false);
    expect(isEmpryoTranscript(undefined)).toBe(false);
  });

  test('Stop sends the latest completed visible turn as harness empryo', () => {
    const project = join(tempRoot('recall-empryo-shape-'), 'Recall');
    const payload = empryoHookPayload(sessionLog(project), { hookEvent: 'Stop' });
    expect(payload).toMatchObject({
      contract: 1,
      harness: 'empryo',
      event: 'turn_end',
      session_id: 'mvf812-abc',
      cwd: project,
      project: 'Recall',
    });
    expect(payload?.text).toBe(`user: Remember ${LATEST} for Empryo.\n\nassistant: Stored ${LATEST}.`);
  });

  test('SessionEnd sends every completed turn but never hidden agent traffic or tool output', () => {
    const project = join(tempRoot('recall-empryo-end-'), 'Recall');
    const payload = empryoHookPayload(sessionLog(project), { hookEvent: 'SessionEnd' });
    expect(payload?.event).toBe('session_end');
    expect(payload?.text).toContain(EARLIER);
    expect(payload?.text).toContain(LATEST);
    expect(payload?.text).not.toContain(HIDDEN);
    expect(payload?.text).not.toContain('secret noise');
    expect(payload?.text).not.toContain('Still running');
  });

  test('oversized SessionEnd keeps the newest turns whose escaped JSON fits the door', () => {
    const project = join(tempRoot('recall-empryo-cap-'), 'Recall');
    const path = join(project, '.empryo', 'sessions', 'mvf812-big', 'session.jsonl');
    const quotes = '"'.repeat(9 * 1024 * 1024);
    const lines: unknown[] = [{ k: 'meta', v: 1, id: 'mvf812-big', cwd: project }];
    for (const [n, marker] of ['oldestturn812', 'middleturn812', 'newestturn812'].entries()) {
      lines.push({ k: 'user', tabId: 'main', turnId: `t${n}`, ui: { content: `${marker} ${quotes}` }, ts: n * 10 });
      lines.push({ k: 'assistant', tabId: 'main', turnId: `t${n}`, status: 'complete', ui: { content: 'ok' }, ts: n * 10 + 1 });
    }
    writeJsonl(path, lines);

    const payload = empryoHookPayload(path, { hookEvent: 'SessionEnd' });
    expect(payload).not.toBeNull();
    // Two turns of raw text fit the cap, so a raw-byte budget would keep the middle turn too.
    expect(Buffer.byteLength(payload!.text, 'utf-8') * 2).toBeLessThan(CAPTURE_MAX_BYTES);
    expect(payloadBytes(payload!)).toBeLessThanOrEqual(CAPTURE_MAX_BYTES);
    expect(payload!.text).toContain('newestturn812');
    expect(payload!.text).not.toContain('middleturn812');
    expect(payload!.text).not.toContain('oldestturn812');
  }, 30_000);

  test('an unknown log version captures nothing', () => {
    const project = join(tempRoot('recall-empryo-version-'), 'Recall');
    expect(empryoHookPayload(sessionLog(project, 'mvf812-v2', 2))).toBeNull();
  });

  test('adapter does not import src', () => {
    expect(readFileSync(ADAPTER, 'utf-8')).not.toMatch(/from ['"][^'"]*\/src\//);
  });
});

describe('Empryo through the Claude Stop hook', () => {
  test('stores the Empryo turn and never extracts an unrelated Claude transcript', () => {
    const root = tempRoot('recall-empryo-stop-');
    const env = isolationEnv(root, recallShim(root));
    expect(spawnSync('bun', [CLI, 'init'], { env, encoding: 'utf-8' }).status).toBe(0);

    const project = join(root, 'Recall');
    const transcript = sessionLog(project);
    writeJsonl(join(root, '.claude', 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), 'stale.jsonl'), [
      { type: 'user', sessionId: 'stale', cwd: project, message: { role: 'user', content: `Old ${CLAUDE_ONLY}` } },
      { type: 'assistant', sessionId: 'stale', cwd: project, message: { role: 'assistant', content: 'Old reply.' } },
    ]);

    const hook = spawnSync('bun', [HOOK], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'mvf812-abc', transcript_path: transcript, cwd: project }),
      env,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(hook.status).toBe(0);

    expect(search(env, LATEST)).toContain(LATEST);
    expect(search(env, EARLIER)).not.toContain(EARLIER);
    expect(search(env, CLAUDE_ONLY)).not.toContain(CLAUDE_ONLY);

    const db = new Database(join(root, 'recall.db'), { readonly: true });
    try {
      const loa = db.query<{ tags: string }, []>('SELECT tags FROM loa_entries').all();
      expect(loa).toEqual([{ tags: 'automatic-capture,empryo' }]);
    } finally {
      db.close();
    }
  }, 30_000);
});
