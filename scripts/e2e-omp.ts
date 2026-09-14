#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { assertMetadataUnchanged, assertSafeTestDb, metadata } from './lib/e2e-isolation';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'recall-omp-e2e-'));
const home = join(scratch, 'home');
const agent = join(home, '.omp', 'agent');
const dbPath = join(scratch, 'recall.db');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const protectedPaths = [productionDb, `${productionDb}-wal`, `${productionDb}-shm`, join(homedir(), '.omp', 'plugins', 'omp-plugins.lock.json')];
const before = protectedPaths.map(path => metadata(path));
assertSafeTestDb(dbPath, productionDb);
console.log(`RECALL_DB_PATH=${dbPath}\nRECALL_HOME=${join(scratch, 'recall')}`);
mkdirSync(agent, { recursive: true });
const env = {
  PATH: process.env.PATH ?? '', HOME: home, TMPDIR: scratch,
  PI_CONFIG_DIR: join(home, '.omp'), PI_CODING_AGENT_DIR: agent,
  RECALL_DB_PATH: dbPath, RECALL_HOME: join(scratch, 'recall'),
  TERM: 'dumb', NO_COLOR: '1', PI_NO_TITLE: '1',
};

let requests = 0;
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
    await request.json();
    requests++;
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: `smoke-${requests}`, object: 'chat.completion.chunk', created: 1,
      model: 'recall-smoke', choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: `Native capture answer ${requests}.` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  },
});

async function run(args: string[], command = 'omp') {
  const child = Bun.spawn([command, ...args], { cwd: scratch, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `${command} ${args.join(' ')} failed\n${stdout}\n${stderr}`);
    assert.doesNotMatch(stderr, /Recall.*(?:failed|skipped)|extension.*(?:error|failed)/i, stderr);
    return stdout;
  } finally { clearTimeout(timer); }
}

try {
  writeFileSync(join(agent, 'models.yml'), `providers:\n  recall-smoke:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: recall-smoke\n        name: Recall smoke\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 1024\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`);
  writeFileSync(join(agent, 'config.yml'), 'compaction:\n  enabled: false\n');
  await run([join(root, 'dist', 'index.js'), 'init'], 'bun');
  const packed: unknown = JSON.parse(await run(['pack', root, '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm'));
  const packages = Array.isArray(packed) ? packed : packed && typeof packed === 'object' ? Object.values(packed) : [];
  assert(packages[0] && typeof packages[0].filename === 'string');
  await run(['-xzf', join(scratch, packages[0].filename), '-C', scratch], 'tar');
  await run(['plugin', 'link', join(scratch, 'package')]);
  const flags = ['--print', '--model', 'recall-smoke/recall-smoke', '--no-skills', '--no-rules', '--no-lsp', '--no-title'];
  await run([...flags, 'Remember the cobalt orchard decision.']);
  let db = new Database(dbPath, { readonly: true });
  assert.equal(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions WHERE source = 'omp'").get()?.n, 1);
  assert.equal(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM published_messages').get()?.n, 2);
  db.close();
  await run([...flags, '--continue', 'Keep the cobalt orchard decision.']);
  db = new Database(dbPath, { readonly: true });
  assert.equal(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions WHERE source = 'omp'").get()?.n, 1);
  assert.equal(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM published_messages').get()?.n, 4);
  assert.equal(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM published_messages WHERE content LIKE '%cobalt orchard%'").get()?.n, 2);
  db.close();
  assert.equal(requests, 2);
  const search = await run([join(root, 'dist', 'index.js'), 'cobalt orchard'], 'bun');
  assert.match(search, /Remember the cobalt orchard decision/);
  await run(['plugin', 'uninstall', 'recall-memory']);
  await run([...flags, '--continue', 'This turn must not be captured.']);
  db = new Database(dbPath, { readonly: true });
  assert.equal(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM published_messages').get()?.n, 4);
  db.close();
  console.log('PASS native plugin link, session_stop capture, resume deduplication, and uninstall.');
} finally {
  server.stop(true);
  for (const [index, path] of protectedPaths.entries()) assertMetadataUnchanged(path, before[index]!);
  rmSync(scratch, { recursive: true, force: true });
}
