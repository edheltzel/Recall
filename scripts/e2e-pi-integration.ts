#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { assertMetadataUnchanged, assertSafeTestDb, metadata, stringEnv } from './lib/e2e-isolation';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const tempRoot = mkdtempSync(join(tmpdir(), 'recall-pi-integration-e2e-'));
const testHome = join(tempRoot, 'home');
const testPiHome = join(tempRoot, 'pi-agent');
const testRecallHome = join(tempRoot, 'recall-home');
const testDb = join(tempRoot, 'recall-test.db');
const testBin = join(tempRoot, 'bin');
const probeOutput = join(tempRoot, 'pi-tools.json');

const mcpTools = [
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

function run(command: string, args: string[], env: Record<string, string>, input?: string, timeout = 60_000): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    input,
    timeout,
    detached: command === 'pi',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  if (process.env.RECALL_E2E_DEBUG === '1' && result.stderr.trim()) {
    console.error(`${command} stderr:\n${result.stderr}`);
  }
  return result.stdout;
}

async function runPiRpcUntil(
  args: string[],
  env: Record<string, string>,
  input: string,
  ready: (stdout: string) => boolean,
): Promise<string> {
  const child = spawn('pi', args, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });

  child.stdin.write(input);
  const deadline = Date.now() + 30_000;
  while (!ready(stdout)) {
    if (exited) {
      throw new Error(`pi ${args.join(' ')} exited before readiness (${exited.code}, ${exited.signal})\n${stdout}\n${stderr}`);
    }
    if (Date.now() >= deadline) {
      child.kill('SIGTERM');
      await exitPromise;
      throw new Error(`pi ${args.join(' ')} timed out waiting for readiness\n${stdout}\n${stderr}`);
    }
    await Bun.sleep(100);
  }

  child.stdin.end();
  const result = await exitPromise;
  if (result.code !== 0) {
    throw new Error(`pi ${args.join(' ')} failed (${result.code}, ${result.signal})\n${stdout}\n${stderr}`);
  }
  if (process.env.RECALL_E2E_DEBUG === '1' && stderr.trim()) {
    console.error(`pi stderr:\n${stderr}`);
  }
  return stdout;
}

function cachedRecallToolCount(): number {
  const cachePath = join(testPiHome, 'mcp-cache.json');
  if (!existsSync(cachePath)) return 0;
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    return cache.servers?.['recall-memory']?.tools?.length ?? 0;
  } catch {
    return 0;
  }
}

function installPiSurfaces(env: Record<string, string>): void {
  run(
    'bash',
    ['-c', 'source "$1"; recall_create_install_root; recall_install_pi_platform', '_', join(repoRoot, 'lib', 'install-lib.sh')],
    env,
    undefined,
    180_000,
  );
}

