#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
const hookPayloadLog = join(tempRoot, 'codex-hook-payloads.jsonl');

function runCodex(args: string[], env: Record<string, string>): string {
  const result = spawnSync('codex', args, { cwd: repoRoot, env, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      `codex ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function runCodexAsync(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 120_000
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`codex ${args.join(' ')} timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`codex ${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

interface CodexHookMetadata {
  eventName?: string;
  command?: string | null;
  enabled?: boolean;
  source?: string;
}

interface AppServerMessage {
  id?: number;
  result?: any;
  error?: { message?: string };
}

interface CodexAppServer {
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): void;
}

async function startCodexAppServer(env: Record<string, string>): Promise<CodexAppServer> {
  const child = spawn('codex', ['--dangerously-bypass-hook-trust', 'app-server'], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let stdout = '';
  let stderr = '';
  let closed = false;

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
      let message: AppServerMessage;
      try {
        message = JSON.parse(line) as AppServerMessage;
      } catch {
        continue;
      }
      if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.error) request.reject(new Error(message.error.message ?? 'app-server error'));
        else request.resolve(message.result);
      }
    }
  });

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', code => {
    if (!closed) rejectPending(new Error(`codex app-server exited ${code}\n${stderr}`));
  });

  const request = <T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<T> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex ${method} timed out\n${stdout}\n${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  };

  const appServer: CodexAppServer = {
    request,
    close() {
      closed = true;
      child.kill();
      rejectPending(new Error('codex app-server closed'));
    },
  };

  await request('initialize', {
    clientInfo: { name: 'recall-e2e', title: 'Recall E2E', version: '1' },
    capabilities: {},
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  return appServer;
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

function startMockResponsesProvider(): {
  requests: Record<string, unknown>[];
  baseUrl: string;
  stop(): void;
} {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'recall-e2e-model', object: 'model' }],
        });
      }
      if (!url.pathname.endsWith('/responses')) return new Response('not found', { status: 404 });

      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const ordinal = requests.length;
      const responseId = `resp-recall-${ordinal}`;
      const message = {
        type: 'message',
        id: `msg-recall-${ordinal}`,
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: `Recall E2E response ${ordinal}.`,
            annotations: [],
          },
        ],
      };
      const usage = {
        input_tokens: ordinal === 1 ? 30_000 : 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: ordinal === 1 ? 30_001 : 2,
      };
      const events = [
        { type: 'response.created', response: { id: responseId } },
        { type: 'response.output_item.done', output_index: 0, item: message },
        {
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            model: body.model ?? 'recall-e2e-model',
            output: [message],
            usage,
          },
        },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  };
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
    RECALL_CODEX_E2E_KEY: 'test-only-key',
    RECALL_E2E_HOOK_LOG: hookPayloadLog,
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
    `#!/bin/sh
payload="$(cat)"
printf '%s\\n' "$payload" >> "$RECALL_E2E_HOOK_LOG"
printf '%s' "$payload" | bun ${JSON.stringify(join(repoRoot, 'dist', 'index.js'))} "$@"
`,
    { mode: 0o755 }
  );

  const provider = startMockResponsesProvider();
  let activeAppServer: CodexAppServer | undefined;
  let sessionId = '';
  try {
    writeFileSync(
      join(testCodexHome, 'config.toml'),
      `model = "recall-e2e-model"
model_provider = "recall_e2e"
model_context_window = 32768
model_auto_compact_token_limit = 10000
model_reasoning_effort = "low"
model_reasoning_summary = "none"

[model_providers.recall_e2e]
name = "Recall E2E Stub"
base_url = ${JSON.stringify(provider.baseUrl)}
env_key = "RECALL_CODEX_E2E_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`
    );

    console.log(`codex.version=${runCodex(['--version'], env).trim()}`);
    runCodex(['plugin', 'marketplace', 'add', repoRoot], env);
    const catalog = parseJson<{
      available?: Array<{ name?: string; marketplaceName?: string }>;
    }>(
      runCodex(['plugin', 'list', '--available', '--json'], env),
      'codex plugin list --available'
    );
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

    activeAppServer = await startCodexAppServer(env);
    const hooksResponse = await activeAppServer.request<{
      data?: Array<{ hooks?: CodexHookMetadata[] }>;
    }>('hooks/list', { cwds: [repoRoot] });
    const lifecycleHooks = (hooksResponse.data ?? [])
      .flatMap(entry => entry.hooks ?? [])
      .filter(
        hook =>
          hook.command === 'recall host-hook codex' &&
          hook.source === 'plugin' &&
          hook.enabled
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

    activeAppServer.close();
    activeAppServer = undefined;

    const firstPrompt = 'Complete the first Recall lifecycle E2E turn.';
    const secondPrompt = 'Complete the post-compaction Recall lifecycle E2E turn.';
    await runCodexAsync(
      [
        '--dangerously-bypass-hook-trust',
        '--ask-for-approval',
        'never',
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--cd',
        repoRoot,
        firstPrompt,
      ],
      env
    );
    const initialPayloads = readFileSync(hookPayloadLog, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => parseJson<Record<string, any>>(line, 'Codex hook payload'));
    sessionId = initialPayloads.find(payload => payload.hook_event_name === 'SessionStart')
      ?.session_id;
    if (!sessionId) {
      throw new Error(`Codex exec did not dispatch SessionStart: ${JSON.stringify(initialPayloads)}`);
    }

    await runCodexAsync(
      [
        '--dangerously-bypass-hook-trust',
        '--ask-for-approval',
        'never',
        'exec',
        'resume',
        '--json',
        sessionId,
        secondPrompt,
      ],
      env
    );
    runCodex(['--dangerously-bypass-hook-trust', 'archive', sessionId], env);

    const requestForPrompt = (prompt: string) =>
      provider.requests.find(request => JSON.stringify(request).includes(prompt));
    const contextMarker = '## Recall — Session Memory (tiered)';
    const firstRequest = requestForPrompt(firstPrompt);
    const secondRequest = requestForPrompt(secondPrompt);
    if (!firstRequest || !JSON.stringify(firstRequest).includes(contextMarker)) {
      throw new Error('Codex did not consume SessionStart additionalContext on the first turn');
    }
    if (!secondRequest || !JSON.stringify(secondRequest).includes(contextMarker)) {
      throw new Error('Codex did not restore SessionStart additionalContext after compaction');
    }

    const hookPayloads = readFileSync(hookPayloadLog, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => parseJson<Record<string, any>>(line, 'Codex hook payload'));
    const eventPayload = (eventName: string) =>
      hookPayloads.find(payload => payload.hook_event_name === eventName);
    for (const eventName of ['Stop', 'PreCompact', 'PostCompact', 'SessionEnd']) {
      const payload = eventPayload(eventName);
      if (
        payload?.session_id !== sessionId ||
        typeof payload.transcript_path !== 'string' ||
        !payload.transcript_path
      ) {
        throw new Error(`Codex ${eventName} omitted its transcript payload: ${JSON.stringify(payload)}`);
      }
    }
    if (
      eventPayload('PreCompact')?.trigger !== 'auto' ||
      eventPayload('PostCompact')?.trigger !== 'auto'
    ) {
      throw new Error(`Codex automatic compaction payload mismatch: ${JSON.stringify(hookPayloads)}`);
    }
    if (
      !hookPayloads.some(
        payload => payload.hook_event_name === 'SessionStart' && payload.source === 'compact'
      )
    ) {
      throw new Error(`Codex did not dispatch SessionStart after compaction: ${JSON.stringify(hookPayloads)}`);
    }
    console.log('codex.session_start_injection=true');
    console.log('codex.compaction_dispatch=true');

    const lifecycleDb = new Database(testDb, { readonly: true });
    const captured = lifecycleDb
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM published_messages WHERE session_id = ?) AS messages,
          (SELECT COUNT(*) FROM loa_entries WHERE session_id = ?) AS extracts,
          (SELECT source FROM sessions WHERE session_id = ?) AS source,
          (SELECT COUNT(*) FROM published_messages WHERE session_id = ? AND content = ?) AS first_prompt,
          (SELECT COUNT(*) FROM published_messages WHERE session_id = ? AND content = ?) AS second_prompt,
          (SELECT COUNT(*) FROM published_messages
             WHERE session_id = ? AND (
               content LIKE '# AGENTS.md instructions%'
               OR content LIKE '<recommended_plugins>%'
               OR content LIKE '<environment_context>%'
               OR content LIKE '<user_instructions>%'
             )) AS injected_instructions
      `)
      .get(
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        firstPrompt,
        sessionId,
        secondPrompt,
        sessionId
      ) as {
      messages: number;
      extracts: number;
      source: string;
      first_prompt: number;
      second_prompt: number;
      injected_instructions: number;
    };
    lifecycleDb.close();
    if (
      captured.messages < 4 ||
      captured.extracts !== 1 ||
      captured.source !== 'codex' ||
      captured.first_prompt !== 1 ||
      captured.second_prompt !== 1 ||
      captured.injected_instructions !== 0
    ) {
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

      const explicitUser = 'Verify the native Codex plugin against an isolated database.';
      const explicitAssistant =
        'The explicit MCP dump remains available while plugin hooks own automatic capture.';
      const dumpArguments = {
        title: 'Codex portable dump e2e',
        project: 'Recall-e2e',
        session_id: sessionId,
        source: 'codex',
        skip_fabric: true,
        messages: [
          { role: 'user', content: explicitUser },
          {
            role: 'assistant',
            content: explicitAssistant,
          },
        ],
      };
      const firstDump = await client.callTool({ name: 'memory_dump', arguments: dumpArguments });
      if (firstDump.isError) throw new Error(resultText(firstDump));
      const dump = await client.callTool({ name: 'memory_dump', arguments: dumpArguments });
      if (dump.isError) throw new Error(resultText(dump));
      const loaId = Number(resultText(dump).match(/LoA Entry:\*\* #(\d+)/)?.[1]);
      if (!loaId) throw new Error(`LoA ID missing: ${resultText(dump)}`);

      const preservationDb = new Database(testDb, { readonly: true });
      const preserved = preservationDb
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM published_messages WHERE session_id = ? AND content = ?) AS first_prompt,
            (SELECT COUNT(*) FROM published_messages WHERE session_id = ? AND content = ?) AS second_prompt,
            (SELECT COUNT(*) FROM published_messages WHERE session_id = ? AND content = ?) AS explicit_user,
            (SELECT COUNT(*) FROM published_messages WHERE session_id = ? AND content = ?) AS explicit_assistant,
            (SELECT COUNT(*) FROM loa_entries
             WHERE session_id = ? AND tags LIKE 'automatic-capture,%') AS automatic_extracts,
            (SELECT COUNT(*) FROM published_messages
             WHERE session_id = ? AND (
               content LIKE '# AGENTS.md instructions%'
               OR content LIKE '<recommended_plugins>%'
               OR content LIKE '<environment_context>%'
               OR content LIKE '<user_instructions>%'
             )) AS injected_instructions,
            (SELECT message_count FROM loa_entries
             WHERE session_id = ? AND description = 'Explicit memory dump.') AS explicit_message_count
        `)
        .get(
          sessionId,
          firstPrompt,
          sessionId,
          secondPrompt,
          sessionId,
          explicitUser,
          sessionId,
          explicitAssistant,
          sessionId,
          sessionId,
          sessionId
        ) as {
          first_prompt: number;
          second_prompt: number;
          explicit_user: number;
          explicit_assistant: number;
          automatic_extracts: number;
          injected_instructions: number;
          explicit_message_count: number;
        };
      preservationDb.close();
      if (
        preserved.first_prompt !== 1 ||
        preserved.second_prompt !== 1 ||
        preserved.explicit_user !== 1 ||
        preserved.explicit_assistant !== 1 ||
        preserved.automatic_extracts !== 1 ||
        preserved.injected_instructions !== 0 ||
        preserved.explicit_message_count !== 2
      ) {
        throw new Error(`Explicit MCP dump replaced lifecycle capture: ${JSON.stringify(preserved)}`);
      }

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
      console.log('mcp.repeat_dump=true');
      console.log('mcp.lifecycle_capture_preserved=true');
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

    const cleanupServer = await startCodexAppServer(env);
    try {
      const cleanupHooks = await cleanupServer.request<{
        data?: Array<{ hooks?: CodexHookMetadata[] }>;
      }>('hooks/list', { cwds: [repoRoot] });
      const hooksAfterRemoval = (cleanupHooks.data ?? [])
        .flatMap(entry => entry.hooks ?? [])
        .filter(hook => hook.command === 'recall host-hook codex');
      if (hooksAfterRemoval.length) {
        throw new Error(
          `Recall lifecycle hooks survived plugin removal: ${JSON.stringify(hooksAfterRemoval)}`
        );
      }
    } finally {
      cleanupServer.close();
    }
    console.log('codex.plugin_cleanup=true');

    assertMetadataUnchanged(productionDb, productionBefore);
    console.log('isolation.production_db_unchanged=true');
    console.log('e2e.status=PASS');
  } finally {
    activeAppServer?.close();
    provider.stop();
  }
}

try {
  await main();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
