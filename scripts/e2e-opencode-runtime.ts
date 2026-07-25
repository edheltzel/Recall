#!/usr/bin/env bun

/**
 * OpenCode runtime contract verification.
 *
 * `scripts/e2e-opencode.ts` covers the extraction pipeline (export -> drop ->
 * batch extract -> search) but reaches the adapter by importing it directly and
 * synthesizing the event payload. That proves Recall's handler ACCEPTS a
 * `session.idle` shape; it cannot prove OpenCode emits it, and it cannot prove
 * OpenCode ever loads the plugin.
 *
 * This script closes both gaps against a live server:
 *
 *   1. Discovery — the plugin is installed by the real installer, and OpenCode
 *      is observed loading it from that path.
 *   2. Frequency — `session.idle` is counted from OpenCode's own event stream
 *      across several turns of ONE session inside ONE long-lived process, so
 *      the number cannot be an artifact of process teardown.
 *   3. Completeness — the drop reflects the WHOLE conversation, not just the
 *      turn that happened to trigger the first idle.
 *
 * The model is a local OpenAI-compatible stub: the subject under test is
 * OpenCode's session lifecycle, so a hosted model would only add flakiness.
 *
 * Everything runs in disposable HOME / XDG / RECALL_HOME / database roots and
 * the production database is asserted unchanged.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { spawn } from 'child_process';
import { join } from 'path';
import { assertMetadataUnchanged, assertSafeTestDb, metadata, stringEnv } from './lib/e2e-isolation';
import {
  OPENCODE_PINNED_VERSION,
  collectEvents,
  runOpenCode,
  startStubProvider,
  stubProviderConfig,
  writeOpenCodeShim,
} from './lib/opencode-runtime';

const repoRoot = join(import.meta.dir, '..');
const productionDb = join(homedir(), '.agents', 'Recall', 'recall.db');
const tempRoot = mkdtempSync(join(tmpdir(), 'recall-opencode-runtime-'));
const testHome = join(tempRoot, 'home');
const testRecallHome = join(tempRoot, 'recall-home');
const testDb = join(tempRoot, 'recall.db');
const xdgConfig = join(tempRoot, 'xdg-config');
const xdgData = join(tempRoot, 'xdg-data');
const xdgState = join(tempRoot, 'xdg-state');
const xdgCache = join(tempRoot, 'xdg-cache');
const project = join(tempRoot, 'project');
const testBin = join(tempRoot, 'bin');
const opencodeConfigDir = join(xdgConfig, 'opencode');

const STUB_PORT = 47611;
const SERVER_PORT = 47612;
const TURN_MARKERS = ['RUNTIMETURNALPHA', 'RUNTIMETURNBRAVO', 'RUNTIMETURNCHARLIE'];
/** Generous: an idle can trail the POST response slightly. */
const IDLE_SETTLE_MS = 6_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let env: Record<string, string>;
let server: ReturnType<typeof spawn> | undefined;
let stub: ReturnType<typeof startStubProvider> | undefined;
let stream: ReturnType<typeof collectEvents> | undefined;

async function waitForServer(base: string, log: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${base}/global/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`OpenCode server never became healthy\n${log()}`);
}