function writeSyntheticSession(path: string): void {
  const timestamp = '2026-07-22T12:00:00.000Z';
  const entries = [
    { type: 'session', version: 3, id: 'recall-pi-e2e', timestamp, cwd: repoRoot },
    {
      type: 'message',
      id: '11111111',
      parentId: null,
      timestamp,
      message: { role: 'user', content: `Verify Recall's native Pi package in isolation. ${'x'.repeat(320)}`, timestamp: 1 },
    },
    {
      type: 'message',
      id: '22222222',
      parentId: '11111111',
      timestamp,
      message: { role: 'user', content: `Confirm lifecycle capture uses Pi's supported session API. ${'y'.repeat(320)}`, timestamp: 2 },
    },
  ];
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

async function main(): Promise<void> {
  const productionBefore = metadata(productionDb);
  assertSafeTestDb(testDb, productionDb);

  mkdirSync(testHome, { recursive: true });
  mkdirSync(testPiHome, { recursive: true });
  mkdirSync(testRecallHome, { recursive: true });
  mkdirSync(testBin, { recursive: true });

  const env = stringEnv({
    ...process.env,
    HOME: testHome,
    PI_CODING_AGENT_DIR: testPiHome,
    PI_CONFIG_DIR: testPiHome,
    RECALL_DIR: testRecallHome,
    RECALL_HOME: testRecallHome,
    RECALL_DB_PATH: testDb,
    RECALL_REPO_DIR: repoRoot,
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
    BACKUP_BASE: join(tempRoot, 'backups'),
    BACKUP_DIR: join(tempRoot, 'backups', 'e2e'),
    NO_COLOR: '1',
    RECALL_PI_PROBE: probeOutput,
    PATH: `${testBin}:${process.env.PATH || ''}`,
  });

  console.log(`isolation.pi_home=${testPiHome}`);
  console.log(`isolation.test_db=${testDb}`);
  console.log(`isolation.production_db=${productionDb}`);
  console.log(`isolation.production_before=${JSON.stringify(productionBefore)}`);
  console.log('isolation.production_db_opened=false');

  const initOutput = run('bun', ['run', 'src/index.ts', 'init'], env);
  if (!existsSync(testDb)) throw new Error(`test DB was not created\n${initOutput}`);

  writeFileSync(
    join(testBin, 'recall-mcp'),
    `#!/bin/sh\nexec bun ${JSON.stringify(join(repoRoot, 'dist', 'mcp-server.js'))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(testBin, 'recall'),
    `#!/bin/sh\nexec bun run ${JSON.stringify(join(repoRoot, 'src', 'index.ts'))} "$@"\n`,
    { mode: 0o755 },
  );

  // Seed the exact pre-package shape so the live installer must remove it
  // without leaving duplicate extension or skill discovery paths.
  const legacyExtensionCanonical = join(testRecallHome, 'pi', 'extensions', 'RecallExtract.ts');
  const legacySkillCanonical = join(testRecallHome, 'shared', 'skills', 'recall-add', 'SKILL.md');
  mkdirSync(dirname(legacyExtensionCanonical), { recursive: true });
  mkdirSync(dirname(legacySkillCanonical), { recursive: true });
  mkdirSync(join(testPiHome, 'extensions'), { recursive: true });
  mkdirSync(join(testPiHome, 'skills', 'recall-add'), { recursive: true });
  writeFileSync(legacyExtensionCanonical, '// legacy Recall extension\n');
  writeFileSync(legacySkillCanonical, '# legacy Recall skill\n');
  symlinkSync(legacyExtensionCanonical, join(testPiHome, 'extensions', 'RecallExtract.ts'));
  symlinkSync(legacySkillCanonical, join(testPiHome, 'skills', 'recall-add', 'SKILL.md'));

  console.log(`pi.version=${run('pi', ['--version'], env).trim()}`);
  installPiSurfaces(env);
  installPiSurfaces(env);

  if (existsSync(join(testPiHome, 'extensions', 'RecallExtract.ts'))) {
    throw new Error('legacy Recall extension still shadows the native Pi package');
  }
  if (existsSync(join(testPiHome, 'skills', 'recall-add', 'SKILL.md'))) {
    throw new Error('legacy Recall skill still shadows the native Pi package');
  }

  const packageList = run('pi', ['list', '--no-approve'], { ...env, PI_OFFLINE: '1' });
  if (!packageList.includes('npm:pi-mcp-adapter') || !packageList.includes(repoRoot)) {
    throw new Error(`Pi package list is incomplete:\n${packageList}`);
  }
  const piSettings = JSON.parse(readFileSync(join(testPiHome, 'settings.json'), 'utf-8'));
  if (piSettings.packages?.length !== 2 || piSettings.packages.filter((source: string) => source === 'npm:pi-mcp-adapter').length !== 1) {
    throw new Error(`Pi package settings did not converge: ${JSON.stringify(piSettings)}`);
  }

  const mcpConfig = JSON.parse(readFileSync(join(testPiHome, 'mcp.json'), 'utf-8'));
  const recallServer = mcpConfig.mcpServers?.['recall-memory'];
  if (recallServer?.env?.RECALL_DB_PATH !== testDb || recallServer?.directTools !== true) {
    throw new Error(`unexpected Pi MCP registration: ${JSON.stringify(recallServer)}`);
  }
  console.log('pi.install_idempotent=true');
  console.log('pi.legacy_shadows_removed=true');

  const probeExtension = join(tempRoot, 'probe-tools.ts');
  writeFileSync(probeExtension, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    const names = pi.getAllTools().map(tool => tool.name).sort();
    writeFileSync(process.env.RECALL_PI_PROBE, JSON.stringify(names));
  });
}
`);

  const sessionPath = join(tempRoot, 'pi-session.jsonl');
  writeSyntheticSession(sessionPath);

  // pi-mcp-adapter bootstraps metadata for newly configured direct tools on
  // the first session and registers those cached tools on the next startup.
  await runPiRpcUntil(
    ['--mode', 'rpc', '--no-session', '--no-builtin-tools'],
    { ...env, PI_OFFLINE: '1' },
    '{"id":"warmup","type":"get_state"}\n',
    () => cachedRecallToolCount() === mcpTools.length,
  );
  const rpcOutput = await runPiRpcUntil(
    ['--mode', 'rpc', '--session', sessionPath, '--no-builtin-tools', '--extension', probeExtension],
    { ...env, PI_OFFLINE: '1' },
    '{"id":"commands","type":"get_commands"}\n',
    stdout => existsSync(probeOutput) && stdout.split('\n').some(line => line.includes('"id":"commands"')),
  );
  const response = rpcOutput
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .find(message => message.id === 'commands');
  const skillNames = response?.data?.commands
    ?.filter((command: { source?: string }) => command.source === 'skill')
    .map((command: { name: string }) => command.name)
    .sort();
  const expectedSkills = [
    'skill:recall-add',
    'skill:recall-doctor',
    'skill:recall-dump',
    'skill:recall-loa',
    'skill:recall-recent',
    'skill:recall-scout',
    'skill:recall-search',
    'skill:recall-stats',
    'skill:recall-update',
  ];
  if (JSON.stringify(skillNames) !== JSON.stringify(expectedSkills)) {
    throw new Error(`unexpected Pi skills: ${JSON.stringify(skillNames)}`);
  }

  const piTools = JSON.parse(readFileSync(probeOutput, 'utf-8')) as string[];
  const expectedPiTools = mcpTools.map(name => `recall_memory_${name}`).sort();
  const actualPiTools = piTools.filter(name => name.startsWith('recall_memory_')).sort();
  if (JSON.stringify(actualPiTools) !== JSON.stringify(expectedPiTools)) {
    throw new Error(`unexpected Recall tools in Pi: ${JSON.stringify(actualPiTools)}; all=${JSON.stringify(piTools)}`);
  }
  console.log(`pi.skills_verified=${skillNames.length}`);
  console.log(`pi.mcp_tools_verified=${actualPiTools.length}`);

  const captured = join(testRecallHome, 'MEMORY', 'pi-sessions', 'pi-session.md');
  if (!readFileSync(captured, 'utf-8').includes("Verify Recall's native Pi package")) {
    throw new Error('Pi session_shutdown lifecycle capture did not write the synthetic session');
  }
  console.log('pi.lifecycle_capture_verified=true');

  assertMetadataUnchanged(productionDb, productionBefore);
  console.log(`isolation.production_after=${JSON.stringify(metadata(productionDb))}`);
  console.log('isolation.production_db_unchanged=true');
  console.log('e2e.status=PASS');
}

try {
  await main();
} finally {
  if (process.env.RECALL_E2E_KEEP === '1') {
    console.error(`isolation.temp_root_preserved=${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
