#!/usr/bin/env bun

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const tempRoot = mkdtempSync(join(tmpdir(), 'recall-codex-plugin-e2e-'));
const testDb = join(tempRoot, 'recall-test.db');
const testRecallHome = join(tempRoot, 'recall-home');
const testCodexHome = join(tempRoot, 'codex-home');
const testHome = join(tempRoot, 'home');
const testBin = join(tempRoot, 'bin');

interface FileMetadata {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  ino?: number;
}

function metadata(path: string): FileMetadata {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function runCodex(args: string[], env: Record<string, string>): string {
  const result = spawnSync('codex', args, { cwd: repoRoot, env, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`codex ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

async function main(): Promise<void> {
  const productionBefore = metadata(productionDb);
  mkdirSync(testRecallHome, { recursive: true });
  mkdirSync(testCodexHome, { recursive: true });
  mkdirSync(testHome, { recursive: true });
  mkdirSync(testBin, { recursive: true });

  if (testDb === productionDb || testDb.startsWith(dirname(productionDb) + '/')) {
    throw new Error(`unsafe test database path: ${testDb}`);
  }

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

  const init = spawnSync('bun', ['run', 'src/index.ts', 'init'], { cwd: repoRoot, env, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`test DB init failed\n${init.stdout}\n${init.stderr}`);
  if (!existsSync(testDb)) throw new Error('test DB was not created');

  writeFileSync(
    join(testBin, 'recall-mcp'),
    `#!/bin/sh\nexec bun ${JSON.stringify(join(repoRoot, 'dist', 'mcp-server.js'))} "$@"\n`,
    { mode: 0o755 },
  );

  console.log(`codex.version=${runCodex(['--version'], env).trim()}`);
  runCodex(['plugin', 'marketplace', 'add', repoRoot], env);
  const catalog = JSON.parse(runCodex(['plugin', 'list', '--available', '--json'], env)) as {
    available?: Array<{ name?: string; marketplaceName?: string }>;
  };
  if (!catalog.available?.some(plugin => plugin.name === 'recall' && plugin.marketplaceName === 'recall-marketplace')) {
    throw new Error(`Recall plugin not listed by Codex: ${JSON.stringify(catalog)}`);
  }
  runCodex(['plugin', 'add', 'recall@recall-marketplace', '--json'], env);
  const installed = JSON.parse(runCodex(['plugin', 'list', '--json'], env)) as {
    installed?: Array<{ pluginId?: string; enabled?: boolean }>;
  };
  if (!installed.installed?.some(plugin => plugin.pluginId === 'recall@recall-marketplace' && plugin.enabled)) {
    throw new Error(`Recall plugin not installed and enabled by Codex: ${JSON.stringify(installed)}`);
  }
  const configuredMcp = JSON.parse(runCodex(['mcp', 'list', '--json'], env)) as Array<{
    name?: string;
    enabled?: boolean;
    transport?: { type?: string; command?: string };
  }>;
  if (!configuredMcp.some(server =>
    server.name === 'recall-memory'
    && server.enabled
    && server.transport?.type === 'stdio'
    && server.transport.command === 'recall-mcp'
  )) {
    throw new Error(`Recall MCP registration not loaded from the installed plugin: ${JSON.stringify(configuredMcp)}`);
  }
  console.log('codex.plugin_installed=true');
  console.log('codex.plugin_mcp_loaded=true');

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
          { role: 'assistant', content: 'The MCP dump receives explicit visible messages; lifecycle auto-capture remains separate.' },
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
      ['context_for_agent', { agent_task: 'continue Codex plugin verification', project: 'Recall-e2e' }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
    }
    console.log(`mcp.tools_verified=${expectedTools.length}`);
  } finally {
    await client.close();
  }

  const productionAfter = metadata(productionDb);
  if (JSON.stringify(productionAfter) !== JSON.stringify(productionBefore)) {
    throw new Error(`production DB metadata changed: before=${JSON.stringify(productionBefore)} after=${JSON.stringify(productionAfter)}`);
  }
  console.log('isolation.production_db_unchanged=true');
  console.log('e2e.status=PASS');
}

try {
  await main();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
