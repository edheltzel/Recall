import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isSemanticallyEmpty, parseJsonc, writeJsonAtomic } from '../../lib/jsonc-mcp.ts';

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

  test('isSemanticallyEmpty is true only for empty containers', () => {
    expect(isSemanticallyEmpty({})).toBe(true);
    expect(isSemanticallyEmpty({ hooks: { Stop: [] } })).toBe(true);
    expect(isSemanticallyEmpty({ permissions: { allow: ['x'] } })).toBe(false);
  });
});
