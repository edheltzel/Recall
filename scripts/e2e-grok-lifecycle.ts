#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  assertMetadataUnchanged,
  assertSafeTestDb,
  metadata,
  stringEnv,
} from './lib/e2e-isolation';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const tempRoot = mkdtempSync(join(tmpdir(), 'recall-grok-lifecycle-e2e-'));
const testDb = join(tempRoot, 'recall-test.db');
const testRecallHome = join(tempRoot, 'recall-home');
const testGrokHome = join(tempRoot, 'grok-home');
const testHome = join(tempRoot, 'home');
const testBin = join(tempRoot, 'bin');
const workspace = join(tempRoot, 'workspace');

function runGrok(args: string[], env: Record<string, string>, cwd = workspace): string {
  const result = spawnSync('grok', args, { cwd, env, encoding: 'utf-8', timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(
      `grok ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

function runLifecycleHelper(name: string, env: Record<string, string>): void {
  const result = spawnSync(
    'bash',
    ['-c', `source ${JSON.stringify(join(repoRoot, 'lib', 'install-lib.sh'))}; ${name}`],
    { cwd: repoRoot, env, encoding: 'utf-8' }
  );
  if (result.status !== 0) {
    throw new Error(`${name} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function startMockModel(): Promise<{ port: number; stop: () => void }> {
  const portFile = join(tempRoot, 'mock-model.port');
  const serverFile = join(tempRoot, 'mock-model.ts');
  writeFileSync(
    serverFile,
    `
    import { writeFileSync } from 'fs';
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/models')) {
          return Response.json({ object: 'list', data: [{ id: 'recall-e2e-model', object: 'model' }] });
        }
        if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
        const created = Math.floor(Date.now() / 1000);
        const chunks = [
          { id: 'chatcmpl-recall', object: 'chat.completion.chunk', created, model: 'recall-e2e-model', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          { id: 'chatcmpl-recall', object: 'chat.completion.chunk', created, model: 'recall-e2e-model', choices: [{ index: 0, delta: { content: 'Automatic Grok capture completed.' }, finish_reason: null }] },
          { id: 'chatcmpl-recall', object: 'chat.completion.chunk', created, model: 'recall-e2e-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ];
        const body = chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\\n\\n').join('') + 'data: [DONE]\\n\\n';
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    writeFileSync(${JSON.stringify(portFile)}, String(server.port));
    process.on('SIGTERM', () => { server.stop(true); process.exit(0); });
    await new Promise(() => {});
  `
  );
  const child = spawn('bun', [serverFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt++) {
    await Bun.sleep(25);
  }
  if (!existsSync(portFile)) {
    child.kill();
    throw new Error('mock model server did not start');
  }
  return {
    port: Number(readFileSync(portFile, 'utf-8')),
    stop: () => child.kill(),
  };
}

async function main(): Promise<void> {
  const productionBefore = metadata(productionDb);
  for (const path of [testRecallHome, testGrokHome, testHome, testBin, workspace]) {
    mkdirSync(path, { recursive: true });
  }
  assertSafeTestDb(testDb, productionDb);

  const env = stringEnv({
    ...process.env,
    HOME: testHome,
    GROK_HOME: testGrokHome,
    RECALL_HOME: testRecallHome,
    RECALL_DIR: testRecallHome,
    RECALL_DB_PATH: testDb,
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
    PATH: `${testBin}:${process.env.PATH || ''}`,
  });

  const init = spawnSync('bun', ['run', 'src/index.ts', 'init'], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
  });
  if (init.status !== 0) throw new Error(`test DB init failed\n${init.stdout}\n${init.stderr}`);
  const hookPayloadLog = join(tempRoot, 'grok-hook-payloads.jsonl');
  const hookEnvLog = join(tempRoot, 'grok-hook-env.txt');
  const hookStderrLog = join(tempRoot, 'grok-hook-stderr.log');
  writeFileSync(
    join(testBin, 'recall'),
    `#!/bin/sh
payload="$(cat)"
printf '%s\\n' "$payload" >> ${JSON.stringify(hookPayloadLog)}
env | sort > ${JSON.stringify(hookEnvLog)}
printf '%s' "$payload" | bun ${JSON.stringify(join(repoRoot, 'dist', 'index.js'))} "$@" 2>> ${JSON.stringify(hookStderrLog)}
`,
    { mode: 0o755 }
  );

  console.log(`isolation.test_db=${testDb}`);
  console.log(`grok.version=${runGrok(['--version'], env).trim()}`);
  runLifecycleHelper('recall_install_grok_platform', env);
  const installedHook = join(testGrokHome, 'hooks', 'RecallLifecycle.json');
  if (!existsSync(installedHook)) throw new Error('Recall Grok lifecycle hook was not installed');
  const inspect = parseJson<{
    hooks?: Array<{ event?: string; target?: string; source?: { type?: string; path?: string } }>;
  }>(runGrok(['inspect', '--json'], env), 'grok inspect');
  const installedHooks = inspect.hooks?.filter(hook =>
    hook.target === 'recall host-hook grok'
      && hook.source?.type === 'user'
      && hook.source.path === join(testGrokHome, 'hooks')
  ) ?? [];
  if (installedHooks.length !== 4) {
    throw new Error(`Recall Grok global hooks were not composed: ${JSON.stringify(inspect.hooks)}`);
  }
  console.log('grok.global_hook_loaded=true');

  const grokSessionId = randomUUID();
  const model = await startMockModel();
  try {
    appendFileSync(
      join(testGrokHome, 'config.toml'),
      `

[models]
default = "recall-e2e"

[model.recall-e2e]
model = "recall-e2e-model"
base_url = "http://127.0.0.1:${model.port}/v1"
api_key = "test-only-key"
api_backend = "chat_completions"
context_window = 16000
`
    );
    const effective = parseJson<{
      hooks?: Array<{ target?: string; source?: { path?: string } }>;
    }>(runGrok(['inspect', '--json'], env), 'grok inspect before headless run');
    if (!effective.hooks?.some(hook =>
      hook.target === 'recall host-hook grok' && hook.source?.path === join(testGrokHome, 'hooks')
    )) {
      throw new Error(`Recall Grok hook was absent in the run configuration: ${JSON.stringify(effective.hooks)}`);
    }
    runGrok(
      [
        '-p',
        'Capture this current CLI session automatically.',
        '-m',
        'recall-e2e',
        '--trust',
        '--session-id',
        grokSessionId,
        '--debug',
        '--debug-file',
        join(tempRoot, 'grok-headless-debug.log'),
      ],
      env
    );
  } finally {
    model.stop();
  }

  const db = new Database(testDb, { readonly: true });
  const session = db
    .prepare(`
    SELECT session_id, source FROM sessions WHERE source = 'grok' ORDER BY id DESC LIMIT 1
  `)
    .get() as { session_id: string; source: string } | undefined;
  if (!session) {
    db.close();
    const direct = spawnSync(join(testBin, 'recall'), ['host-hook', 'grok'], {
      cwd: workspace,
      env,
      encoding: 'utf-8',
      input: JSON.stringify({
        hookEventName: 'Stop',
        sessionId: grokSessionId,
        cwd: workspace,
        workspaceRoot: workspace,
        timestamp: new Date().toISOString(),
        reason: 'end_turn',
      }),
    });
    const directDb = new Database(testDb, { readonly: true });
    const directRow = directDb.prepare(
      'SELECT session_id, source FROM sessions WHERE session_id = ?'
    ).get(grokSessionId);
    directDb.close();
    const diagnostic = [
      'expected=one automatic recall.db session row after Grok Stop',
      'observed=headless session completed repeatedly with no hook invocation and no row',
      `event=Stop config=trusted global hook session=${grokSessionId}`,
      `manual_status=${direct.status} manual_row=${JSON.stringify(directRow)} manual_stderr=${direct.stderr}`,
      `payloads=${existsSync(hookPayloadLog) ? readFileSync(hookPayloadLog, 'utf-8') : '<none>'}`,
      `hook_env=${existsSync(hookEnvLog) ? readFileSync(hookEnvLog, 'utf-8') : '<none>'}`,
      `hook_stderr=${existsSync(hookStderrLog) ? readFileSync(hookStderrLog, 'utf-8') : '<none>'}`,
      `grok_debug=${existsSync(join(tempRoot, 'grok-headless-debug.log')) ? readFileSync(join(tempRoot, 'grok-headless-debug.log'), 'utf-8') : '<none>'}`,
    ].join('\n');
    throw new Error(`Grok lifecycle hook did not create an automatic session row\n${diagnostic}`);
  }
  const captured = db
    .prepare(`
      SELECT COUNT(*) AS count, GROUP_CONCAT(content, '\n') AS content
      FROM published_messages WHERE session_id = ?
    `)
    .get(session.session_id) as { count: number; content: string };
  const firstCount = captured.count;
  db.close();
  if (
    firstCount < 1 ||
    !captured.content.includes('Capture this current CLI session automatically.') ||
    !captured.content.includes('Automatic Grok capture completed.')
  ) {
    throw new Error(`Grok lifecycle hook captured an incomplete export: ${JSON.stringify(captured)}`);
  }
  console.log(`grok.automatic_rows=${firstCount}`);

  const replay = spawnSync(join(testBin, 'recall'), ['host-hook', 'grok'], {
    cwd: workspace,
    env,
    encoding: 'utf-8',
    input: JSON.stringify({ hookEventName: 'Stop', sessionId: session.session_id, cwd: workspace }),
  });
  if (replay.status !== 0) throw new Error(`Grok hook replay failed\n${replay.stderr}`);
  const replayDb = new Database(testDb, { readonly: true });
  const replayCount = (
    replayDb
      .prepare('SELECT COUNT(*) AS count FROM published_messages WHERE session_id = ?')
      .get(session.session_id) as { count: number }
  ).count;
  replayDb.close();
  if (replayCount !== firstCount)
    throw new Error(`Grok replay duplicated rows: ${firstCount} to ${replayCount}`);
  console.log('grok.deduplication=true');

  runLifecycleHelper('recall_uninstall_grok_platform', env);
  const afterRemoval = parseJson<{ hooks?: Array<{ target?: string; source?: { path?: string } }> }>(
    runGrok(['inspect', '--json'], env),
    'grok inspect after removal'
  );
  if (existsSync(installedHook)) throw new Error('Recall Grok hook file survived uninstall');
  if (afterRemoval.hooks?.some(hook =>
    hook.target === 'recall host-hook grok' && hook.source?.path === join(testGrokHome, 'hooks')
  )) {
    throw new Error('Recall Grok hook registration survived uninstall');
  }
  console.log('grok.global_hook_cleanup=true');

  assertMetadataUnchanged(productionDb, productionBefore);
  console.log('isolation.production_db_unchanged=true');
  console.log('e2e.status=PASS');
}

try {
  await main();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
