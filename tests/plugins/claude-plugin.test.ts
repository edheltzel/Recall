import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateClaudePluginSkills, repoRoot } from '../../scripts/build-claude-plugin';
import { CLAUDE_PLUGIN_ID, claudePluginState } from '../../src/hosts/claude';

const bundleRoot = join(repoRoot, 'plugins/recall-claude');

let tempDir = '';

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('Claude native plugin package', () => {
  test('manifest, MCP config, and marketplace use one lowercase plugin identity', () => {
    const manifest = JSON.parse(readFileSync(join(bundleRoot, '.claude-plugin/plugin.json'), 'utf-8'));
    const mcp = JSON.parse(readFileSync(join(bundleRoot, '.mcp.json'), 'utf-8'));
    const marketplace = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf-8'));
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

    expect(manifest.name).toBe('recall');
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(mcp.mcpServers['recall-memory']).toEqual({ command: 'recall-mcp', args: [] });

    expect(marketplace.name).toBe('recall-marketplace');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('recall');
    expect(marketplace.plugins[0].source).toBe('./plugins/recall-claude');
    expect(`${marketplace.plugins[0].name}@${marketplace.name}`).toBe(CLAUDE_PLUGIN_ID);
  });

  test('the bundle ships no hooks — lifecycle capture stays installer-owned', () => {
    // Plugin hooks merge with settings.json hooks rather than replacing them, so a
    // bundled hook would double every capture for users who also ran install.sh.
    expect(existsSync(join(bundleRoot, 'hooks'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(bundleRoot, '.claude-plugin/plugin.json'), 'utf-8'));
    expect(manifest.hooks).toBeUndefined();
  });

  test('checked-in skills are byte-verbatim copies of the canonical sources', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-claude-skills-'));
    const names = generateClaudePluginSkills(tempDir);
    expect(names).toHaveLength(9);
    for (const name of names) {
      const canonical = readFileSync(join(repoRoot, 'agent-skills', name, 'SKILL.md'), 'utf-8');
      const generated = readFileSync(join(tempDir, name, 'SKILL.md'), 'utf-8');
      const checkedIn = readFileSync(join(bundleRoot, 'skills', name, 'SKILL.md'), 'utf-8');
      expect(generated).toBe(canonical);
      expect(checkedIn).toBe(canonical);
    }
    expect(readdirSync(join(bundleRoot, 'skills')).sort()).toEqual(names);
  });

  test('Claude-only frontmatter survives into the bundle', () => {
    // The reverse of the Codex adaptation: Codex cannot read disable-model-invocation
    // and needed agents/openai.yaml, so the Codex adapters strip it. Claude's own
    // loader consumes the field, so the bundle must keep it.
    expect(readFileSync(join(bundleRoot, 'skills/recall-dump/SKILL.md'), 'utf-8'))
      .toContain('disable-model-invocation: true');
    expect(readFileSync(join(bundleRoot, 'skills/recall-scout/SKILL.md'), 'utf-8'))
      .toContain('allowed-tools:');
    expect(existsSync(join(bundleRoot, 'skills/recall-dump/agents/openai.yaml'))).toBe(false);
  });

  test('plugin state reads Claude\'s own files and respects an explicit disable', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-claude-state-'));
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });

    expect(claudePluginState(tempDir)).toEqual({ installed: false, active: false, version: null });

    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { [CLAUDE_PLUGIN_ID]: [{ scope: 'user', version: '0.9.4' }] } }),
    );
    expect(claudePluginState(tempDir)).toEqual({ installed: true, active: true, version: '0.9.4' });

    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { [CLAUDE_PLUGIN_ID]: false } }));
    expect(claudePluginState(tempDir)).toEqual({ installed: true, active: false, version: '0.9.4' });
  });
});
