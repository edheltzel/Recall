// Regression: uninstall.sh must remove Recall surgically, preserving user
// data by default and scrubbing only Recall's entries from settings.json.
//
// The script is driven against a tmpdir-scoped CLAUDE_DIR populated with a
// realistic mix of Recall files + unrelated user content. We shell out to
// `bash uninstall.sh --no-confirm [--purge]` with CLAUDE_DIR overridden.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { legacyClaudeMemorySection, legacyPiMemorySection } from '../fixtures/legacy-memory-sections';

const REPO = process.cwd();
const UNINSTALL = join(REPO, 'uninstall.sh');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runUninstall(
  claudeDir: string,
  backupBase: string,
  extraArgs: string[] = [],
): RunResult {
  const r = spawnSync(
    'bash',
    [UNINSTALL, '--no-confirm', '--skip-opencode', '--skip-pi', ...extraArgs],
    {
      encoding: 'utf-8',
      cwd: REPO,
      env: {
        ...process.env,
        CLAUDE_DIR: claudeDir,
        BACKUP_BASE: backupBase,
        HOME: claudeDir, // ~ -> tmp (avoids touching real $HOME binaries)
        // bun unlink / npm unlink -g operate on the host's global registry
        // regardless of CLAUDE_DIR. Skip them so the test suite doesn't wipe
        // the developer's live `recall` link.
        RECALL_SKIP_BUN_UNLINK: 'true',
      },
    },
  );
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? 1,
  };
}

