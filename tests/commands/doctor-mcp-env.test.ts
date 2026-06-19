// Unit tests for the MCP-env repair primitive used by `recall doctor --fix`
// (issue #28). probeMcpEnv() is pure with respect to its args (config-file
// paths + resolved DB path), so we drive it directly against temp config files
// rather than invoking runDoctor end-to-end.
//
// The repair backs the config file up to ~/.agents/Recall/backups/ via
// homedir() — the same convention probeSymlink's repair uses. We deliberately
// do NOT mutate process.env.HOME here: bun:test shares one process, and a
// leaked HOME breaks sibling suites that spawn bash. The backup is a harmless
// copy of a temp file in Recall's own backup area; we assert on the patched
// config, not the backup.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { probeMcpEnv, resolveProbeResult } from '../../src/commands/doctor';

const RESOLVED = '/custom/recall/recall.db';

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-mcp-env-'));
  configPath = join(tempDir, '.claude.json');
});

afterEach(() => {
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  // repair() backs up under the real home (Bun's homedir() ignores $HOME); the
  // mangled backup name embeds this test's unique tempDir, so clean ours up.
  try {
    if (!existsSync(BACKUPS_ROOT)) return;
    const mangledDir = tempDir.replace(/[/\\]/g, '_');
    for (const stamp of readdirSync(BACKUPS_ROOT)) {
      const dir = join(BACKUPS_ROOT, stamp, 'doctor-fix');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.includes(mangledDir)) rmSync(join(dir, f), { force: true });
      }
    }
  } catch { /* best-effort cleanup */ }
});

