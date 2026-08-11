#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
const tempRoot = mkdtempSync(join(tmpdir(), 'recall-codex-plugin-e2e-'));
const testDb = join(tempRoot, 'recall-test.db');
const testRecallHome = join(tempRoot, 'recall-home');
const testCodexHome = join(tempRoot, 'codex-home');
const testHome = join(tempRoot, 'home');
const testBin = join(tempRoot, 'bin');

function runCodex(args: string[], env: Record<string, string>): string {
  const result = spawnSync('codex', args, { cwd: repoRoot, env, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      `codex ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

interface CodexHookMetadata {
  eventName?: string;
  command?: string | null;
  enabled?: boolean;
  source?: string;
}

async function listCodexHooks(env: Record<string, string>): Promise<CodexHookMetadata[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`codex hooks/list timed out\n${stdout}\n${stderr}`));
    }, 15_000);

    const finish = (error?: Error, hooks?: CodexHookMetadata[]) => {
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(hooks ?? []);
    };

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(
            `${JSON.stringify({
              method: 'hooks/list',
              id: 2,
              params: { cwds: [repoRoot] },
            })}\n`
          );
        } else if (message.id === 2) {
          const data = message.result?.data;
          const hooks = Array.isArray(data)
            ? data.flatMap((entry: any) => (Array.isArray(entry.hooks) ? entry.hooks : []))
            : [];
          finish(undefined, hooks);
        }
      }
    });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (code && code !== 0) finish(new Error(`codex app-server exited ${code}\n${stderr}`));
    });
    child.stdin.write(
      `${JSON.stringify({
        method: 'initialize',
        id: 1,
        params: { clientInfo: { name: 'recall-e2e', version: '1' }, capabilities: {} },
      })}\n`
    );
  });
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

function runLifecycleHook(
  eventName: string,
  payload: Record<string, unknown>,
  env: Record<string, string>
): string {
  const result = spawnSync(join(testBin, 'recall'), ['host-hook', 'codex'], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    input: JSON.stringify({ hook_event_name: eventName, ...payload }),
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${eventName} hook failed (${result.status})\n${result.stderr}`);
  }
  return result.stdout;
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((item: any): item is { type: 'text'; text: string } => item?.type === 'text')
    .map(item => item.text)
    .join('\n');
}

