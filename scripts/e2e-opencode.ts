#!/usr/bin/env bun

/**
 * Isolated OpenCode Phase 4 integration test.
 *
 * The test provisions the pinned OpenCode CLI through bunx, imports a real
 * OpenCode session into disposable XDG directories, exercises Recall's native
 * event adapter, then runs the batch extractor and searches the same WAL DB.
 * No host Recall directory, OpenCode config, or production database is used.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertMetadataUnchanged, assertSafeTestDb, metadata, stringEnv } from './lib/e2e-isolation';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const tempRoot = mkdtempSync(join(tmpdir(), 'recall-opencode-e2e-'));
const testHome = join(tempRoot, 'home');
const testRecallHome = join(tempRoot, 'recall-home');
const testDb = join(tempRoot, 'recall.db');
const testBin = join(tempRoot, 'bin');
const xdgConfig = join(tempRoot, 'xdg-config');
const xdgData = join(tempRoot, 'xdg-data');
const xdgState = join(tempRoot, 'xdg-state');
const xdgCache = join(tempRoot, 'xdg-cache');
const opencodeConfigDir = join(xdgConfig, 'opencode');
const opencodeFixture = join(tempRoot, 'session.json');
const sessionId = 'ses_recall_phase4';
const retrySessionId = 'ses_recall_phase4_retry';
const marker = 'OPENCODE_PHASE4_SEARCHABLE_MARKER';
const concurrentMarkers = ['OPENCODEPHASE4CONCURRENTA', 'OPENCODEPHASE4CONCURRENTB'];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[], env: Record<string, string>, timeout = 180_000): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${output}`);
  }
  return output;
}

function openCodeArgs(args: string[]): { command: string; args: string[] } {
  if (process.env.OPENCODE_BIN) return { command: process.env.OPENCODE_BIN, args };
  return { command: 'bunx', args: ['--yes', '--package', 'opencode-ai@1.18.4', 'opencode', ...args] };
}

function runOpenCode(args: string[], env: Record<string, string>): string {
  const command = openCodeArgs(args);
  const result = spawnSync(command.command, command.args, {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command.command} ${command.args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

function runOpenCodeCombined(args: string[], env: Record<string, string>): string {
  const command = openCodeArgs(args);
  return run(command.command, command.args, env, 180_000);
}

function writeFakeClaude(): void {
  writeFileSync(
    join(testBin, 'claude'),
    `#!/usr/bin/env bun
const input = await new Response(Bun.stdin).text();
const match = input.match(/(?:MARKER:|OPENCODE_PHASE4_)[A-Z0-9_-]+/);
const marker = match?.[0] ?? 'OPENCODE_PHASE4_DEFAULT';
console.log('## ONE SENTENCE SUMMARY');
console.log('Recall validated isolated OpenCode extraction for ' + marker + '.');
console.log('## MAIN IDEAS');
console.log('- The native OpenCode event adapter exported the complete session.');
console.log('- The batch extractor wrote a searchable SQLite memory record.');
console.log('- Concurrent host writers shared the WAL database without record loss.');
console.log('## DECISIONS MADE');
console.log('- Failed exports remain retryable and are never marked complete.');
console.log('## SESSION CONTEXT');
console.log('This fixture proves the OpenCode Phase 4 contract end to end in a disposable environment.');
`,
    { mode: 0o755 },
  );
}

function baseMessage(session: string, message: string, created: number): { info: Record<string, unknown>; parts: Record<string, unknown>[] } {
  const messageId = `msg_${session}`;
  return {
    info: {
      id: messageId,
      sessionID: session,
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
      parentID: null,
    },
    parts: [{
      id: `prt_${session}`,
      sessionID: session,
      messageID: messageId,
      type: 'text',
      text: message,
    }],
  };
}

function writeOpenCodeImportFixture(id: string, uniqueMarker: string): void {
  const now = Date.now();
  const longText = [
    `MARKER:${uniqueMarker}`,
    'Verify Recall native OpenCode session export, markdown normalization, batch extraction, quality tracking, and SQLite full-text search.',
    'This deliberately long transcript gives the extraction quality gate enough context to operate while retaining a stable searchable phrase.',
    'The test also checks that a failed export is retried and that concurrent Claude and OpenCode writers do not lose records or corrupt the WAL database.',
  ].join('\n\n') + `\n${'OpenCode Phase 4 evidence. '.repeat(110)}`;
  writeFileSync(opencodeFixture.replace('session.json', `${id}.json`), JSON.stringify({
    info: {
      id,
      slug: id,
      projectID: 'proj_recall_phase4',
      directory: repoRoot,
      title: `Recall Phase 4 ${id}`,
      version: '1.18.4',
      time: { created: now, updated: now },
    },
    messages: [baseMessage(id, longText, now)],
  }, null, 2));
}

function spawnExtraction(markdownPath: string): Promise<{ status: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn('bun', ['run', join(testRecallHome, 'shared', 'hooks', 'RecallExtract.ts'), '--reextract-md', markdownPath, 'opencode'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('close', status => resolve({ status, output }));
  });
}

let env: Record<string, string>;

async function main(): Promise<void> {
  const productionBefore = metadata(productionDb);
  assertSafeTestDb(testDb, productionDb);

  for (const path of [testHome, testRecallHome, testBin, xdgConfig, xdgData, xdgState, xdgCache]) {
    mkdirSync(path, { recursive: true });
  }
  writeFakeClaude();

  env = stringEnv({
    ...process.env,
    HOME: testHome,
    RECALL_HOME: testRecallHome,
    RECALL_DIR: testRecallHome,
    RECALL_REPO_DIR: repoRoot,
    RECALL_DB_PATH: testDb,
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
    OPENCODE_CONFIG_DIR: opencodeConfigDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    npm_config_cache: join(tempRoot, 'npm-cache'),
    PATH: `${testBin}:${process.env.PATH || ''}`,
  });

  console.log(`isolation.recall_home=${testRecallHome}`);
  console.log(`isolation.opencode_config=${opencodeConfigDir}`);
  console.log(`isolation.test_db=${testDb}`);
  console.log(`isolation.production_db=${productionDb}`);
  console.log(`isolation.production_before=${JSON.stringify(productionBefore)}`);
  console.log('isolation.production_db_opened=false');

  const version = runOpenCode(['--version'], env).trim();
  assert(version === '1.18.4', `unexpected OpenCode version: ${version}`);
  const paths = runOpenCodeCombined(['debug', 'paths'], env);
  for (const expected of [xdgConfig, xdgData, xdgState, xdgCache]) {
    assert(paths.includes(expected), `OpenCode path was not isolated under ${expected}\n${paths}`);
  }
  assert(runOpenCodeCombined(['export', '--help'], env).includes('export session data as JSON'), 'OpenCode JSON export help was not observed');

  run('bun', ['run', 'src/index.ts', 'init'], env);
  cpSync(join(repoRoot, 'hooks'), join(testRecallHome, 'shared', 'hooks'), { recursive: true });

  const userConfig = `{
  // User-owned OpenCode settings remain intact.
  "mcp": {
    "other-server": { "type": "remote", "url": "https://example.test/mcp", },
  },
}
`;
  writeFileSync(join(opencodeConfigDir, 'opencode.json'), userConfig);
  run('bash', ['-c', 'source "$1"; recall_install_opencode_platform', '_', join(repoRoot, 'lib', 'install-lib.sh')], env);
  run('bash', ['-c', 'source "$1"; recall_install_opencode_platform', '_', join(repoRoot, 'lib', 'install-lib.sh')], env);
  const installedConfig = readFileSync(join(opencodeConfigDir, 'opencode.json'), 'utf-8');
  assert(installedConfig.includes('// User-owned OpenCode settings remain intact.'), 'installer removed a user comment');
  assert(installedConfig.includes('other-server') && installedConfig.includes('recall-memory'), 'installer did not preserve or add MCP entries');

  writeOpenCodeImportFixture(sessionId, marker);
  writeOpenCodeImportFixture(retrySessionId, `${marker}_RETRY`);
  runOpenCode(['import', opencodeFixture.replace('session.json', `${sessionId}.json`)], env);
  runOpenCode(['import', opencodeFixture.replace('session.json', `${retrySessionId}.json`)], env);
  assert(runOpenCode(['export', sessionId], env).includes(marker), 'real OpenCode export did not contain the source marker');

  Object.assign(process.env, env);
  const pluginModule = await import(join(repoRoot, 'opencode', 'RecallExtract.ts'));
  const plugin = await pluginModule.RecallExtract({
    $: async (_strings: TemplateStringsArray, ...values: unknown[]) => runOpenCode(['export', String(values[0])], env),
  } as never);
  await plugin.event?.({ event: { type: 'session.idle', properties: { sessionID: sessionId } } });

  const dropDir = join(testRecallHome, 'MEMORY', 'opencode-sessions');
  const firstDrop = join(dropDir, `${sessionId}.md`);
  assert(existsSync(firstDrop), 'session.idle did not create the markdown drop');
  assert(readFileSync(firstDrop, 'utf-8').includes(marker), 'markdown drop lost the source marker');

  let failed = true;
  const retryPlugin = await pluginModule.RecallExtract({
    $: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (failed) {
        failed = false;
        throw new Error('synthetic export failure');
      }
      return runOpenCode(['export', String(values[0])], env);
    },
  } as never);
  await retryPlugin.event?.({ event: { type: 'session.idle', properties: { sessionID: retrySessionId } } });
  assert(!existsSync(join(dropDir, `${retrySessionId}.md`)), 'failed export was incorrectly treated as success');
  await retryPlugin.event?.({ event: { type: 'session.idle', properties: { sessionID: retrySessionId } } });
  assert(existsSync(join(dropDir, `${retrySessionId}.md`)), 'failed export did not succeed on retry');

  const concurrentPaths = concurrentMarkers.map((uniqueMarker, index) => {
    const path = join(dropDir, `concurrent-${index}.md`);
    writeFileSync(path, `# Concurrent OpenCode session\n\nMARKER:${uniqueMarker}\n\n${'Shared WAL writer evidence. '.repeat(120)}\n`);
    return path;
  });
  const concurrent = await Promise.all(concurrentPaths.map(spawnExtraction));
  for (const [index, result] of concurrent.entries()) {
    assert(result.status === 0, `concurrent extraction ${index} exited ${result.status}\n${result.output}`);
    assert(result.output.includes('successful') && !result.output.includes('QUALITY GATE FAILED') && !result.output.includes('All extraction methods failed'), `concurrent extraction ${index} did not pass its quality gate\n${result.output}`);
  }

  const batch = run('bun', ['run', join(testRecallHome, 'shared', 'hooks', 'RecallBatchExtract.ts'), '--all'], env, 240_000);
  assert(batch.includes('SUCCESS: Extracted and tracked'), `batch extraction did not track its records\n${batch}`);
  for (const query of [marker, `${marker}_RETRY`, ...concurrentMarkers]) {
    const search = run('bun', ['run', 'src/index.ts', 'search', query], env);
    assert(search.includes('Found ') && !search.includes('No results found.'), `Recall search could not find ${query}\n${search}`);
  }

  const uninstall = spawnSync('bash', [join(repoRoot, 'uninstall.sh'), '--no-confirm', '--skip-pi', '--skip-omp'], {
    cwd: repoRoot,
    env: { ...env, CLAUDE_DIR: join(testHome, '.claude'), BACKUP_BASE: join(tempRoot, 'backups'), RECALL_SKIP_BUN_UNLINK: 'true' },
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert(uninstall.status === 0, `isolated uninstall failed\n${uninstall.stdout}\n${uninstall.stderr}`);
  const afterUninstall = readFileSync(join(opencodeConfigDir, 'opencode.json'), 'utf-8');
  assert(afterUninstall.includes('// User-owned OpenCode settings remain intact.'), 'uninstall removed user JSONC comments');
  assert(afterUninstall.includes('other-server') && !afterUninstall.includes('recall-memory'), 'uninstall did not surgically remove Recall MCP');

  assertMetadataUnchanged(productionDb, productionBefore);
  console.log(`opencode.version=${version}`);
  console.log(`opencode.search_markers=${[marker, `${marker}_RETRY`, ...concurrentMarkers].join(',')}`);
  console.log('opencode.export_failure_retry=verified');
  console.log('opencode.concurrent_wal_writers=verified');
  console.log('opencode.installer_jsonc_rollback=verified');
  console.log('isolation.production_db_opened=false');
} 

try {
  await main();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
