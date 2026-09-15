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

interface CapturedMessage {
  id: number;
  session_id: string;
  message_key: string | null;
  source: string | null;
  role: string;
  content: string;
}

function capturedMessages(): CapturedMessage[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<CapturedMessage, []>(`
      SELECT message.id, message.session_id, identity.source, identity.message_key, message.role, message.content
      FROM published_messages AS message
      LEFT JOIN active_host_ingest_messages AS identity
        ON identity.message_id = message.id AND identity.session_id = message.session_id
      ORDER BY identity.source_position, message.id
    `).all();
  } finally {
    db.close();
  }
}

try {
  writeFileSync(join(agent, 'models.yml'), `providers:\n  recall-smoke:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: recall-smoke\n        name: Recall smoke\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 1024\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`);
  writeFileSync(join(agent, 'config.yml'), 'compaction:\n  enabled: false\n');
  const packed: unknown = JSON.parse(await run(['pack', root, '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm'));
  const packages = Array.isArray(packed) ? packed : packed && typeof packed === 'object' ? Object.values(packed) : [];
  assert(packages[0] && typeof packages[0].filename === 'string');
  await run(['-xzf', join(scratch, packages[0].filename), '-C', scratch], 'tar');
  const packagedCli = join(scratch, 'package', 'dist', 'index.js');
  await run([packagedCli, 'init'], 'bun');
  await run(['plugin', 'link', join(scratch, 'package')]);
  const flags = ['--print', '--model', 'recall-smoke/recall-smoke', '--no-skills', '--no-rules', '--no-lsp', '--no-title'];
  const firstAnswer = await run([...flags, 'Remember the cobalt orchard decision.']);
  assert.match(firstAnswer, /Native capture answer 1\./, 'first assistant turn completed');
  assert.equal(requests, 1);
  const firstMessages = capturedMessages();
  assert.deepEqual(firstMessages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Remember the cobalt orchard decision.' },
    { role: 'assistant', content: 'Native capture answer 1.' },
  ], 'first capture preserves exact roles and content');
  assert(firstMessages.every(message => message.source === 'omp' && message.message_key?.startsWith('native:')), 'capture retains omp attribution and native identities');
  const sessionId = firstMessages[0]?.session_id;
  assert(sessionId);
  const secondAnswer = await run([...flags, '--continue', 'Keep the cobalt orchard decision.']);
  assert.match(secondAnswer, /Native capture answer 2\./, 'resumed assistant turn completed');
  assert.equal(requests, 2);
  const resumedMessages = capturedMessages();
  assert.deepEqual(resumedMessages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Remember the cobalt orchard decision.' },
    { role: 'assistant', content: 'Native capture answer 1.' },
    { role: 'user', content: 'Keep the cobalt orchard decision.' },
    { role: 'assistant', content: 'Native capture answer 2.' },
  ], 'resume preserves exact ordered roles and content');
  assert.deepEqual(resumedMessages.slice(0, firstMessages.length), firstMessages, 'resume preserves existing message identities');
  assert(resumedMessages.every(message => message.session_id === sessionId), 'resume stays in the same session');
  assert(resumedMessages.every(message => message.source === 'omp' && message.message_key?.startsWith('native:')), 'resumed capture retains omp attribution and native identities');
  assert.equal(new Set(resumedMessages.map(message => message.id)).size, 4, 'message IDs stay distinct');
  assert.equal(new Set(resumedMessages.map(message => message.message_key)).size, 4, 'native identities stay distinct');
  const search = await run([packagedCli, 'cobalt orchard'], 'bun');
  assert.match(search, /Remember the cobalt orchard decision/);
  assert.match(search, /Keep the cobalt orchard decision/);
  await run(['plugin', 'uninstall', 'recall-memory']);
  const uncapturedAnswer = await run([...flags, '--continue', 'This turn must not be captured.']);
  assert.match(uncapturedAnswer, /Native capture answer 3\./, 'post-uninstall assistant turn completed');
  assert.equal(requests, 3, 'post-uninstall turn reached the model');
  assert.deepEqual(capturedMessages(), resumedMessages, 'completed post-uninstall turn leaves captured history unchanged');
  console.log('PASS native plugin link, session_stop capture, resume deduplication, and uninstall.');
} finally {
  server.stop(true);
  for (const [index, path] of protectedPaths.entries()) assertMetadataUnchanged(path, before[index]!);
  rmSync(scratch, { recursive: true, force: true });
}
