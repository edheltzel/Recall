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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeMcpEnv } from '../../src/commands/doctor';

const RESOLVED = '/custom/recall/recall.db';

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-mcp-env-'));
  configPath = join(tempDir, '.claude.json');
});

afterEach(() => {
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
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

  test('malformed JSON config is skipped, not fatal → INFO', () => {
    writeFileSync(configPath, '{ not valid json ');
    const { result } = probe();
    expect(result.status).toBe('INFO');
  });
});
