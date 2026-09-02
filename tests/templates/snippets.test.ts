import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const SNIPPETS = join(REPO, 'templates', 'cursor');

describe('Déjà vu-style install snippets', () => {
  test('snippets are small files and call recall start / recall-mcp', () => {
    const files = readdirSync(SNIPPETS);
    expect(files.sort()).toEqual(['hooks.json', 'mcp.json', 'one-liner.sh', 'rule.md']);
    for (const file of files) {
      const full = join(SNIPPETS, file);
      expect(statSync(full).size).toBeLessThan(800);
    }
    const hooks = readFileSync(join(SNIPPETS, 'hooks.json'), 'utf-8');
    const hookCommand = JSON.parse(hooks).hooks.sessionStart[0].command;
    expect(hookCommand).toBe('recall start --format cursor');
    expect(hookCommand).not.toMatch(/^[/~]/);
    expect(hookCommand).not.toContain('$HOME');
    expect(hookCommand).not.toContain('~/.bun');
    const mcp = JSON.parse(readFileSync(join(SNIPPETS, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers['recall-memory'].command).toBe('recall-mcp');
    expect(JSON.stringify(mcp)).not.toContain('mem-mcp');
    const oneLiner = readFileSync(join(SNIPPETS, 'one-liner.sh'), 'utf-8');
    expect(oneLiner).toContain('recall start --format cursor');
    expect(oneLiner).toContain('Cursor.app');
    expect(oneLiner).toContain('no-op');
    expect(oneLiner).toContain('~/.bun/bin');
    expect(oneLiner).not.toMatch(/\/Users\//);
    expect(oneLiner).not.toContain('hooks/Recall');
    expect(readFileSync(join(SNIPPETS, 'rule.md'), 'utf-8')).toContain('recall-memory');
  });

  test('no Déjà vu source tree is vendored', () => {
    expect(existsSync(join(REPO, 'deja-vu'))).toBe(false);
    expect(existsSync(join(REPO, 'vendor', 'deja-vu'))).toBe(false);
    const oneLiner = readFileSync(join(SNIPPETS, 'one-liner.sh'), 'utf-8');
    expect(oneLiner).not.toContain('ssh-sync');
    expect(oneLiner).not.toContain('tool-trace');
  });
});