function writeConfig(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

function readEntry(): Record<string, unknown> {
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
  return cfg.mcpServers['recall-memory'];
}

function probe() {
  return probeMcpEnv({ configPaths: [configPath], resolvedDbPath: RESOLVED });
}

// repair() backs files up under the real home (Bun's homedir() ignores $HOME),
// so a backup is located by its mangled-path filename across the stamp dirs.
const BACKUPS_ROOT = join(homedir(), '.agents', 'Recall', 'backups');
function backupExistsFor(cfgPath: string): boolean {
  if (!existsSync(BACKUPS_ROOT)) return false;
  const mangled = cfgPath.replace(/[/\\]/g, '_');
  return readdirSync(BACKUPS_ROOT).some(stamp =>
    existsSync(join(BACKUPS_ROOT, stamp, 'doctor-fix', mangled))
  );
}

describe('probeMcpEnv', () => {
  test('env.RECALL_DB_PATH matches resolved path → PASS (no repair)', () => {
    writeConfig({
      mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'], env: { RECALL_DB_PATH: RESOLVED } } },
    });
    const { result, repair } = probe();
    expect(result.status).toBe('PASS');
    expect(repair).toBeUndefined();
  });

  test('empty env: {} → WARN + repair patches RECALL_DB_PATH', () => {
    writeConfig({
      mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'], env: {} } },
    });
    const { result, repair } = probe();
    expect(result.status).toBe('WARN');
    expect(repair).toBeDefined();

    const fixed = repair!();
    expect(fixed.status).toBe('PASS');
    expect(readEntry().env).toEqual({ RECALL_DB_PATH: RESOLVED });
  });

  test('missing env block entirely → WARN + repair creates env with RECALL_DB_PATH', () => {
    writeConfig({
      mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'] } },
    });
    const { result, repair } = probe();
    expect(result.status).toBe('WARN');
    expect(repair).toBeDefined();

    repair!();
    expect(readEntry().env).toEqual({ RECALL_DB_PATH: RESOLVED });
  });

  test('divergent RECALL_DB_PATH → WARN + repair corrects it and drops legacy MEM_DB_PATH', () => {
    writeConfig({
      mcpServers: {
        'recall-memory': {
          command: 'bun',
          args: ['run', 'recall-mcp'],
          env: { RECALL_DB_PATH: '/stale/old.db', MEM_DB_PATH: '/stale/old.db' },
        },
      },
    });
    const { result, repair } = probe();
    expect(result.status).toBe('WARN');
    expect(result.message).toContain('/stale/old.db');

    const fixed = repair!();
    expect(fixed.status).toBe('PASS');
    const env = readEntry().env as Record<string, unknown>;
    expect(env.RECALL_DB_PATH).toBe(RESOLVED);
    expect(env.MEM_DB_PATH).toBeUndefined();
  });

  test('repair preserves other entry keys and sibling mcpServers', () => {
    writeConfig({
      mcpServers: {
        'recall-memory': { type: 'stdio', command: '/custom/bun', args: ['run', '/custom/recall-mcp'], env: {} },
        'other-server': { command: 'node', args: ['x.js'] },
      },
      someTopLevelKey: 'keep-me',
    });
    probe().repair!();

    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    const entry = cfg.mcpServers['recall-memory'];
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe('/custom/bun'); // doctor does NOT rewrite command/args
    expect(entry.args).toEqual(['run', '/custom/recall-mcp']);
    expect(entry.env.RECALL_DB_PATH).toBe(RESOLVED);
    expect(cfg.mcpServers['other-server']).toEqual({ command: 'node', args: ['x.js'] });
    expect(cfg.someTopLevelKey).toBe('keep-me');
  });

  test('registration absent (config has no recall-memory) → INFO (no repair)', () => {
    writeConfig({ mcpServers: { 'other-server': { command: 'node' } } });
    const { result, repair } = probe();
    expect(result.status).toBe('INFO');
    expect(repair).toBeUndefined();
  });

  test('no config files exist → INFO (no crash)', () => {
    const { result, repair } = probeMcpEnv({
      configPaths: [join(tempDir, 'nope.json'), join(tempDir, 'also-nope.json')],
      resolvedDbPath: RESOLVED,
    });
    expect(result.status).toBe('INFO');
    expect(repair).toBeUndefined();
  });

  // ── Fix 3 (issue #112): present-but-unparseable is WARN, not INFO ──
  // A config that exists but is malformed must be surfaced (doctor refuses to
  // touch a file it can't parse), distinct from a genuinely-absent registration
  // (the "registration absent" test above, which stays INFO).
  test('config present but unparseable JSON → WARN (refuses to touch it)', () => {
    writeFileSync(configPath, '{ not valid json ');
    const { result, repair } = probe();
    expect(result.status).toBe('WARN');
    expect(result.message).toContain('unparseable');
    expect(result.message).toContain(configPath);
    expect(repair).toBeUndefined();
  });

  // ── Fix 2 (issue #112): atomic write leaves valid JSON and no .tmp orphan ──
  test('successful repair leaves no .tmp orphan and writes valid JSON', () => {
    writeConfig({
      mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'], env: {} } },
    });
    const fixed = probe().repair!();
    expect(fixed.status).toBe('PASS');
    expect(existsSync(configPath + '.tmp')).toBe(false);
    // Throws if the file is not intact, valid JSON.
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe(RESOLVED);
  });

  // ── Fix 1 (issue #112): per-file error isolation ──
  // A write failure on one owner must not throw out of the loop or abort the
  // other owners. The result reflects partial success honestly (FAIL), and the
  // healthy owner is still patched (and backed up).
  // Skipped as root: chmod(0o500) does not block uid 0, so the forced EACCES
  // would never fire (Docker-root CI). This is the sole fail-before guard.
  test.skipIf(process.getuid?.() === 0)('write failure on one owner → FAIL, other owner still patched, no throw', () => {
    const okDir = join(tempDir, 'ok');
    const roDir = join(tempDir, 'readonly');
    mkdirSync(okDir);
    mkdirSync(roDir);
    const okPath = join(okDir, '.claude.json');
    const roPath = join(roDir, '.claude.json');
    const stale = { mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'], env: {} } } };
    writeFileSync(okPath, JSON.stringify(stale, null, 2));
    writeFileSync(roPath, JSON.stringify(stale, null, 2));

    chmodSync(roDir, 0o500); // creating the temp sibling inside this dir fails (EACCES)
    try {
      const { result, repair } = probeMcpEnv({ configPaths: [okPath, roPath], resolvedDbPath: RESOLVED });
      expect(result.status).toBe('WARN');
      const fixed = repair!(); // must not throw despite the read-only owner
      expect(fixed.status).toBe('FAIL');
      // Healthy owner patched and backed up ...
      expect(JSON.parse(readFileSync(okPath, 'utf-8')).mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe(RESOLVED);
      expect(backupExistsFor(okPath)).toBe(true);
      // ... failed owner left fully intact (byte-for-byte, not partial/corrupt)
      // and no .tmp orphan remains.
      expect(JSON.parse(readFileSync(roPath, 'utf-8'))).toEqual(stale);
      expect(existsSync(roPath + '.tmp')).toBe(false);
    } finally {
      chmodSync(roDir, 0o700);
    }
  });

  // ── Fix 4 (issue #112): no orphan backup when the registration vanishes ──
  // If the registration disappears between probe and repair, the backup (taken
  // only after the re-read + entry guard) must never be created for the
  // unmodified file.
  test('registration vanishing between probe and repair leaves no backup', () => {
    writeConfig({
      mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'], env: {} } },
    });
    const { repair } = probe();
    writeConfig({ mcpServers: {} }); // registration vanishes before repair runs

    const fixed = repair!();
    expect(fixed.status).toBe('PASS'); // a vanished owner is not a failure
    expect(fixed.message).toContain('Nothing to patch'); // honest: doesn't claim work it didn't do
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ mcpServers: {} }); // untouched
    expect(backupExistsFor(configPath)).toBe(false); // no orphan backup of the unmodified file
  });

  // ── Fix 1 (issue #112): symlinked config is written THROUGH the link ──
  // renameSync over the link path would replace the symlink with a regular file
  // and leave the canonical target stale; realpathSync resolves it first.
  test('symlinked config: repair preserves the link and patches the real target', () => {
    const realPath = join(tempDir, 'real.json');
    const linkPath = join(tempDir, 'link.json');
    writeFileSync(realPath, JSON.stringify(
      { mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'], env: {} } } }, null, 2));
    symlinkSync(realPath, linkPath);

    const fixed = probeMcpEnv({ configPaths: [linkPath], resolvedDbPath: RESOLVED }).repair!();
    expect(fixed.status).toBe('PASS');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true); // link not clobbered into a regular file
    expect(JSON.parse(readFileSync(realPath, 'utf-8')).mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe(RESOLVED);
  });

  // ── Fix 3 (issue #112): a malformed sibling is named, not silently dropped,
  // even when a valid owner is present (the unparseable note must ride along) ──
  test('valid owner + malformed sibling → result NAMES the malformed file', () => {
    const validPath = join(tempDir, 'valid.json');
    const badPath = join(tempDir, 'bad.json');
    writeFileSync(validPath, JSON.stringify(
      { mcpServers: { 'recall-memory': { command: 'bun', args: ['run', 'recall-mcp'], env: {} } } }, null, 2));
    writeFileSync(badPath, '{ not valid json ');

    const { result } = probeMcpEnv({ configPaths: [validPath, badPath], resolvedDbPath: RESOLVED });
    expect(result.status).toBe('WARN'); // stale valid owner
    expect(result.message).toContain(badPath); // malformed sibling surfaced, not dropped
  });

  // ── Fix 1 call site (issue #112): a throwing repair() degrades to FAIL and
  // does not propagate, so runDoctor still prints its summary ──
  test('resolveProbeResult: throwing repair() degrades to FAIL (no propagation)', () => {
    const throwing = {
      result: { label: 'MCP env carries RECALL_DB_PATH', status: 'WARN' as const, message: 'needs fix' },
      repair: () => { throw new Error('disk full'); },
    };
    const res = resolveProbeResult(throwing, true);
    expect(res.status).toBe('FAIL');
    expect(res.message).toContain('disk full'); // cause preserved
    expect(res.label).toBe('MCP env carries RECALL_DB_PATH');
    // Without --fix the original result passes through untouched (repair not run).
    expect(resolveProbeResult(throwing, false).status).toBe('WARN');
  });
});
