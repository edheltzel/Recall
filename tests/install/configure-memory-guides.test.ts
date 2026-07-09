// Recall's platform bootstrap files point to the canonical guide instead of
// copying tool syntax that can drift from the live MCP schema.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { legacyClaudeMemorySection, legacyPiMemorySection } from '../fixtures/legacy-memory-sections';

const INSTALL_LIB = join(process.cwd(), 'lib', 'install-lib.sh');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

describe('shared install/update memory guide configuration', () => {
  let tempRoot: string;
  let claudeDir: string;
  let piConfigDir: string;
  let recallDir: string;
  let fakeRepo: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-memory-guide-'));
    claudeDir = join(tempRoot, '.claude');
    piConfigDir = join(tempRoot, '.pi', 'agent');
    recallDir = join(tempRoot, '.agents', 'Recall');
    fakeRepo = join(tempRoot, 'repo');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(piConfigDir, { recursive: true });
    mkdirSync(fakeRepo, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function run(functionName: 'recall_configure_claude_md' | 'recall_install_pi_guide'): RunResult {
    const driverPath = join(tempRoot, `drive-${functionName}.sh`);
    const driver = [
      '#!/usr/bin/env bash',
      'set -eo pipefail',
      `export HOME="${tempRoot}"`,
      `export CLAUDE_DIR="${claudeDir}"`,
      `export PI_CONFIG_DIR="${piConfigDir}"`,
      `export RECALL_DIR="${recallDir}"`,
      `export RECALL_REPO_DIR="${fakeRepo}"`,
      'log_success() { :; }',
      'log_warn()    { :; }',
      'log_info()    { :; }',
      'log_error()   { :; }',
      `source "${INSTALL_LIB}"`,
      functionName,
    ].join('\n');
    writeFileSync(driverPath, driver, { mode: 0o755 });

    const result = spawnSync('bash', [driverPath], { encoding: 'utf-8' });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status ?? 1,
    };
  }


  test('Claude bootstrap adds one canonical-guide pointer and remains idempotent', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, '# Existing instructions');

    const first = run('recall_configure_claude_md');
    expect(first.status).toBe(0);
    const once = readFileSync(claudeMd, 'utf-8');

    expect(once).toContain('# Existing instructions');
    expect(once).toContain('# Existing instructions\n\n## MEMORY');
    expect(once).toContain('## MEMORY');
    expect(once).toContain('<!-- RECALL_MANAGED_MEMORY -->');
    expect(once).toContain(`${claudeDir}/Recall_GUIDE.md`);
    expect(once).toContain('live `recall-memory` MCP schemas');
    expect(once).not.toContain('Core rules:');
    expect(once).not.toContain('task_description');

    const second = run('recall_configure_claude_md');
    expect(second.status).toBe(0);
    expect(readFileSync(claudeMd, 'utf-8')).toBe(once);
  });

  test('Claude bootstrap preserves CRLF while appending a new pointer', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, '# Existing instructions\r\n');

    const result = run('recall_configure_claude_md');

    expect(result.status).toBe(0);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('# Existing instructions\r\n\r\n## MEMORY');
    expect(content).toContain('<!-- RECALL_MANAGED_MEMORY -->\r\n');
    expect(content.replace(/\r\n/g, '')).not.toContain('\n');
  });

  test('Claude bootstrap refreshes a stale marked section', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      '# Existing instructions\n\n## MEMORY\n<!-- RECALL_MANAGED_MEMORY -->\n\nObsolete copied tool syntax.\n',
    );

    const result = run('recall_configure_claude_md');

    expect(result.status).toBe(0);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain(`${claudeDir}/Recall_GUIDE.md`);
    expect(content).toContain('live `recall-memory` MCP schemas');
    expect(content).not.toContain('Obsolete copied tool syntax.');
  });

  test('Claude bootstrap migrates the exact pre-marker legacy body', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, `# Existing instructions\n\n${legacyClaudeMemorySection(claudeDir)}\n\n## Later\nKeep this.\n`);

    const result = run('recall_configure_claude_md');

    expect(result.status).toBe(0);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('# Existing instructions');
    expect(content).toContain('<!-- RECALL_MANAGED_MEMORY -->');
    expect(content).toContain(`${claudeDir}/Recall_GUIDE.md`);
    expect(content).toContain('## Later\nKeep this.');
    expect(content).not.toContain('Core rules:');
    expect(content).not.toContain('task_description');
  });

  test('Claude bootstrap preserves CRLF while migrating a legacy body', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    const original = `# Existing instructions\n\n${legacyClaudeMemorySection(claudeDir)}\n\n## Later\nKeep this.\n`;
    writeFileSync(claudeMd, original.replace(/\n/g, '\r\n'));

    const result = run('recall_configure_claude_md');

    expect(result.status).toBe(0);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('<!-- RECALL_MANAGED_MEMORY -->\r\n');
    expect(content).toContain('## Later\r\nKeep this.');
    expect(content.replace(/\r\n/g, '')).not.toContain('\n');
  });

  test('Claude bootstrap defers entirely to an externally managed memory rule', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    const original = '# Existing instructions\n';
    mkdirSync(join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(join(claudeDir, 'rules', 'memory.md'), '# MEMORY\nUse `/Users/test/.claude/Recall_GUIDE.md` and the live `recall-memory` schemas.\n');
    writeFileSync(claudeMd, original);

    const result = run('recall_configure_claude_md');

    expect(result.status).toBe(0);
    expect(readFileSync(claudeMd, 'utf-8')).toBe(original);
  });

  test('external Recall rule preserves legacy and marked CLAUDE sections byte-for-byte', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    mkdirSync(join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(join(claudeDir, 'rules', 'memory.md'), '# MEMORY\nUse Recall_GUIDE.md and live `recall-memory` schemas.\n');

    for (const memorySection of [
      legacyClaudeMemorySection(claudeDir),
      '## MEMORY\n<!-- RECALL_MANAGED_MEMORY -->\n\nOld Recall pointer.',
    ]) {
      const original = `# Existing instructions\n\n${memorySection}\n`;
      writeFileSync(claudeMd, original);

      const result = run('recall_configure_claude_md');

      expect(result.status).toBe(0);
      expect(readFileSync(claudeMd, 'utf-8')).toBe(original);
    }
  });

  test('an unrelated memory rule does not suppress the Recall pointer', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    mkdirSync(join(claudeDir, 'rules'), { recursive: true });
    writeFileSync(join(claudeDir, 'rules', 'memory.md'), '# Personal memory conventions\n');
    writeFileSync(claudeMd, '# Existing instructions\n');

    const result = run('recall_configure_claude_md');

    expect(result.status).toBe(0);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('## MEMORY');
    expect(content).toContain(`${claudeDir}/Recall_GUIDE.md`);
  });

  test('Claude bootstrap preserves a customized MEMORY section', () => {
    const claudeMd = join(claudeDir, 'CLAUDE.md');
    const original = '# Existing instructions\n\n## MEMORY\nKeep my custom workflow.\n';
    writeFileSync(claudeMd, original);

    const result = run('recall_configure_claude_md');

    expect(result.status).toBe(0);
    expect(readFileSync(claudeMd, 'utf-8')).toBe(original);
  });

  test('Pi bootstrap adds only a canonical-guide pointer', () => {
    const agentsMd = join(piConfigDir, 'AGENTS.md');
    writeFileSync(agentsMd, '# Existing Pi instructions\n');

    const result = run('recall_install_pi_guide');
    expect(result.status).toBe(0);
    const content = readFileSync(agentsMd, 'utf-8');

    expect(content).toContain('# Existing Pi instructions\n\n## MEMORY');
    expect(content).toContain('<!-- RECALL_MANAGED_MEMORY -->');
    expect(content).toContain('~/.pi/agent/Recall_GUIDE.md');
    expect(content).toContain('live `recall-memory` MCP schemas');
    expect(content).not.toContain('Core rules:');
    expect(content).not.toContain('task_description');
  });

  test('Pi bootstrap migrates the exact pre-marker legacy body', () => {
    const agentsMd = join(piConfigDir, 'AGENTS.md');
    writeFileSync(agentsMd, `# Existing Pi instructions\n\n${legacyPiMemorySection}\n\n## Later\nKeep this.\n`);

    const result = run('recall_install_pi_guide');

    expect(result.status).toBe(0);
    const content = readFileSync(agentsMd, 'utf-8');
    expect(content).toContain('# Existing Pi instructions');
    expect(content).toContain('<!-- RECALL_MANAGED_MEMORY -->');
    expect(content).toContain('~/.pi/agent/Recall_GUIDE.md');
    expect(content).toContain('## Later\nKeep this.');
    expect(content).not.toContain('Core rules:');
    expect(content).not.toContain('task_description');
  });

  test('Pi bootstrap preserves a customized MEMORY section', () => {
    const agentsMd = join(piConfigDir, 'AGENTS.md');
    const original = '# Existing Pi instructions\n\n## MEMORY\nKeep my custom Pi workflow.\n';
    writeFileSync(agentsMd, original);

    const result = run('recall_install_pi_guide');

    expect(result.status).toBe(0);
    expect(readFileSync(agentsMd, 'utf-8')).toBe(original);
  });
});