function runUninstallIncludingPi(
  claudeDir: string,
  backupBase: string,
  piConfigDir: string,
): RunResult {
  const result = spawnSync(
    'bash',
    [UNINSTALL, '--no-confirm', '--skip-opencode'],
    {
      encoding: 'utf-8',
      cwd: REPO,
      env: {
        ...process.env,
        CLAUDE_DIR: claudeDir,
        BACKUP_BASE: backupBase,
        PI_CONFIG_DIR: piConfigDir,
        HOME: claudeDir,
        RECALL_SKIP_BUN_UNLINK: 'true',
      },
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function runUninstallIncludingOpenCode(
  claudeDir: string,
  backupBase: string,
  opencodeConfigDir: string,
): RunResult {
  const result = spawnSync(
    'bash',
    [UNINSTALL, '--no-confirm', '--skip-pi'],
    {
      encoding: 'utf-8',
      cwd: REPO,
      env: {
        ...process.env,
        CLAUDE_DIR: claudeDir,
        BACKUP_BASE: backupBase,
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
        HOME: claudeDir,
        RECALL_SKIP_BUN_UNLINK: 'true',
      },
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function runUninstallAll(
  claudeDir: string,
  backupBase: string,
  opencodeConfigDir: string,
  piConfigDir: string,
  unlinkMarker: string,
  fakeBin: string,
): RunResult {
  const result = spawnSync(
    'bash',
    [UNINSTALL, '--no-confirm', '--skip-omp'],
    {
      encoding: 'utf-8',
      cwd: REPO,
      env: {
        ...process.env,
        CLAUDE_DIR: claudeDir,
        BACKUP_BASE: backupBase,
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
        PI_CONFIG_DIR: piConfigDir,
        HOME: claudeDir,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        RECALL_TEST_UNLINK: unlinkMarker,
      },
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('uninstall.sh', () => {
  let tempRoot: string;
  let claudeDir: string;
  let backupBase: string;
  let settingsFile: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'recall-uninstall-'));
    claudeDir = join(tempRoot, '.claude');
    backupBase = join(claudeDir, 'backups', 'recall');

    mkdirSync(join(claudeDir, 'hooks', 'lib'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands', 'recall'), { recursive: true });
    mkdirSync(join(claudeDir, 'MEMORY'), { recursive: true });
    mkdirSync(backupBase, { recursive: true });

    // Drop a faux installed payload.
    writeFileSync(join(claudeDir, 'hooks', 'RecallExtract.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'RecallBatchExtract.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'RecallTelosSync.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'RecallStart.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'RecallPreCompact.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'lib', 'extraction-lock.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'lib', 'extraction-migration.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'lib', 'extraction-quality.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'lib', 'extraction-semaphore.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'lib', 'extraction-tracker.ts'), '// stub');
    writeFileSync(join(claudeDir, 'hooks', 'lib', 'pid-utils.ts'), '// stub');

    // Unrelated user hook file — MUST survive
    writeFileSync(join(claudeDir, 'hooks', 'lib', 'my-own-helper.ts'), '// user');
    writeFileSync(join(claudeDir, 'hooks', 'MyHook.ts'), '// user hook');

    // Slash commands + guide
    writeFileSync(join(claudeDir, 'commands', 'recall', 'search.md'), '# search');
    writeFileSync(join(claudeDir, 'Recall_GUIDE.md'), '# guide');

    // MEMORY directory — preserved
    writeFileSync(join(claudeDir, 'MEMORY', 'identity.md'), '# Ed');
    writeFileSync(join(claudeDir, 'MEMORY', 'DISTILLED.md'), '# distilled');

    // Matching extract_prompt.md in CLAUDE_DIR/MEMORY and repo/hooks/
    const promptSrc = readFileSync(join(REPO, 'hooks', 'extract_prompt.md'));
    writeFileSync(join(claudeDir, 'MEMORY', 'extract_prompt.md'), promptSrc);

    // memory.db stub
    writeFileSync(join(claudeDir, 'memory.db'), '\x00stubdb');

    // Backup
    mkdirSync(join(backupBase, '20260101_000000'), { recursive: true });
    writeFileSync(join(backupBase, '20260101_000000', 'manifest.txt'), 'stub');

    // settings.json with Recall entries + unrelated user entries
    settingsFile = join(claudeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'bun run /path/RecallExtract.ts' }],
              },
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'bun run /path/MyHook.ts' }],
              },
            ],
            SessionStart: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'bun run /path/RecallStart.ts' }],
              },
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'bun run /path/RecallTelosSync.ts' }],
              },
            ],
            PreCompact: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'bun run /path/RecallPreCompact.ts' }],
              },
            ],
            UserPromptSubmit: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'bun run /path/UserHook.ts' }],
              },
            ],
          },
          mcpServers: {
            'recall-memory': { command: 'bun', args: ['run', '/path/recall-mcp'] },
            'other-server': { command: 'other', args: [] },
          },
        },
        null,
        2,
      ),
    );

    // CLAUDE.md with user content + MEMORY section
    writeFileSync(
      join(claudeDir, 'CLAUDE.md'),
      `# Ed's global instructions

## Style

Terse, surgical, precise.

## MEMORY

<!-- RECALL_MANAGED_MEMORY -->
Read and follow the canonical Recall guide at \`~/.claude/Recall_GUIDE.md\`.

## After-memory section

This content must be preserved across an uninstall.
`,
    );
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('preserve-default: removes Recall artifacts, keeps user data', () => {
    const r = runUninstall(claudeDir, backupBase);
    expect(r.status).toBe(0);

    // Recall files removed
    expect(existsSync(join(claudeDir, 'hooks', 'RecallExtract.ts'))).toBe(false);
    expect(existsSync(join(claudeDir, 'hooks', 'RecallStart.ts'))).toBe(false);
    expect(existsSync(join(claudeDir, 'hooks', 'RecallTelosSync.ts'))).toBe(false);
    expect(existsSync(join(claudeDir, 'hooks', 'RecallPreCompact.ts'))).toBe(false);
    expect(existsSync(join(claudeDir, 'hooks', 'RecallBatchExtract.ts'))).toBe(false);
    expect(existsSync(join(claudeDir, 'hooks', 'lib', 'extraction-lock.ts'))).toBe(false);
    expect(existsSync(join(claudeDir, 'hooks', 'lib', 'pid-utils.ts'))).toBe(false);
    expect(existsSync(join(claudeDir, 'commands', 'recall'))).toBe(false);
    expect(existsSync(join(claudeDir, 'Recall_GUIDE.md'))).toBe(false);
    expect(existsSync(join(claudeDir, 'MEMORY', 'extract_prompt.md'))).toBe(false);

    // User files preserved
    expect(existsSync(join(claudeDir, 'hooks', 'MyHook.ts'))).toBe(true);
    expect(existsSync(join(claudeDir, 'hooks', 'lib', 'my-own-helper.ts'))).toBe(true);
    expect(existsSync(join(claudeDir, 'MEMORY', 'identity.md'))).toBe(true);
    expect(existsSync(join(claudeDir, 'MEMORY', 'DISTILLED.md'))).toBe(true);

    // Preserved by default
    expect(existsSync(join(claudeDir, 'memory.db'))).toBe(true);
    expect(existsSync(backupBase)).toBe(true);
    expect(existsSync(join(backupBase, '20260101_000000'))).toBe(true);
  });

  test('surgical settings.json filter: removes only Recall entries', () => {
    runUninstall(claudeDir, backupBase);

    const s = JSON.parse(readFileSync(settingsFile, 'utf-8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      mcpServers?: Record<string, unknown>;
    };

    const commands = (event: string): string[] =>
      (s.hooks?.[event] ?? []).flatMap(e => (e.hooks ?? []).map(h => h.command ?? ''));

    // Recall commands filtered
    expect(commands('Stop').some(c => c.includes('RecallExtract'))).toBe(false);
    expect(commands('SessionStart').some(c => c.includes('RecallStart'))).toBe(false);
    expect(commands('SessionStart').some(c => c.includes('RecallTelosSync'))).toBe(false);
    // PreCompact key removed entirely (all entries were Recall)
    expect(s.hooks?.PreCompact).toBeUndefined();

    // User commands preserved
    expect(commands('Stop').some(c => c.includes('MyHook'))).toBe(true);
    expect(commands('UserPromptSubmit').some(c => c.includes('UserHook'))).toBe(true);

    // mcpServers: recall-memory removed, other-server kept
    expect(s.mcpServers?.['recall-memory']).toBeUndefined();
    expect(s.mcpServers?.['other-server']).toBeDefined();
  });

  test('CLAUDE.md: Recall-managed MEMORY section removed, other sections preserved', () => {
    runUninstall(claudeDir, backupBase);
    const content = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('## MEMORY');
    expect(content).toContain("# Ed's global instructions");
    expect(content).toContain('## Style');
    expect(content).toContain('## After-memory section');
    expect(content).toContain('This content must be preserved');
  });

  test('CLAUDE.md: legacy Recall-generated MEMORY section is removed', () => {
    const legacySection = legacyClaudeMemorySection(claudeDir);
    writeFileSync(
      join(claudeDir, 'CLAUDE.md'),
      `# Existing instructions

${legacySection}

## After-memory section

Preserve this.
`,
    );

    const result = runUninstall(claudeDir, backupBase);

    expect(result.status).toBe(0);
    const content = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('## MEMORY');
    expect(content).toContain('## After-memory section');
    expect(content).toContain('Preserve this.');
  });

  test('CLAUDE.md: externally owned MEMORY section is preserved', () => {
    const pointer = "Recall's Claude operating contract is loaded from `~/.claude/rules/memory.md`.";
    writeFileSync(
      join(claudeDir, 'CLAUDE.md'),
      `# Existing instructions

## MEMORY

${pointer}

## After-memory section

Preserve this.
`,
    );

    const result = runUninstall(claudeDir, backupBase);

    expect(result.status).toBe(0);
    const content = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('## MEMORY');
    expect(content).toContain(pointer);
    expect(content).toContain('## After-memory section');
  });

  test('CLAUDE.md: customized section retaining the legacy sentence is preserved', () => {
    const custom = `You have persistent memory via Recall. **Read the full guide:** ${claudeDir}/Recall_GUIDE.md

Custom memory policy that Recall did not generate.`;
    writeFileSync(
      join(claudeDir, 'CLAUDE.md'),
      `# Existing instructions

## MEMORY

${custom}

## After-memory section

Preserve this.
`,
    );

    const result = runUninstall(claudeDir, backupBase);

    expect(result.status).toBe(0);
    const content = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('## MEMORY');
    expect(content).toContain(custom);
    expect(content).toContain('## After-memory section');
  });

  test('Pi AGENTS.md: complete legacy Recall section is removed', () => {
    const piConfigDir = join(tempRoot, '.pi', 'agent');
    mkdirSync(piConfigDir, { recursive: true });
    const legacyPiSection = legacyPiMemorySection;
    writeFileSync(
      join(piConfigDir, 'AGENTS.md'),
      `# Existing Pi instructions

${legacyPiSection}

## After-memory section

Preserve this.
`,
    );

    const result = runUninstallIncludingPi(claudeDir, backupBase, piConfigDir);

    expect(result.status).toBe(0);
    const content = readFileSync(join(piConfigDir, 'AGENTS.md'), 'utf-8');
    expect(content).not.toContain('## MEMORY');
    expect(content).toContain('## After-memory section');
    expect(content).toContain('Preserve this.');
  });

  test('Pi AGENTS.md: customized legacy-looking section is preserved', () => {
    const piConfigDir = join(tempRoot, '.pi', 'agent');
    mkdirSync(piConfigDir, { recursive: true });
    const custom = `You have persistent memory via Recall. **Read the full guide:** ~/.pi/agent/Recall_GUIDE.md

Custom Pi memory policy that Recall did not generate.`;
    writeFileSync(
      join(piConfigDir, 'AGENTS.md'),
      `# Existing Pi instructions

## MEMORY

${custom}

## After-memory section

Preserve this.
`,
    );

    const result = runUninstallIncludingPi(claudeDir, backupBase, piConfigDir);

    expect(result.status).toBe(0);
    const content = readFileSync(join(piConfigDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('## MEMORY');
    expect(content).toContain(custom);
    expect(content).toContain('## After-memory section');
  });

  test('--purge: destroys memory.db and backups, keeps MEMORY/', () => {
    // Interactive purge confirmation: pipe "PURGE\n" via stdin.
    const r = spawnSync(
      'bash',
      [UNINSTALL, '--purge', '--no-confirm', '--skip-opencode', '--skip-pi'],
      {
        encoding: 'utf-8',
        cwd: REPO,
        input: 'PURGE\n',
        env: {
          ...process.env,
          CLAUDE_DIR: claudeDir,
          BACKUP_BASE: backupBase,
          HOME: claudeDir,
          RECALL_SKIP_BUN_UNLINK: 'true',
        },
      },
    );
    expect(r.status).toBe(0);

    expect(existsSync(join(claudeDir, 'memory.db'))).toBe(false);

    // Pre-purge snapshot was written under BACKUP_BASE
    const entries = require('fs').readdirSync(backupBase) as string[];
    expect(entries.some(e => e.startsWith('pre_purge_'))).toBe(true);

    // Old backup dir gone
    expect(existsSync(join(backupBase, '20260101_000000'))).toBe(false);

    // MEMORY/ preserved even on --purge
    expect(existsSync(join(claudeDir, 'MEMORY', 'identity.md'))).toBe(true);
  });

  test('--dry-run: narrates but does not mutate', () => {
    const r = runUninstall(claudeDir, backupBase, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY-RUN');

    // Everything still present
    expect(existsSync(join(claudeDir, 'hooks', 'RecallExtract.ts'))).toBe(true);
    expect(existsSync(join(claudeDir, 'hooks', 'RecallStart.ts'))).toBe(true);
    expect(existsSync(join(claudeDir, 'commands', 'recall'))).toBe(true);
    expect(existsSync(join(claudeDir, 'Recall_GUIDE.md'))).toBe(true);
    expect(existsSync(join(claudeDir, 'memory.db'))).toBe(true);

    // settings.json untouched
    const s = JSON.parse(readFileSync(settingsFile, 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(s.mcpServers?.['recall-memory']).toBeDefined();
  });

  test('OpenCode uninstall preserves JSONC comments and unrelated MCP entries', () => {
    const opencodeConfigDir = join(tempRoot, 'opencode');
    mkdirSync(opencodeConfigDir, { recursive: true });
    const opencodeConfig = join(opencodeConfigDir, 'opencode.json');
    const original = `{
  // Keep this user comment.
  "mcp": {
    "recall-memory": {
      "type": "local",
      "command": ["bun", "run", "/tmp/recall-mcp"]
    },
    "other-server": {
      "type": "remote",
      "url": "https://example.test/mcp",
    },
  },
}
`;
    writeFileSync(opencodeConfig, original);

    const result = runUninstallIncludingOpenCode(claudeDir, backupBase, opencodeConfigDir);

    expect(result.status).toBe(0);
    const after = readFileSync(opencodeConfig, 'utf-8');
    expect(after).toContain('// Keep this user comment.');
    expect(after).toContain('other-server');
    expect(after).toContain('https://example.test/mcp');
    expect(after).not.toContain('recall-memory');
    expect(`${result.stdout}${result.stderr}`).not.toContain('left unchanged');
  });

  test('OpenCode uninstall rejects malformed config without writing', () => {
    const opencodeConfigDir = join(tempRoot, 'opencode-malformed');
    mkdirSync(opencodeConfigDir, { recursive: true });
    const opencodeConfig = join(opencodeConfigDir, 'opencode.json');
    const original = '{ "mcp": { "recall-memory": { } }';
    writeFileSync(opencodeConfig, original);

    const result = runUninstallIncludingOpenCode(claudeDir, backupBase, opencodeConfigDir);

    expect(result.status).toBe(0);
    expect(readFileSync(opencodeConfig, 'utf-8')).toBe(original);
  });

  test('malformed OpenCode JSONC does not abort the remaining uninstall', () => {
    const opencodeConfigDir = join(tempRoot, 'opencode-malformed-continuation');
    const piConfigDir = join(tempRoot, 'pi');
    const fakeBin = join(tempRoot, 'bin');
    const unlinkMarker = join(tempRoot, 'bun-unlink-called');
    mkdirSync(opencodeConfigDir, { recursive: true });
    mkdirSync(piConfigDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const opencodeConfig = join(opencodeConfigDir, 'opencode.json');
    const malformed = '{ "mcp": { "recall-memory": { } }';
    writeFileSync(opencodeConfig, malformed);
    const piConfig = join(piConfigDir, 'mcp.json');
    writeFileSync(piConfig, JSON.stringify({ mcpServers: { 'recall-memory': { command: 'recall-mcp' } } }));
    writeFileSync(
      join(fakeBin, 'bun'),
      `#!/bin/sh\nif [ "$1" = unlink ]; then touch "$RECALL_TEST_UNLINK"; exit 0; fi\nexec ${process.execPath} "$@"\n`,
      { mode: 0o755 },
    );

    const result = runUninstallAll(claudeDir, backupBase, opencodeConfigDir, piConfigDir, unlinkMarker, fakeBin);

    expect(result.status).toBe(0);
    expect(readFileSync(opencodeConfig, 'utf-8')).toBe(malformed);
    expect(JSON.parse(readFileSync(piConfig, 'utf-8')).mcpServers).toBeUndefined();
    expect(existsSync(unlinkMarker)).toBe(true);
    expect(result.stdout).toContain('Uninstall Complete');
  });
});
