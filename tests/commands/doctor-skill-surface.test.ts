// Unit tests for the skill-surface floor probe used by `recall doctor` (#235).
// probeSkillSurface() is pure with respect to its arg (the install root), so we
// drive it directly against a temp root rather than invoking runDoctor
// end-to-end — same approach as doctor-install-sentinel.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeClaudePlugin, probeSkillSurface } from '../../src/commands/doctor';
import { CLAUDE_PLUGIN_ID } from '../../src/hosts/claude';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'do-recall-doctor-skills-'));
});

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('probeSkillSurface', () => {
  test('install root absent → INFO (nothing to check)', () => {
    const r = probeSkillSurface(join(root, 'does-not-exist'));
    expect(r.status).toBe('INFO');
  });

  test('root present but zero skill canonicals → WARN (blank command surface)', () => {
    const r = probeSkillSurface(root);
    expect(r.status).toBe('WARN');
    expect(r.message).toContain('command surface');
  });

  test('root with a skill canonical → PASS', () => {
    const skillDir = join(root, 'shared', 'skills', 'do-recall-scout');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# scout\n');
    const r = probeSkillSurface(root);
    expect(r.status).toBe('PASS');
    expect(r.message).toContain('1 agent skill file');
  });

describe('probeClaudePlugin JSONC settings', () => {
  test('detects the legacy MCP entry in commented settings with trailing commas', () => {
    const home = join(root, 'home');
    const claudeDir = join(home, '.claude');
    const recallRoot = join(root, 'recall');
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
    mkdirSync(join(recallRoot, 'shared', 'skills', 'do-recall-add'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { [CLAUDE_PLUGIN_ID]: [{ version: '1.0.0' }] } }),
    );
    writeFileSync(join(recallRoot, 'shared', 'skills', 'do-recall-add', 'SKILL.md'), '# Add\n');
    writeFileSync(join(claudeDir, 'settings.json'), `{
  // Retain this user-edited JSONC config.
  "mcpServers": { "recall-memory": { "command": "recall-mcp", }, },
}`);

    const result = probeClaudePlugin(home, recallRoot);
    expect(result.status).toBe('WARN');
    expect(result.message).toContain('also registered in settings.json');
  });

  test('warns when plugin ownership cannot be read from settings', () => {
    const home = join(root, 'home-unknown');
    const claudeDir = join(home, '.claude');
    const recallRoot = join(root, 'recall-unknown');
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { [CLAUDE_PLUGIN_ID]: [{ version: '1.0.0' }] } }),
    );
    writeFileSync(join(claudeDir, 'settings.json'), '{"permissions":{},"permissions":{}}');

    const result = probeClaudePlugin(home, recallRoot);

    expect(result.status).toBe('WARN');
    expect(result.message).toContain('ownership is unknown');
  });

  test('warns when an active plugin has an unparseable legacy MCP config', () => {
    const home = join(root, 'home-invalid-mcp');
    const claudeDir = join(home, '.claude');
    const recallRoot = join(root, 'recall-invalid-mcp');
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { [CLAUDE_PLUGIN_ID]: [{ version: '1.0.0' }] } }),
    );
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":{},"mcpServers":{}}');

    const result = probeClaudePlugin(home, recallRoot);

    expect(result.status).toBe('WARN');
    expect(result.message).toContain('.claude.json');
    expect(result.message).toContain('sole MCP ownership is unknown');
  });

  test('warns when an active plugin has an invalid Recall MCP entry', () => {
    const home = join(root, 'home-invalid-entry');
    const claudeDir = join(home, '.claude');
    const recallRoot = join(root, 'recall-invalid-entry');
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { [CLAUDE_PLUGIN_ID]: [{ version: '1.0.0' }] } }),
    );
    writeFileSync(join(claudeDir, 'settings.json'), '{"mcpServers":{"recall-memory":[]}}');

    const result = probeClaudePlugin(home, recallRoot);

    expect(result.status).toBe('WARN');
    expect(result.message).toContain('settings.json');
    expect(result.message).toContain('sole MCP ownership is unknown');
  });

});
});
