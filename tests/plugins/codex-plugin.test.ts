import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { generateCodexPluginSkills, repoRoot } from '../../scripts/build-codex-plugin';
import {
  CODEX_CAPTURE_COMMAND,
  CODEX_SESSION_START_COMMAND,
  codexCaptureFromHook,
} from '../../hosts/plugins/recall/hooks/capture';
let tempDir = '';

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('Codex native plugin package', () => {
  test('manifest, MCP config, and marketplace use one lowercase plugin identity', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'hosts/plugins/recall/.codex-plugin/plugin.json'), 'utf-8')
    );
    const mcp = JSON.parse(readFileSync(join(repoRoot, 'hosts/plugins/recall/.mcp.json'), 'utf-8'));
    const hooks = JSON.parse(
      readFileSync(join(repoRoot, 'hosts/plugins/recall/hooks/hooks.json'), 'utf-8')
    );
    const marketplace = JSON.parse(
      readFileSync(join(repoRoot, '.agents/plugins/marketplace.json'), 'utf-8')
    );
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

    expect(manifest.name).toBe('recall');
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.skills).toBe('./skills/');
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(manifest.hooks).toBe('./hooks/hooks.json');
    expect(mcp.mcpServers['recall-memory']).toEqual({ command: 'recall-mcp', args: [] });
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      'PostCompact',
      'PreCompact',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(CODEX_SESSION_START_COMMAND);
    for (const event of ['Stop', 'PreCompact', 'PostCompact', 'SessionEnd']) {
      expect(hooks.hooks[event][0].hooks[0].command).toBe(CODEX_CAPTURE_COMMAND);
    }
    expect(readFileSync(join(repoRoot, 'hosts/plugins/recall/hooks/capture.ts'), 'utf-8'))
      .not.toMatch(/bun:sqlite|from ['"].*host-ingest/);
    expect(marketplace.name).toBe('recall-marketplace');
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('recall');
    expect(marketplace.plugins[0].source.path).toBe('./hosts/plugins/recall');
  });

  test('checked-in Codex skill adapters exactly match generated output', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-codex-skills-'));
    const names = generateCodexPluginSkills(tempDir);
    expect(names).toHaveLength(9);
    for (const name of names) {
      const expected = readFileSync(join(tempDir, name, 'SKILL.md'), 'utf-8');
      const actual = readFileSync(
        join(repoRoot, 'hosts/plugins/recall/skills', name, 'SKILL.md'),
        'utf-8'
      );
      expect(actual).toBe(expected);
      expect(actual).toContain('equivalent behavior is not assumed across hosts');
    }
    expect(
      readFileSync(join(repoRoot, 'hosts/plugins/recall/skills/do-recall-dump/agents/openai.yaml'), 'utf-8')
    ).toContain('allow_implicit_invocation: false');
    expect(
      readFileSync(join(repoRoot, 'hosts/plugins/recall/skills/do-recall-dump/SKILL.md'), 'utf-8')
    ).not.toContain('disable-model-invocation');
  });
});

describe('Codex capture adapter', () => {
  test('Stop with a supplied transcript becomes capture text and skips injected turns', () => {
    const transcript = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-native-123', cwd: '/work/Recall' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work\nsecret' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Remember the cobalt quay.' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Remember the cobalt quay.' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Stored.' }],
        },
      }),
    ].join('\n');
    const call = codexCaptureFromHook(
      {
        hook_event_name: 'Stop',
        session_id: 'codex-native-123',
        transcript_path: '/supplied/rollout.jsonl',
        cwd: '/work/Recall',
      },
      () => transcript,
    );
    expect(call).toEqual({
      event: 'turn_end',
      sessionId: 'codex-native-123',
      cwd: '/work/Recall',
      text: 'user: Remember the cobalt quay.\n\nassistant: Stored.',
    });
  });

  test('skips subagent payloads unless RECALL_INCLUDE_SUBAGENTS=1', () => {
    const payload = {
      hook_event_name: 'Stop',
      session_id: 'child',
      agent_id: 'child-agent',
      transcript_path: '/supplied/rollout.jsonl',
    };
    expect(codexCaptureFromHook(payload, () => '')).toEqual({ skipped: 'subagent' });
    const included = codexCaptureFromHook(
      payload,
      () => JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'hello from child' },
      }),
      { RECALL_INCLUDE_SUBAGENTS: '1' },
    );
    expect(included).toMatchObject({ event: 'turn_end', text: 'user: hello from child' });
  });

  test('SessionEnd maps to session_end and a missing transcript does not invent a path', () => {
    expect(codexCaptureFromHook({ hook_event_name: 'SessionEnd', session_id: 's' }, () => ''))
      .toEqual({ skipped: 'missing-supplied-transcript' });
    expect(codexCaptureFromHook({ hook_event_name: 'SessionStart', session_id: 's' }, () => 'x'))
      .toEqual({ skipped: 'unsupported-event' });
  });

  test('the hook script calls recall capture and does not write SQLite itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-codex-capture-'));
    tempDir = root;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'capture.json');
    const transcript = join(root, 'rollout.jsonl');
    writeFileSync(transcript, JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'door text' },
    }));
    writeFileSync(join(bin, 'recall'), `#!/bin/sh\ncat > ${JSON.stringify(log)}\n`, { mode: 0o755 });
    const result = spawnSync('bun', [join(repoRoot, 'hosts/plugins/recall/hooks/capture.ts')], {
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'sess-door',
        cwd: '/work/Recall',
        transcript_path: transcript,
      }),
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf-8'))).toEqual({
      contract: 1,
      harness: 'codex',
      event: 'session_end',
      text: 'user: door text',
      session_id: 'sess-door',
      cwd: '/work/Recall',
    });
  });
});