async function main(): Promise<void> {
  const productionBefore = metadata(productionDb);
  assertSafeTestDb(testDb, productionDb);

  for (const path of [testHome, testRecallHome, xdgConfig, xdgData, xdgState, xdgCache, project, opencodeConfigDir, testBin]) {
    mkdirSync(path, { recursive: true });
  }
  // The plugin shells out to `opencode export`, so the CLI must be on PATH.
  writeOpenCodeShim(testBin);

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
    PATH: `${testBin}:${process.env.PATH ?? ''}`,
  });

  console.log(`isolation.recall_home=${testRecallHome}`);
  console.log(`isolation.opencode_config=${opencodeConfigDir}`);
  console.log(`isolation.test_db=${testDb}`);
  console.log(`isolation.production_db=${productionDb}`);
  console.log(`isolation.production_before=${JSON.stringify(productionBefore)}`);
  console.log('isolation.production_db_opened=false');

  const version = runOpenCode(['--version'], env, repoRoot).trim();
  console.log(`opencode.version=${version}`);
  assert(
    version.split('.').slice(0, 2).join('.') === OPENCODE_PINNED_VERSION.split('.').slice(0, 2).join('.'),
    `OpenCode ${version} is not contract-compatible with the pinned ${OPENCODE_PINNED_VERSION}; re-verify the runtime contract and bump OPENCODE_PINNED_VERSION`,
  );

  // ── 1. Discovery: install through the REAL installer, then let OpenCode find it
  runOpenCode(['--version'], env, repoRoot); // warm any first-run scaffolding
  const install = Bun.spawnSync({
    cmd: ['bash', '-c', 'source "$1"; recall_install_opencode_platform', '_', join(repoRoot, 'lib', 'install-lib.sh')],
    cwd: repoRoot,
    env,
  });
  assert(
    install.exitCode === 0,
    `recall_install_opencode_platform failed (${install.exitCode})\n${install.stdout.toString()}\n${install.stderr.toString()}`,
  );

  const installedPlugin = join(opencodeConfigDir, 'plugins', 'RecallExtract.ts');
  assert(existsSync(installedPlugin), `installer did not place the extraction plugin at ${installedPlugin}`);
  console.log(`opencode.installed_plugin=${installedPlugin}`);

  // The helpers must be nested: OpenCode calls every export of a top-level
  // plugins/*.ts as a plugin factory.
  const installedHelper = join(opencodeConfigDir, 'plugins', 'lib', 'session-export.ts');
  assert(existsSync(installedHelper), `installer did not place the plugin helper at ${installedHelper}`);
  console.log(`opencode.installed_helper=${installedHelper}`);

  // Point OpenCode's model at the local stub, preserving the installer's MCP block.
  stub = startStubProvider(STUB_PORT);
  const configPath = join(opencodeConfigDir, 'opencode.json');
  const installedConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...installedConfig, ...stubProviderConfig(stub.baseURL) }, null, 2));

  const base = `http://127.0.0.1:${SERVER_PORT}`;
  let serverLog = '';
  // --print-logs is required for plugin load failures to reach stderr, which is
  // how this script proves the plugins loaded cleanly rather than merely ran.
  const serveArgs = ['serve', '--port', String(SERVER_PORT), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'DEBUG'];
  server = spawn(
    process.env.OPENCODE_BIN ?? 'bunx',
    process.env.OPENCODE_BIN
      ? serveArgs
      : ['--yes', '--package', `opencode-ai@${OPENCODE_PINNED_VERSION}`, 'opencode', ...serveArgs],
    { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout?.on('data', chunk => { serverLog += chunk; });
  server.stderr?.on('data', chunk => { serverLog += chunk; });
  await waitForServer(base, () => serverLog);

  // ── 2. Frequency: count real session.idle events across turns of ONE session
  stream = collectEvents(base);
  await Bun.sleep(1_000);

  const session = await (await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Recall OpenCode runtime contract' }),
  })).json() as { id: string };
  const sessionId = session.id;
  console.log(`opencode.session=${sessionId}`);

  // `serve` loads plugins lazily when it bootstraps an instance, so discovery
  // can only be asserted once a session exists.
  //
  // The plugin factory creates the drop directory. Its existence under a
  // RECALL_HOME only this server knows about is proof OpenCode loaded the
  // plugin from the path the installer wrote — nothing else touches it.
  const dropDir = join(testRecallHome, 'MEMORY', 'opencode-sessions');
  for (let attempt = 0; attempt < 60 && !existsSync(dropDir); attempt++) await Bun.sleep(250);
  assert(
    existsSync(dropDir),
    `OpenCode never loaded Recall's plugin: ${dropDir} was not created by the plugin factory\n${serverLog}`,
  );
  console.log('opencode.plugin_loaded_by_host=true');

  // A plugin whose factory ran can still have logged a load error — OpenCode
  // reports one per export it could not invoke. Recall's plugins must load
  // completely clean.
  const loadErrors = serverLog.split('\n').filter(line => line.includes('failed to load plugin'));
  assert(
    loadErrors.length === 0,
    `OpenCode reported ${loadErrors.length} plugin load error(s):\n${loadErrors.join('\n')}`,
  );
  console.log('opencode.plugin_load_errors=0');

  const idleCount = () => stream!.events.filter(e => e.type === 'session.idle' && e.sessionID === sessionId).length;
  const perTurn: { turn: number; idleDelta: number }[] = [];

  for (const [index, marker] of TURN_MARKERS.entries()) {
    const before = idleCount();
    const response = await fetch(`${base}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: 'recallstub', modelID: 'stub-model' },
        parts: [{ type: 'text', text: `Record this verification token verbatim: ${marker}` }],
      }),
    });
    if (!response.ok) throw new Error(`turn ${index + 1} was rejected (${response.status}): ${await response.text()}`);
    await response.json();
    await Bun.sleep(IDLE_SETTLE_MS);
    perTurn.push({ turn: index + 1, idleDelta: idleCount() - before });
  }

  const totalIdle = idleCount();
  const perTurnRate = totalIdle / TURN_MARKERS.length;
  console.log(`opencode.session_idle_total=${totalIdle}`);
  console.log(`opencode.session_idle_turns=${TURN_MARKERS.length}`);
  console.log(`opencode.session_idle_per_turn=${perTurnRate.toFixed(2)}`);
  console.log(`opencode.session_idle_deltas=${JSON.stringify(perTurn)}`);

  // The measured contract: one idle per assistant turn. If this ever becomes
  // per-session (or debounced), the adapter's re-export strategy and the
  // frequency recorded in docs/OPENCODE_INTEGRATION.md both need revisiting —
  // so fail loudly rather than silently recording a different number.
  assert(
    totalIdle === TURN_MARKERS.length,
    `session.idle fired ${totalIdle} times across ${TURN_MARKERS.length} turns (expected one per turn). ` +
    `The runtime contract changed; re-verify docs/OPENCODE_INTEGRATION.md and opencode/RecallExtract.ts. ` +
    `deltas=${JSON.stringify(perTurn)}`,
  );
  for (const { turn, idleDelta } of perTurn) {
    assert(idleDelta === 1, `turn ${turn} produced ${idleDelta} session.idle events, expected exactly 1`);
  }

  // ── 3. Completeness: the drop must carry every turn, not only the first
  const drop = join(dropDir, `${sessionId}.md`);
  assert(existsSync(drop), `no markdown drop was written for ${sessionId}\n${serverLog}`);
  const dropBody = readFileSync(drop, 'utf-8');
  const missing = TURN_MARKERS.filter(marker => !dropBody.includes(marker));
  assert(
    missing.length === 0,
    `the drop lost ${missing.join(', ')} — a later session.idle failed to re-export the grown session. ` +
    `drop bytes=${dropBody.length}`,
  );
  console.log(`opencode.drop_contains_all_turns=true (${TURN_MARKERS.length} turns, ${dropBody.length} bytes)`);

  const tracker = join(dropDir, '.extracted.json');
  assert(existsSync(tracker), 'the adapter did not persist its dedup tracker');
  const trackerBody = JSON.parse(readFileSync(tracker, 'utf-8')) as unknown;
  assert(
    !Array.isArray(trackerBody) && typeof (trackerBody as Record<string, unknown>)[sessionId] === 'string',
    `tracker must record a content digest per session so a grown session re-exports; got ${JSON.stringify(trackerBody)}`,
  );
  console.log('opencode.tracker_records_content_digest=true');

  // The export command itself must return the whole conversation.
  const exported = runOpenCode(['export', sessionId], env, project);
  const exportMissing = TURN_MARKERS.filter(marker => !exported.includes(marker));
  assert(exportMissing.length === 0, `opencode export omitted ${exportMissing.join(', ')}`);
  console.log('opencode.export_contains_all_turns=true');

  assertMetadataUnchanged(productionDb, productionBefore);
  console.log('isolation.production_db_opened=false');
  console.log(`opencode.runtime_contract=verified against ${version}`);
}

try {
  await main();
} finally {
  stream?.stop();
  server?.kill('SIGKILL');
  stub?.stop();
  if (process.env.RECALL_E2E_KEEP === '1') console.error(`e2e.temp_root=${tempRoot}`);
  else rmSync(tempRoot, { recursive: true, force: true });
}
