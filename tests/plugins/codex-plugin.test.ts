import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateCodexPluginSkills, repoRoot } from '../../scripts/build-codex-plugin';

let tempDir = '';

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('Codex native plugin package', () => {
  test('manifest, MCP config, and marketplace use one lowercase plugin identity', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugins/recall/.codex-plugin/plugin.json'), 'utf-8'));
    const mcp = JSON.parse(readFileSync(join(repoRoot, 'plugins/recall/.mcp.json'), 'utf-8'));
    const marketplace = JSON.parse(readFileSync(join(repoRoot, '.agents/plugins/marketplace.json'), 'utf-8'));
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

    expect(manifest.name).toBe('recall');
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.skills).toBe('./skills/');
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(mcp.mcpServers['recall-memory']).toEqual({ command: 'recall-mcp', args: [] });
    expect(marketplace.name).toBe('recall-marketplace');
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('recall');
    expect(marketplace.plugins[0].source.path).toBe('./plugins/recall');
  });

  test('checked-in Codex skill adapters exactly match generated output', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-codex-skills-'));
    const names = generateCodexPluginSkills(tempDir);
    expect(names).toHaveLength(9);
    for (const name of names) {
      const expected = readFileSync(join(tempDir, name, 'SKILL.md'), 'utf-8');
      const actual = readFileSync(join(repoRoot, 'plugins/recall/skills', name, 'SKILL.md'), 'utf-8');
      expect(actual).toBe(expected);
      expect(actual).toContain('equivalent behavior is not assumed across hosts');
    }
    expect(readFileSync(join(repoRoot, 'plugins/recall/skills/recall-dump/agents/openai.yaml'), 'utf-8'))
      .toContain('allow_implicit_invocation: false');
    expect(readFileSync(join(repoRoot, 'plugins/recall/skills/recall-dump/SKILL.md'), 'utf-8'))
      .not.toContain('disable-model-invocation');
  });
});
