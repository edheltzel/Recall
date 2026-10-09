import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseJsonc, validateClaudeConfigShape, writeJsonAtomic, writeJsonAtomicOrRemoveEmpty } from '../../lib/jsonc-mcp.ts';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('jsonc settings helpers', () => {
  test('parseJsonc accepts comments and a trailing comma', () => {
    const parsed = parseJsonc(`{
      // keep
      "mcpServers": { "recall-memory": { "command": "bun", }, },
    }`) as { mcpServers: { 'recall-memory': { command: string } } };
    expect(parsed.mcpServers['recall-memory'].command).toBe('bun');
  });

  test('parseJsonc rejects duplicate keys at every object depth', () => {
    expect(() => parseJsonc('{"mcpServers":{},"mcpServers":{}}')).toThrow('duplicate key "mcpServers"');
    expect(() => parseJsonc('{"mcpServers":{"recall-memory":{},"recall-memory":{}}}'))
      .toThrow('duplicate key "recall-memory"');
  });

  test('Claude config validation rejects invalid roots and Recall entries', () => {
    expect(() => validateClaudeConfigShape([])).toThrow('root is not an object');
    expect(() => validateClaudeConfigShape({ mcpServers: { 'recall-memory': [] } }))
      .toThrow('mcpServers.recall-memory is not an object');
    expect(() => validateClaudeConfigShape({ mcpServers: { 'recall-memory': null } }))
      .toThrow('mcpServers.recall-memory is not an object');
    expect(() => validateClaudeConfigShape({ mcpServers: { 'recall-memory': {} } })).not.toThrow();
  });

  test('writeJsonAtomic preserves mode for direct and symlinked targets', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-jsonc-'));
    const real = join(dir, 'real.json');
    const link = join(dir, 'settings.json');
    writeFileSync(real, '{}\n');
    chmodSync(real, 0o600);
    writeJsonAtomic(real, { direct: true });
    expect(statSync(real).mode & 0o777).toBe(0o600);
    symlinkSync(real, link);
    writeJsonAtomic(link, { ok: true });
    expect(readFileSync(real, 'utf8')).toContain('"ok": true');
    expect(readFileSync(link, 'utf8')).toContain('"ok": true');
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  test('atomic writers fail closed on a dangling symlink', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-jsonc-'));
    const targetDir = join(dir, 'dotfiles');
    const target = join(targetDir, 'settings.json');
    const link = join(dir, 'settings.json');
    mkdirSync(targetDir);
    symlinkSync(target, link);

    for (const write of [
      () => writeJsonAtomic(link, { hooks: {} }),
      () => writeJsonAtomicOrRemoveEmpty(link, {}),
    ]) {
      expect(write).toThrow('refusing to replace dangling symlink');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(target)).toBe(false);
    }
  });

  test('parse and atomic rewrite preserve an own __proto__ key', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-jsonc-'));
    const config = join(dir, 'settings.json');
    const parsed = parseJsonc(`{
      "mcpServers": {
        "__proto__": { "command": "keep", },
        "recall-memory": { "env": {}, },
      },
    }`) as {
      mcpServers: Record<string, unknown>;
    };

    writeJsonAtomic(config, parsed);

    const written = JSON.parse(readFileSync(config, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.prototype.hasOwnProperty.call(written.mcpServers, '__proto__')).toBe(true);
    expect(written.mcpServers.__proto__).toEqual({ command: 'keep' });
  });

  test('remove preserves an unrelated __proto__ registration', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-jsonc-'));
    const config = join(dir, 'settings.json');
    writeFileSync(config, '{"mcpServers":{"__proto__":{"command":"keep"},"recall-memory":{}}}\n');

    const result = Bun.spawnSync([
      'bun',
      'run',
      join(import.meta.dir, '..', '..', 'lib', 'jsonc-mcp.ts'),
      'remove',
      config,
      'mcpServers',
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(readFileSync(config, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.prototype.hasOwnProperty.call(parsed.mcpServers, '__proto__')).toBe(true);
    expect(parsed.mcpServers.__proto__).toEqual({ command: 'keep' });
    expect(parsed.mcpServers['recall-memory']).toBeUndefined();
  });

  test('remove deletes only a comment-free sole empty MCP container', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-jsonc-'));
    const helper = join(import.meta.dir, '..', '..', 'lib', 'jsonc-mcp.ts');
    const cases = [
      {
        name: 'comment',
        original: '{\n  // keep this file\n  "mcpServers": { "recall-memory": {} }\n}\n',
        verify: (file: string) => expect(readFileSync(file, 'utf8')).toContain('// keep this file'),
      },
      {
        name: 'unrelated-empty-container',
        original: '{"plugin":[],"mcpServers":{"recall-memory":{}}}\n',
        verify: (file: string) => expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ plugin: [], mcpServers: {} }),
      },
      {
        name: 'stub-server',
        original: '{"mcpServers":{"other-server":{},"recall-memory":{}}}\n',
        verify: (file: string) => expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { 'other-server': {} } }),
      },
    ];

    for (const scenario of cases) {
      const file = join(dir, `${scenario.name}.json`);
      writeFileSync(file, scenario.original);
      const result = Bun.spawnSync(['bun', 'run', helper, 'remove', file, 'mcpServers']);
      expect(result.exitCode).toBe(0);
      expect(existsSync(file)).toBe(true);
      scenario.verify(file);
    }

    const ownedOnly = join(dir, 'owned-only.json');
    writeFileSync(ownedOnly, '{"mcpServers":{"recall-memory":{}}}\n');
    const result = Bun.spawnSync(['bun', 'run', helper, 'remove', ownedOnly, 'mcpServers']);
    expect(result.exitCode).toBe(0);
    expect(existsSync(ownedOnly)).toBe(false);
  });

  test('merge and remove reject duplicate registrations without writing', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-jsonc-'));
    const original = `{
      "mcpServers": {
        "recall-memory": { "command": "first", },
        "recall-memory": { "command": "second", },
      },
    }\n`;
    const helper = join(import.meta.dir, '..', '..', 'lib', 'jsonc-mcp.ts');
    const actions = [
      ['merge', 'mcpServers', '{"command":"replacement"}', ''],
      ['remove', 'mcpServers'],
    ];

    for (const [index, args] of actions.entries()) {
      const config = join(dir, `settings-${index}.json`);
      writeFileSync(config, original);
      const result = Bun.spawnSync(['bun', 'run', helper, args[0], config, ...args.slice(1)]);
      expect(result.exitCode).toBe(1);
      expect(readFileSync(config, 'utf8')).toBe(original);
      expect(result.stderr.toString()).toContain('duplicate key "recall-memory"');
    }
  });
});
