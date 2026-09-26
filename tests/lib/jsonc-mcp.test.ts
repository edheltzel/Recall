import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

  test('writeJsonAtomic replaces through a symlink and leaves no temp file', () => {
    dir = mkdtempSync(join(tmpdir(), 'recall-jsonc-'));
    const real = join(dir, 'real.json');
    const link = join(dir, 'settings.json');
    writeFileSync(real, '{}\n');
    symlinkSync(real, link);
    writeJsonAtomic(link, { ok: true });
    expect(readFileSync(real, 'utf8')).toContain('"ok": true');
    expect(readFileSync(link, 'utf8')).toContain('"ok": true');
  });

  test('isSemanticallyEmpty is true only for empty containers', () => {
    expect(isSemanticallyEmpty({})).toBe(true);
    expect(isSemanticallyEmpty({ hooks: { Stop: [] } })).toBe(true);
    expect(isSemanticallyEmpty({ permissions: { allow: ['x'] } })).toBe(false);
  });
});
