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
const recallHome = join(scratch, 'recall');
const identityPath = join(recallHome, 'MEMORY', 'identity.md');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const protectedPaths = [productionDb, `${productionDb}-wal`, `${productionDb}-shm`, join(homedir(), '.omp', 'plugins', 'omp-plugins.lock.json')];
const before = protectedPaths.map(path => metadata(path));
assertSafeTestDb(dbPath, productionDb);
console.log(`RECALL_DB_PATH=${dbPath}\nRECALL_HOME=${recallHome}`);
mkdirSync(agent, { recursive: true });
mkdirSync(join(recallHome, 'MEMORY'), { recursive: true });
writeFileSync(identityPath, 'I am the cobalt orchard keeper.\n');
const env = {
  PATH: process.env.PATH ?? '', HOME: home, TMPDIR: scratch,
  PI_CONFIG_DIR: join(home, '.omp'), PI_CODING_AGENT_DIR: agent,
  RECALL_DB_PATH: dbPath, RECALL_HOME: recallHome,
  RECALL_IDENTITY_PATH: identityPath,
  TERM: 'dumb', NO_COLOR: '1', PI_NO_TITLE: '1',
};

let requests = 0;
const requestBodies: unknown[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
    requestBodies.push(await request.json());
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

const firstPrompt = 'Remember the cobalt orchard decision.';
const secondPrompt = 'Keep the cobalt orchard decision.';
const firstParts = [firstPrompt, 'Native capture answer 1.'];
const resumedParts = [...firstParts, secondPrompt, 'Native capture answer 2.'];

function assertOrdered(text: string, parts: string[], label: string): void {
  let at = -1;
  for (const part of parts) {
    const next = text.indexOf(part, at + 1);
    assert(next > at, `${label} missing ordered text: ${part}`);
    at = next;
  }
}

try {
  writeFileSync(join(agent, 'models.yml'), `providers:\n  recall-smoke:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: recall-smoke\n        name: Recall smoke\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 1024\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`);
  writeFileSync(join(agent, 'config.yml'), 'compaction:\n  enabled: false\n');
  const packed: unknown = JSON.parse(await run(['pack', root, '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm'));
  const packages = Array.isArray(packed) ? packed : packed && typeof packed === 'object' ? Object.values(packed) : [];
  assert(packages[0] && typeof packages[0].filename === 'string');
  await run(['-xzf', join(scratch, packages[0].filename), '-C', scratch], 'tar');
  const packedDir = join(scratch, 'package');
  const packagedCli = join(packedDir, 'dist', 'index.js');
  await run([packagedCli, 'init'], 'bun');
  await run(['plugin', 'link', packedDir]);
  const flags = ['--print', '--model', 'recall-smoke/recall-smoke', '--no-skills', '--no-rules', '--no-lsp', '--no-title'];
  const firstAnswer = await run([...flags, firstPrompt]);
  assert.match(firstAnswer, /Native capture answer 1\./, 'first assistant turn completed');
  assert.equal(requests, 1);
  const firstRequest = JSON.stringify(requestBodies[0] ?? {});
  assert.match(firstRequest, /I am the cobalt orchard keeper/, 'session_start injects recall start L0 into the first model request');
  assert.match(firstRequest, /Recall — Session Memory/, 'session_start injects the shared L0/L1 bundle');
  const firstMessages = capturedMessages();
  const firstText = firstMessages.map(message => message.content).join('\n');
  assert(firstMessages.length >= 1, 'first capture wrote ambient text');
  assertOrdered(firstText, firstParts, 'first capture');
  assert(firstMessages.every(message => message.source === 'omp'), 'capture retains omp attribution');
  const sessionId = firstMessages[0]?.session_id;
  assert(sessionId);
  const secondAnswer = await run([...flags, '--continue', secondPrompt]);
  assert.match(secondAnswer, /Native capture answer 2\./, 'resumed assistant turn completed');
  assert.equal(requests, 2);
  const resumedMessages = capturedMessages();
  const resumedText = resumedMessages.map(message => message.content).join('\n');
  assertOrdered(resumedText, resumedParts, 'resume');
  assert(resumedMessages.every(message => message.session_id === sessionId), 'resume stays in the same session');
  assert(resumedMessages.every(message => message.source === 'omp'), 'resumed capture retains omp attribution');
  const search = await run([packagedCli, 'cobalt orchard'], 'bun');
  assert.match(search, /Remember the cobalt orchard decision/);
  // One turn blob, not host-hook rows: later prompts sit past the 80-char preview.
  const keeper = resumedMessages.find(message => message.content.includes(secondPrompt));
  assert(keeper, 'resume stored the second prompt');
  const phraseSearch = await run([packagedCli, 'search', secondPrompt.replace(/\.$/, '')], 'bun');
  assert.match(phraseSearch, new RegExp(`\\[messages#${keeper.id}\\]`));
  await run(['plugin', 'uninstall', 'recall-memory']);
  const uncapturedAnswer = await run([...flags, '--continue', 'This turn must not be captured.']);
  assert.match(uncapturedAnswer, /Native capture answer 3\./, 'post-uninstall assistant turn completed');
  assert.equal(requests, 3, 'post-uninstall turn reached the model');
  assert.deepEqual(capturedMessages(), resumedMessages, 'completed post-uninstall turn leaves captured history unchanged');
  console.log('PASS native plugin link, session_start inject, session_stop capture, resume deduplication, and uninstall.');
  console.log(`omp.session_start_returned=${JSON.stringify({
    identity: 'I am the cobalt orchard keeper.',
    requestHasIdentity: /I am the cobalt orchard keeper/.test(firstRequest),
  })}`);
} finally {
  server.stop(true);
  for (const [index, path] of protectedPaths.entries()) assertMetadataUnchanged(path, before[index]!);
  rmSync(scratch, { recursive: true, force: true });
}