async function main(): Promise<void> {
  const productionBefore = metadata(productionDb);
  mkdirSync(testRecallHome, { recursive: true });
  mkdirSync(testCodexHome, { recursive: true });
  mkdirSync(testHome, { recursive: true });
  mkdirSync(testBin, { recursive: true });

  assertSafeTestDb(testDb, productionDb);

  const env = stringEnv({
    ...process.env,
    HOME: testHome,
    CODEX_HOME: testCodexHome,
    RECALL_HOME: testRecallHome,
    RECALL_DB_PATH: testDb,
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
    PATH: `${testBin}:${process.env.PATH || ''}`,
  });

  console.log(`isolation.test_db=${testDb}`);
  console.log(`isolation.production_db=${productionDb}`);
  console.log('isolation.production_db_opened=false');

  const init = spawnSync('bun', ['run', 'src/index.ts', 'init'], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
  });
  if (init.status !== 0) throw new Error(`test DB init failed\n${init.stdout}\n${init.stderr}`);
  if (!existsSync(testDb)) throw new Error('test DB was not created');

  writeFileSync(
    join(testBin, 'recall-mcp'),
    `#!/bin/sh\nexec bun ${JSON.stringify(join(repoRoot, 'dist', 'mcp-server.js'))} "$@"\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(testBin, 'recall'),
    `#!/bin/sh\nexec bun ${JSON.stringify(join(repoRoot, 'dist', 'index.js'))} "$@"\n`,
    { mode: 0o755 }
  );

  console.log(`codex.version=${runCodex(['--version'], env).trim()}`);
  runCodex(['plugin', 'marketplace', 'add', repoRoot], env);
  const catalog = parseJson<{
    available?: Array<{ name?: string; marketplaceName?: string }>;
  }>(runCodex(['plugin', 'list', '--available', '--json'], env), 'codex plugin list --available');
  if (
    !catalog.available?.some(
      plugin => plugin.name === 'recall' && plugin.marketplaceName === 'recall-marketplace'
    )
  ) {
    throw new Error(`Recall plugin not listed by Codex: ${JSON.stringify(catalog)}`);
  }
  runCodex(['plugin', 'add', 'recall@recall-marketplace', '--json'], env);
  const installed = parseJson<{
    installed?: Array<{ pluginId?: string; enabled?: boolean }>;
  }>(runCodex(['plugin', 'list', '--json'], env), 'codex plugin list');
  if (
    !installed.installed?.some(
      plugin => plugin.pluginId === 'recall@recall-marketplace' && plugin.enabled
    )
  ) {
    throw new Error(
      `Recall plugin not installed and enabled by Codex: ${JSON.stringify(installed)}`
    );
  }
  const configuredMcp = parseJson<
    Array<{
      name?: string;
      enabled?: boolean;
      transport?: { type?: string; command?: string };
    }>
  >(runCodex(['mcp', 'list', '--json'], env), 'codex mcp list');
  if (
    !configuredMcp.some(
      server =>
        server.name === 'recall-memory' &&
        server.enabled &&
        server.transport?.type === 'stdio' &&
        server.transport.command === 'recall-mcp'
    )
  ) {
    throw new Error(
      `Recall MCP registration not loaded from the installed plugin: ${JSON.stringify(configuredMcp)}`
    );
  }
  const lifecycleHooks = (await listCodexHooks(env)).filter(
    hook => hook.command === 'recall host-hook codex' && hook.source === 'plugin' && hook.enabled
  );
  const lifecycleEvents = lifecycleHooks.map(hook => hook.eventName).sort();
  const expectedLifecycleEvents = [
    'postCompact',
    'preCompact',
    'sessionEnd',
    'sessionStart',
    'stop',
  ];
  if (JSON.stringify(lifecycleEvents) !== JSON.stringify(expectedLifecycleEvents)) {
    throw new Error(
      `Recall lifecycle hooks not loaded by Codex: ${JSON.stringify(lifecycleHooks)}`
    );
  }
  console.log('codex.plugin_installed=true');
  console.log('codex.plugin_mcp_loaded=true');
  console.log(`codex.plugin_hooks_loaded=${lifecycleHooks.length}`);

  const sessionId = 'codex-native-123';
  const transcriptPath = join(repoRoot, 'tests', 'fixtures', 'host-lifecycle', 'codex-rollout.jsonl');
  const sessionStart = parseJson<{
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  }>(
    runLifecycleHook('SessionStart', { session_id: sessionId, cwd: repoRoot }, env),
    'Codex SessionStart hook'
  );
  if (
    sessionStart.hookSpecificOutput?.hookEventName !== 'SessionStart' ||
    !sessionStart.hookSpecificOutput.additionalContext?.includes('Recall')
  ) {
    throw new Error(`Codex SessionStart did not return Recall context: ${JSON.stringify(sessionStart)}`);
  }
  console.log('codex.session_start_injection=true');

  const capturePayload = {
    session_id: sessionId,
    cwd: repoRoot,
    transcript_path: transcriptPath,
    timestamp: '2026-07-01T10:00:03.000Z',
  };
  runLifecycleHook('PreCompact', capturePayload, env);
  runLifecycleHook('PreCompact', capturePayload, env);
  runLifecycleHook('SessionEnd', capturePayload, env);
  const lifecycleDb = new Database(testDb, { readonly: true });
  const captured = lifecycleDb
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS messages,
        (SELECT COUNT(*) FROM loa_entries WHERE session_id = ?) AS extracts,
        (SELECT source FROM sessions WHERE session_id = ?) AS source
    `)
    .get(sessionId, sessionId, sessionId) as {
    messages: number;
    extracts: number;
    source: string;
  };
  lifecycleDb.close();
  if (captured.messages !== 2 || captured.extracts !== 1 || captured.source !== 'codex') {
    throw new Error(`Codex lifecycle capture mismatch: ${JSON.stringify(captured)}`);
  }
  console.log(`codex.automatic_rows=${captured.messages}`);
  console.log('codex.deduplication=true');
  console.log('codex.terminal_extraction=true');

  const client = new Client({ name: 'recall-codex-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'recall-mcp', env });
  await client.connect(transport);
  try {
    const expectedTools = [
      'context_for_agent',
      'decision_update',
      'loa_show',
      'memory_add',
      'memory_dump',
      'memory_hybrid_search',
      'memory_recall',
      'memory_search',
      'memory_stats',
    ];
    const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
    if (JSON.stringify(listed) !== JSON.stringify(expectedTools)) {
      throw new Error(`unexpected MCP tools: ${JSON.stringify(listed)}`);
    }

    const add = await client.callTool({
      name: 'memory_add',
      arguments: {
        type: 'decision',
        content: 'Package Recall on the native Codex plugin primitive',
        detail: 'MCP is the primary cross-host operation seam',
        project: 'Recall-e2e',
      },
    });
    if (add.isError) throw new Error(resultText(add));
    const decisionId = Number(resultText(add).match(/#(\d+)/)?.[1]);
    if (!decisionId) throw new Error(`decision ID missing: ${resultText(add)}`);

    const update = await client.callTool({
      name: 'decision_update',
      arguments: { id: decisionId, action: 'revert' },
    });
    if (update.isError) throw new Error(resultText(update));

    const dump = await client.callTool({
      name: 'memory_dump',
      arguments: {
        title: 'Codex portable dump e2e',
        project: 'Recall-e2e',
        session_id: 'codex-e2e-session',
        source: 'codex',
        skip_fabric: true,
        messages: [
          { role: 'user', content: 'Verify the native Codex plugin against an isolated database.' },
          {
            role: 'assistant',
            content:
              'The explicit MCP dump remains available while plugin hooks own automatic capture.',
          },
        ],
      },
    });
    if (dump.isError) throw new Error(resultText(dump));
    const loaId = Number(resultText(dump).match(/LoA Entry:\*\* #(\d+)/)?.[1]);
    if (!loaId) throw new Error(`LoA ID missing: ${resultText(dump)}`);

    const calls: Array<[string, Record<string, unknown>]> = [
      ['loa_show', { id: loaId }],
      ['memory_search', { query: 'native Codex plugin', project: 'Recall-e2e' }],
      ['memory_hybrid_search', { query: 'portable plugin memory', project: 'Recall-e2e' }],
      ['memory_recall', { project: 'Recall-e2e', limit: 10 }],
      ['memory_stats', {}],
      [
        'context_for_agent',
        { agent_task: 'continue Codex plugin verification', project: 'Recall-e2e' },
      ],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
    }
    console.log(`mcp.tools_verified=${expectedTools.length}`);
  } finally {
    await client.close();
  }

  runCodex(['plugin', 'remove', 'recall@recall-marketplace', '--json'], env);
  const afterRemoval = parseJson<{
    installed?: Array<{ pluginId?: string }>;
  }>(runCodex(['plugin', 'list', '--json'], env), 'codex plugin list after removal');
  if (afterRemoval.installed?.some(plugin => plugin.pluginId === 'recall@recall-marketplace')) {
    throw new Error(`Recall plugin still installed after removal: ${JSON.stringify(afterRemoval)}`);
  }
  const hooksAfterRemoval = (await listCodexHooks(env)).filter(
    hook => hook.command === 'recall host-hook codex'
  );
  if (hooksAfterRemoval.length) {
    throw new Error(
      `Recall lifecycle hooks survived plugin removal: ${JSON.stringify(hooksAfterRemoval)}`
    );
  }
  console.log('codex.plugin_cleanup=true');

  assertMetadataUnchanged(productionDb, productionBefore);
  console.log('isolation.production_db_unchanged=true');
  console.log('e2e.status=PASS');
}

try {
  await main();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
