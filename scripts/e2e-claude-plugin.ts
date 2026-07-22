#!/usr/bin/env bun

// End-to-end verification of the native Claude Code plugin against the local
// Claude CLI. Every mutation is confined to a disposable HOME and a disposable
// database; the production store is metadata-checked before and after.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { assertMetadataUnchanged, assertSafeTestDb, metadata, stringEnv } from './lib/e2e-isolation';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const productionClaudeHome = join(homedir(), '.claude');
const tempRoot = mkdtempSync(join(tmpdir(), 'recall-claude-plugin-e2e-'));
const testDb = join(tempRoot, 'recall-test.db');
const testRecallHome = join(tempRoot, 'recall-home');
const testHome = join(tempRoot, 'home');
const testClaudeHome = join(testHome, '.claude');
const testBin = join(tempRoot, 'bin');

function runClaude(args: string[], env: Record<string, string>): string {
  const result = spawnSync('claude', args, { cwd: repoRoot, env, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`claude ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Drive an install-lib.sh function against the sandboxed Claude/Recall homes. */
function runInstallLib(snippet: string, env: Record<string, string>): string {
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nsource "${join(repoRoot, 'lib', 'install-lib.sh')}"\n${snippet}`],
    { cwd: repoRoot, env, encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    throw new Error(`install-lib snippet failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

async function main(): Promise<void> {
  const productionBefore = metadata(productionDb);
  const productionClaudeBefore = metadata(join(productionClaudeHome, 'settings.json'));

  for (const dir of [testRecallHome, testHome, testClaudeHome, testBin]) mkdirSync(dir, { recursive: true });

  assertSafeTestDb(testDb, productionDb);
  if (testClaudeHome.startsWith(productionClaudeHome)) {
    throw new Error(`unsafe test Claude home: ${testClaudeHome}`);
  }

  const env = stringEnv({
    ...process.env,
    HOME: testHome,
    RECALL_HOME: testRecallHome,
    RECALL_DIR: join(testRecallHome, 'install-root'),
    CLAUDE_DIR: testClaudeHome,
    RECALL_DB_PATH: testDb,
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
    PATH: `${testBin}:${process.env.PATH || ''}`,
  });

  console.log(`isolation.test_db=${testDb}`);
  console.log(`isolation.production_db=${productionDb}`);
  console.log('isolation.production_db_opened=false');
  console.log(`isolation.test_claude_home=${testClaudeHome}`);
  console.log(`isolation.production_claude_home=${productionClaudeHome}`);
  console.log('isolation.production_claude_home_written=false');

  const init = spawnSync('bun', ['run', 'src/index.ts', 'init'], { cwd: repoRoot, env, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`test DB init failed\n${init.stdout}\n${init.stderr}`);
  if (!existsSync(testDb)) throw new Error('test DB was not created');

  writeFileSync(
    join(testBin, 'recall-mcp'),
    `#!/bin/sh\nexec bun ${JSON.stringify(join(repoRoot, 'dist', 'mcp-server.js'))} "$@"\n`,
    { mode: 0o755 },
  );

  // ── A legacy lifecycle install, exactly as today's users have it ───────────
  const installRoot = join(testRecallHome, 'install-root');
  const canonicalSkills = join(installRoot, 'shared', 'skills');
  const skillNames = ['recall-add', 'recall-doctor', 'recall-dump', 'recall-loa', 'recall-recent',
    'recall-scout', 'recall-search', 'recall-stats', 'recall-update'];
  // Seeded by the installer's own linker rather than hand-rolled symlinks, so the
  // migration is tested against whatever format recall_link actually produces and
  // this test cannot drift from production.
  runInstallLib('_recall_copy_skill_files\n_recall_link_skills_to "$CLAUDE_DIR/skills"', env);
  for (const name of skillNames) {
    const link = join(testClaudeHome, 'skills', name, 'SKILL.md');
    if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) {
      throw new Error(`legacy seed did not create a skill symlink for ${name}`);
    }
    if (!existsSync(join(canonicalSkills, name, 'SKILL.md'))) {
      throw new Error(`legacy seed did not create a canonical for ${name}`);
    }
  }
  // A user-authored skill that migration must never touch.
  mkdirSync(join(testClaudeHome, 'skills', 'user-owned'), { recursive: true });
  writeFileSync(join(testClaudeHome, 'skills', 'user-owned', 'SKILL.md'), '---\nname: user-owned\n---\nmine\n');
  // Shaped exactly as install-lib.sh writes it (`bun run <path>` plus an env block),
  // which is what makes it a genuine duplicate: Claude only collapses a user-scope
  // entry into the plugin's when the two resolve to the same command and env.
  const legacyMcpEntry = {
    command: 'bun',
    args: ['run', join(testBin, 'recall-mcp')],
    env: { RECALL_DB_PATH: join(installRoot, 'recall.db') },
  };
  writeFileSync(
    join(testHome, '.claude.json'),
    JSON.stringify({ mcpServers: { 'recall-memory': legacyMcpEntry } }, null, 2),
  );
  console.log(`legacy.skill_links=${skillNames.length}`);
  console.log('legacy.mcp_registered=true');

  // ── Install the plugin with the live CLI ──────────────────────────────────
  console.log(`claude.version=${runClaude(['--version'], env).trim()}`);
  runClaude(['plugin', 'validate', join(repoRoot, 'plugins', 'recall-claude'), '--strict'], env);
  runClaude(['plugin', 'validate', repoRoot, '--strict'], env);
  runClaude(['plugin', 'marketplace', 'add', repoRoot], env);
  runClaude(['plugin', 'install', 'recall@recall-marketplace'], env);

  const installedPlugins = readJson(join(testClaudeHome, 'plugins', 'installed_plugins.json'));
  if (!Array.isArray(installedPlugins.plugins?.['recall@recall-marketplace'])) {
    throw new Error(`Recall plugin not installed: ${JSON.stringify(installedPlugins)}`);
  }
  if (readJson(join(testClaudeHome, 'settings.json')).enabledPlugins?.['recall@recall-marketplace'] !== true) {
    throw new Error('Recall plugin not enabled after install');
  }

  const details = runClaude(['plugin', 'details', 'recall'], env);
  const skillCount = Number(details.match(/Skills \((\d+)\)/)?.[1]);
  if (skillCount !== 9) throw new Error(`expected 9 plugin skills, got ${skillCount}\n${details}`);
  if (!/MCP servers \(1\)\s+recall-memory/.test(details)) {
    throw new Error(`plugin did not contribute the recall-memory MCP server\n${details}`);
  }
  for (const name of skillNames) {
    if (!details.includes(name)) throw new Error(`plugin skill missing from inventory: ${name}`);
  }
  console.log('claude.plugin_installed=true');
  console.log(`claude.plugin_skills=${skillCount}`);
  console.log('claude.plugin_mcp_loaded=true');

  // Claude namespaces plugin components, so both servers load side by side until
  // migration reconciles them. This is the shadowing the lifecycle scripts clear:
  // nine tools exposed twice, from two processes.
  const mcpBefore = spawnSync('claude', ['mcp', 'list'], { cwd: repoRoot, env, encoding: 'utf-8' }).stdout;
  if (!mcpBefore.includes('plugin:recall:recall-memory')) {
    throw new Error(`plugin MCP server not namespaced as expected:\n${mcpBefore}`);
  }
  if (!/^recall-memory:/m.test(mcpBefore)) {
    throw new Error(`expected the legacy registration to duplicate the plugin's:\n${mcpBefore}`);
  }
  console.log('claude.duplicate_before_migration=true');

  // ── Migration: idempotent, and only Recall-owned artifacts ────────────────
  for (const pass of [1, 2]) {
    runInstallLib('recall_install_claude_skills\nrecall_configure_mcp', env);
    for (const name of skillNames) {
      if (existsSync(join(testClaudeHome, 'skills', name))) {
        throw new Error(`pass ${pass}: legacy skill link survived migration: ${name}`);
      }
    }
    if (!existsSync(join(testClaudeHome, 'skills', 'user-owned', 'SKILL.md'))) {
      throw new Error(`pass ${pass}: migration removed a user-authored skill`);
    }
    if (readJson(join(testHome, '.claude.json')).mcpServers?.['recall-memory']) {
      throw new Error(`pass ${pass}: duplicate recall-memory registration survived migration`);
    }
    if (!existsSync(join(canonicalSkills, 'recall-add', 'SKILL.md'))) {
      throw new Error(`pass ${pass}: canonical skills were removed`);
    }
  }
  console.log('migration.legacy_skill_links_removed=true');
  console.log('migration.duplicate_mcp_removed=true');
  console.log('migration.user_skill_preserved=true');
  console.log('migration.idempotent=true');

  const mcpAfter = spawnSync('claude', ['mcp', 'list'], { cwd: repoRoot, env, encoding: 'utf-8' }).stdout;
  if (/^recall-memory:/m.test(mcpAfter)) throw new Error(`legacy MCP server still registered:\n${mcpAfter}`);
  if (!mcpAfter.includes('plugin:recall:recall-memory')) {
    throw new Error(`plugin MCP server missing after migration:\n${mcpAfter}`);
  }
  console.log('migration.single_mcp_server=true');

  // A user running Recall against a non-default database must keep their
  // registration: the plugin's bundled .mcp.json carries no env block, so removing
  // the pinned entry would silently repoint memory at the default file and their
  // history would read as empty.
  const customDb = join(tempRoot, 'custom.db');
  writeFileSync(
    join(testHome, '.claude.json'),
    JSON.stringify({ mcpServers: { 'recall-memory': { ...legacyMcpEntry, env: { RECALL_DB_PATH: customDb } } } }, null, 2),
  );
  runInstallLib('recall_configure_mcp || true', { ...env, RECALL_DB_PATH: customDb });
  const preserved = readJson(join(testHome, '.claude.json')).mcpServers?.['recall-memory'];
  if (preserved?.env?.RECALL_DB_PATH !== customDb) {
    throw new Error(`migration repointed a custom database registration: ${JSON.stringify(preserved)}`);
  }
  console.log('migration.custom_db_registration_preserved=true');

  // ── All nine MCP tools against the disposable database ────────────────────
  const client = new Client({ name: 'recall-claude-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'recall-mcp', env });
  await client.connect(transport);
  try {
    const expectedTools = [
      'context_for_agent', 'decision_update', 'loa_show', 'memory_add', 'memory_dump',
      'memory_hybrid_search', 'memory_recall', 'memory_search', 'memory_stats',
    ];
    const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
    if (JSON.stringify(listed) !== JSON.stringify(expectedTools)) {
      throw new Error(`unexpected MCP tools: ${JSON.stringify(listed)}`);
    }

    const add = await client.callTool({
      name: 'memory_add',
      arguments: {
        type: 'decision',
        content: 'Package Recall on the native Claude Code plugin primitive',
        detail: 'Skills and MCP ship in the bundle; lifecycle hooks stay installer-owned',
        project: 'Recall-e2e',
      },
    });
    if (add.isError) throw new Error(resultText(add));
    const decisionId = Number(resultText(add).match(/#(\d+)/)?.[1]);
    if (!decisionId) throw new Error(`decision ID missing: ${resultText(add)}`);

    const update = await client.callTool({ name: 'decision_update', arguments: { id: decisionId, action: 'revert' } });
    if (update.isError) throw new Error(resultText(update));

    const dump = await client.callTool({
      name: 'memory_dump',
      arguments: {
        title: 'Claude plugin dump e2e',
        project: 'Recall-e2e',
        session_id: 'claude-e2e-session',
        source: 'claude',
        skip_fabric: true,
        messages: [
          { role: 'user', content: 'Verify the native Claude plugin against an isolated database.' },
          { role: 'assistant', content: 'Skills and MCP load from the bundle; the legacy duplicates are reconciled away.' },
        ],
      },
    });
    if (dump.isError) throw new Error(resultText(dump));
    const loaId = Number(resultText(dump).match(/LoA Entry:\*\* #(\d+)/)?.[1]);
    if (!loaId) throw new Error(`LoA ID missing: ${resultText(dump)}`);

    const calls: Array<[string, Record<string, unknown>]> = [
      ['loa_show', { id: loaId }],
      ['memory_search', { query: 'native Claude plugin', project: 'Recall-e2e' }],
      ['memory_hybrid_search', { query: 'plugin packaged memory', project: 'Recall-e2e' }],
      ['memory_recall', { project: 'Recall-e2e', limit: 10 }],
      ['memory_stats', {}],
      ['context_for_agent', { agent_task: 'continue Claude plugin verification', project: 'Recall-e2e' }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
    }
    console.log(`mcp.tools_verified=${expectedTools.length}`);
  } finally {
    await client.close();
  }

  assertMetadataUnchanged(productionDb, productionBefore);
  const productionClaudeAfter = metadata(join(productionClaudeHome, 'settings.json'));
  if (JSON.stringify(productionClaudeAfter) !== JSON.stringify(productionClaudeBefore)) {
    throw new Error(`production Claude settings changed: before=${JSON.stringify(productionClaudeBefore)} after=${JSON.stringify(productionClaudeAfter)}`);
  }
  console.log('isolation.production_db_unchanged=true');
  console.log('isolation.production_claude_home_unchanged=true');
  console.log('e2e.status=PASS');
}

try {
  await main();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
