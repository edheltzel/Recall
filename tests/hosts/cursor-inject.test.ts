import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  CURSOR_MCP_COMMAND,
  CURSOR_SESSION_START_COMMAND,
  cursorMcpSnippet,
  mergeCursorHooksJson,
  renderCursorSessionStart,
} from '../../src/hosts/cursor-inject';
import { MEMORY_UNAVAILABLE } from '../../hooks/lib/session-start-context';

const REPO = join(import.meta.dir, '..', '..');

describe('Cursor inject wire', () => {
  test('wrapper stdout is JSON.parse-able { additional_context } with no hookSpecificOutput', () => {
    const stdout = renderCursorSessionStart('L0 identity\nL1 ranked');
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toEqual({ additional_context: 'L0 identity\nL1 ranked' });
    expect(parsed).not.toHaveProperty('hookSpecificOutput');
    expect(Object.keys(parsed)).toEqual(['additional_context']);
  });

  test('empty assembler output still wraps additional_context', () => {
    const parsed = JSON.parse(renderCursorSessionStart(MEMORY_UNAVAILABLE));
    expect(parsed.additional_context).toBe(MEMORY_UNAVAILABLE);
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  test('hooks.json sessionStart merge is idempotent and does not clobber other hooks', () => {
    const existing = {
      version: 1,
      hooks: {
        sessionStart: [{ command: 'other-tool start' }],
        stop: [{ command: 'other-tool stop' }],
      },
    };
    const once = mergeCursorHooksJson(existing);
    const twice = mergeCursorHooksJson(once);
    expect(once.hooks.sessionStart).toHaveLength(2);
    expect(twice.hooks.sessionStart).toHaveLength(2);
    expect(once.hooks.sessionStart).toEqual(twice.hooks.sessionStart);
    expect(once.hooks.stop).toEqual([{ command: 'other-tool stop' }]);
    expect(once.hooks.sessionStart.some(entry =>
      (entry as { command: string }).command === CURSOR_SESSION_START_COMMAND
    )).toBe(true);
    expect(CURSOR_SESSION_START_COMMAND).toBe('recall start --format cursor');
  });

  test('MCP snippet command is recall-mcp, never mem-mcp', () => {
    const snippet = cursorMcpSnippet();
    const server = (snippet.mcpServers as Record<string, { command: string }> )['recall-memory'];
    expect(server.command).toBe('recall-mcp');
    expect(CURSOR_MCP_COMMAND).toBe('recall-mcp');
    expect(JSON.stringify(snippet)).not.toContain('mem-mcp');
  });

  test('no Cursor marketplace manifest', () => {
    expect(existsSync(join(REPO, '.cursor-plugin'))).toBe(false);
    expect(existsSync(join(REPO, 'plugins', 'recall-cursor'))).toBe(false);
    const pluginDirs = existsSync(join(REPO, 'plugins')) ? readdirSync(join(REPO, 'plugins')) : [];
    expect(pluginDirs.some(name => name.toLowerCase().includes('cursor'))).toBe(false);
    const injectSource = readFileSync(join(REPO, 'src', 'hosts', 'cursor-inject.ts'), 'utf-8');
    expect(injectSource).not.toMatch(/\bmarketplace\b/);
    expect(renderCursorSessionStart('x')).not.toContain('hookSpecificOutput');
  });
});
