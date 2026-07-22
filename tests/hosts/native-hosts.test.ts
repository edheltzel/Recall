import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configurableHosts } from '../../src/hosts';
import { claudePaths } from '../../src/hosts/claude';
import { extractClaudeProjectFromPath } from '../../src/hosts/claude-session-source';
import { parseMarkdownDrop } from '../../src/hosts/markdown-session-source';
import { discoverCurrentSession } from '../../src/hosts/session-sources';

describe('native host boundaries', () => {
  test('each verified host owns its MCP config shape', () => {
    const targets = configurableHosts.flatMap(host => host.mcpConfigTargets('/test-home'));
    expect(targets.map(target => target.host)).toEqual(['claude', 'claude', 'opencode', 'pi']);
    expect(targets.find(target => target.host === 'opencode')?.envPath).toEqual([
      'mcp', 'recall-memory', 'environment',
    ]);
    expect(targets.find(target => target.host === 'pi')?.envPath).toEqual([
      'mcpServers', 'recall-memory', 'env',
    ]);
    expect(claudePaths('/test-home').projects).toBe('/test-home/.claude/projects');
  });

  test('session discovery is adapter ordered and stops at the first supported transcript', () => {
    const calls: string[] = [];
    const session = discoverCurrentSession([
      { id: 'claude', discover: () => { calls.push('claude'); return null; } },
      {
        id: 'codex',
        discover: () => {
          calls.push('codex');
          return {
            source: 'codex',
            sessionId: 'fixture',
            project: 'Recall',
            filePath: 'fixture.jsonl',
            messages: [],
          };
        },
      },
      { id: 'pi', discover: () => { calls.push('pi'); return null; } },
    ]);
    expect(session?.source).toBe('codex');
    expect(calls).toEqual(['claude', 'codex']);
  });

  test('Claude transcript paths are decoded inside the Claude adapter', () => {
    expect(extractClaudeProjectFromPath('-home-user-Projects-my-app')).toBe('my-app');
    expect(extractClaudeProjectFromPath('-home-user-work-my-app')).toBe('app');
    expect(extractClaudeProjectFromPath('myproject')).toBe('myproject');
  });

  test('markdown host adapters keep heading-delimited messages separate', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-markdown-host-'));
    const file = join(root, 'session.md');
    try {
      writeFileSync(file, '# User\nFirst portable message.\n\n## Assistant\nSecond portable response.\n');
      const parsed = parseMarkdownDrop(file);
      expect(parsed?.messages.map(message => message.content)).toEqual([
        'First portable message.',
        'Second portable response.',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
