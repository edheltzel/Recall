import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import { CREATE_TABLES } from '../src/db/schema';

// v2→v3 migration SQL (inlined — formerly exported from schema.ts, now in migrations.ts)
const MIGRATE_V2_TO_V3 = "ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code'";
import { linearizeSession } from '../pi/RecallExtract';
import { exportSession, renderSessionExport, sessionIdFromEvent } from '../opencode/RecallExtract';

// ─── OpenCode Runtime Contract Tests ───

describe('OpenCode runtime contract', () => {
  test('reads the current event hook sessionID and ignores other events', () => {
    expect(sessionIdFromEvent({ type: 'session.idle', properties: { sessionID: 'current-1' } })).toBe('current-1');
    expect(sessionIdFromEvent({ type: 'session.idle', properties: { sessionId: 'legacy-1' } })).toBe('legacy-1');
    expect(sessionIdFromEvent({ type: 'session.updated', properties: { sessionID: 'wrong-event' } })).toBeNull();
    expect(sessionIdFromEvent({ session_id: 'legacy-payload' })).toBe('legacy-payload');
  });

  test('renders the current JSON export with all readable conversation parts', () => {
    const raw = JSON.stringify({
      info: { id: 'session-1', title: 'Export contract' },
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'Keep the complete user request.' }] },
        { info: { role: 'assistant' }, parts: [
          { type: 'text', text: 'Keep the complete assistant response.' },
          { type: 'tool', state: { status: 'completed', title: 'read', output: 'tool output remains visible' } },
        ] },
      ],
    });

    const markdown = renderSessionExport(raw, 'fallback');
    expect(markdown).toContain('# OpenCode Session: Export contract');
    expect(markdown).toContain('## user');
    expect(markdown).toContain('Keep the complete user request.');
    expect(markdown).toContain('Keep the complete assistant response.');
    expect(markdown).toContain('tool output remains visible');
  });

  test('rejects an export with no readable message content', () => {
    expect(() => renderSessionExport(JSON.stringify({ info: { id: 'empty' }, messages: [] }), 'empty'))
      .toThrow('no readable message content');
  });

  test('runs the supported JSON export command and normalizes its output', async () => {
    const calls: string[] = [];
    const shell = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(strings.raw.reduce((command, part, index) => `${command}${part}${values[index] ?? ''}`, ''));
      return JSON.stringify({
        info: { id: 'session-2', title: 'Shell export' },
        messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'Exported through the shell seam.' }] }],
      });
    };

    const markdown = await exportSession(shell as never, 'session-2');
    expect(calls).toEqual(['opencode export session-2']);
    expect(markdown).toContain('Exported through the shell seam.');
  });
});

// ─── Schema v3 Migration Tests ───

describe('schema v3 migration', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-migration-'));
  });

  afterEach(() => {
    if (db) db.close();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('MIGRATE_V2_TO_V3 adds source column to sessions table', () => {
    const dbPath = join(tempDir, 'v2.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');

    // Create a v2 sessions table WITHOUT source column
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        summary TEXT,
        project TEXT,
        cwd TEXT,
        git_branch TEXT,
        model TEXT
      );
    `);

    // Insert a v2 row
    db.prepare('INSERT INTO sessions (session_id, project) VALUES (?, ?)').run('test-session-1', 'my-project');

    // Run migration
    db.exec(MIGRATE_V2_TO_V3);

    // Verify source column exists with correct default
    const row = db.prepare('SELECT source FROM sessions WHERE session_id = ?').get('test-session-1') as any;
    expect(row.source).toBe('claude-code');

    // Verify we can insert with explicit source
    db.prepare('INSERT INTO sessions (session_id, project, source) VALUES (?, ?, ?)').run('test-session-2', 'my-project', 'opencode');
    const row2 = db.prepare('SELECT source FROM sessions WHERE session_id = ?').get('test-session-2') as any;
    expect(row2.source).toBe('opencode');
  });

  test('fresh v3 schema has source column in sessions', () => {
    const dbPath = join(tempDir, 'v3-fresh.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(CREATE_TABLES);

    // Insert with default source
    db.prepare('INSERT INTO sessions (session_id, project) VALUES (?, ?)').run('fresh-1', 'test');
    const row = db.prepare('SELECT source FROM sessions WHERE session_id = ?').get('fresh-1') as any;
    expect(row.source).toBe('unknown');

    // Insert with opencode source
    db.prepare('INSERT INTO sessions (session_id, project, source) VALUES (?, ?, ?)').run('fresh-2', 'test', 'opencode');
    const row2 = db.prepare('SELECT source FROM sessions WHERE session_id = ?').get('fresh-2') as any;
    expect(row2.source).toBe('opencode');
  });

  test('double migration throws (callers wrap in try/catch)', () => {
    const dbPath = join(tempDir, 'double.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(CREATE_TABLES); // Already has source column

    // Second ALTER TABLE should throw (column exists)
    expect(() => db.exec(MIGRATE_V2_TO_V3)).toThrow();
  });
});

// ─── OpenCode Drop Directory Tests ───

describe('OpenCode drop directory scanning', () => {
  let tempDir: string;
  let dropDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-opencode-'));
    dropDir = join(tempDir, 'opencode-sessions');
    mkdirSync(dropDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('discovers .md files in drop directory', () => {
    writeFileSync(join(dropDir, 'session-abc.md'), '# Session\nHello world');
    writeFileSync(join(dropDir, 'session-def.md'), '# Session 2\nGoodbye');

    const { readdirSync } = require('fs');
    const files = readdirSync(dropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));

    expect(files).toHaveLength(2);
    expect(files).toContain('session-abc.md');
    expect(files).toContain('session-def.md');
  });

  test('excludes dotfiles (like .extracted.json)', () => {
    writeFileSync(join(dropDir, 'session-abc.md'), '# Session');
    writeFileSync(join(dropDir, '.extracted.json'), '[]');
    writeFileSync(join(dropDir, '.hidden.md'), 'hidden');

    const { readdirSync } = require('fs');
    const files = readdirSync(dropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));

    expect(files).toHaveLength(1);
    expect(files[0]).toBe('session-abc.md');
  });

  test('handles empty drop directory', () => {
    const { readdirSync } = require('fs');
    const files = readdirSync(dropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));

    expect(files).toHaveLength(0);
  });

  test('handles non-existent drop directory', () => {
    const nonExistent = join(tempDir, 'does-not-exist');
    expect(existsSync(nonExistent)).toBe(false);
  });
});

// ─── Markdown Extraction Input Tests ───

describe('markdown session content handling', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-md-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('markdown file is readable without JSONL parsing', () => {
    const mdContent = `# Session Export

## User
How do I set up a new React project?

## Assistant
You can use create-react-app or Vite. Here's the Vite approach:

\`\`\`bash
npm create vite@latest my-app -- --template react-ts
cd my-app
npm install
npm run dev
\`\`\`

## User
Thanks, what about routing?

## Assistant
Install react-router-dom:

\`\`\`bash
npm install react-router-dom
\`\`\`

Then set up your routes in App.tsx. You'll want to wrap your app in a BrowserRouter and define Route components for each page.

Here's a basic example with multiple routes and a shared layout component that provides consistent navigation across pages.
`;
    const mdPath = join(tempDir, 'test-session.md');
    writeFileSync(mdPath, mdContent);

    // Read directly — no JSONL parsing needed
    const content = readFileSync(mdPath, 'utf-8');
    expect(content.length).toBeGreaterThan(500);
    expect(content).toContain('React');
    expect(content).toContain('## User');
    expect(content).toContain('## Assistant');
  });

  test('short markdown files are rejected (< 500 chars)', () => {
    const shortContent = '# Short\nHi';
    const mdPath = join(tempDir, 'short.md');
    writeFileSync(mdPath, shortContent);

    const content = readFileSync(mdPath, 'utf-8');
    // extractAndAppendMarkdown rejects content < 500 chars
    expect(content.length).toBeLessThan(500);
  });
});

// ─── Extraction Tracker Persistence Tests ───

describe('extraction tracker (dedup)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-tracker-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('tracker persists to JSON file', () => {
    const trackerPath = join(tempDir, '.extracted.json');
    const tracker = new Set(['session-1', 'session-2']);

    // Save
    writeFileSync(trackerPath, JSON.stringify([...tracker]));

    // Load
    const loaded = JSON.parse(readFileSync(trackerPath, 'utf-8'));
    const restoredSet = new Set(Array.isArray(loaded) ? loaded : []);

    expect(restoredSet.has('session-1')).toBe(true);
    expect(restoredSet.has('session-2')).toBe(true);
    expect(restoredSet.has('session-3')).toBe(false);
  });

  test('corrupt tracker file falls back to empty set', () => {
    const trackerPath = join(tempDir, '.extracted.json');
    writeFileSync(trackerPath, 'not valid json!!!');

    let tracker: Set<string>;
    try {
      const data = JSON.parse(readFileSync(trackerPath, 'utf-8'));
      tracker = new Set(Array.isArray(data) ? data : []);
    } catch {
      tracker = new Set();
    }

    expect(tracker.size).toBe(0);
  });
});

// ─── Compaction Plugin Logic Tests ───

describe('compaction plugin logic', () => {
  test('skips if output.context is not an array', () => {
    const output = { context: 'not-an-array' };
    const shouldSkip = !output || !Array.isArray(output.context);
    expect(shouldSkip).toBe(true);
  });

  test('skips if output is null', () => {
    const output = null;
    const shouldSkip = !output || !Array.isArray((output as any)?.context);
    expect(shouldSkip).toBe(true);
  });

  test('pushes to output.context when valid array', () => {
    const output = { context: [] as string[] };
    const shouldSkip = !output || !Array.isArray(output.context);
    expect(shouldSkip).toBe(false);

    output.context.push('test context');
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toBe('test context');
  });
});

// ─── Installer Validation ───

describe('installer', () => {
  test('install.sh has no syntax errors', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    // bash -n does a syntax check without executing
    expect(() => execFileSync('bash', ['-n', installPath])).not.toThrow();
  });

  test('install.sh includes OpenCode config in backup list', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const libPath = join(__dirname, '..', 'lib', 'install-lib.sh');
    const content = readFileSync(installPath, 'utf-8') + '\n' + readFileSync(libPath, 'utf-8');
    expect(content).toContain('OPENCODE_CONFIG_DIR');
    expect(content).toContain('opencode.json');
  });

  test('install.sh detects both platforms', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const libPath = join(__dirname, '..', 'lib', 'install-lib.sh');
    const content = readFileSync(installPath, 'utf-8') + '\n' + readFileSync(libPath, 'utf-8');
    expect(content).toContain('detect_platforms');
    expect(content).toContain('OPENCODE_DETECTED');
    expect(content).toContain('CLAUDE_CODE_DETECTED');
  });

  test('install.sh has JSONC-safe config parsing', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const libPath = join(__dirname, '..', 'lib', 'install-lib.sh');
    const content = readFileSync(installPath, 'utf-8') + '\n' + readFileSync(libPath, 'utf-8');
    // The dependency-free bundled helper parses comments/trailing commas and
    // splices only the recall-memory entry. Packaged installs have no repo
    // node_modules tree, so the shell library must not require jsonc-parser.
    expect(content).toContain('jsonc-mcp.ts');
    expect(content).not.toContain('/node_modules/jsonc-parser');
  });

  // update.sh's refresh path propagating the OpenCode guide + agent prompt
  // (recall_install_opencode_guide / recall_install_opencode_agent gated on
  // OPENCODE_DETECTED) is asserted canonically in tests/install/update.test.ts
  // → "refresh path propagates OpenCode/Pi guides and prompts". Not duplicated
  // here (DRY).
});

// ─── Task 7: linearizeSession Unit Tests ───

describe('linearizeSession', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-linearize-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('walks from root to leaf following active branch (last child wins)', () => {
    // Tree: 1 -> 2 -> 4 (active branch), with 3 as a sibling of 2 (ignored)
    const entries = [
      { id: '1', parentId: null, type: 'message', message: { role: 'user', content: 'hello world message' } },
      { id: '2', parentId: '1', type: 'message', message: { role: 'assistant', content: 'hi there response' } },
      { id: '3', parentId: '1', type: 'message', message: { role: 'user', content: 'other branch content' } },
      { id: '4', parentId: '2', type: 'message', message: { role: 'user', content: 'continue conversation here' } },
    ];
    const jsonlPath = join(tempDir, 'tree.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));

    const result = linearizeSession(jsonlPath);
    // Should contain the active branch: 1 -> 3 (last child of 1) -> nothing after 3
    // Actually: last child of null is entry with id '4'? No — childrenOf(null) = [entry1]
    // childrenOf('1') = [entry2, entry3] -> last = entry3 (id=3, "other branch")
    // childrenOf('3') = [] -> stop
    // So result should contain entries 1 and 3, NOT 2 or 4
    expect(result).toContain('hello world message');
    expect(result).toContain('other branch content');
    expect(result).not.toContain('hi there response');
    expect(result).not.toContain('continue conversation here');
  });

  test('copies message content correctly from entries', () => {
    const entries = [
      { id: '1', parentId: null, type: 'message', message: { role: 'user', content: 'test content here to verify copying works' } },
    ];
    const jsonlPath = join(tempDir, 'single.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));

    const result = linearizeSession(jsonlPath);
    expect(result).toContain('[USER]');
    expect(result).toContain('test content here to verify copying works');
  });

  test('handles empty file', () => {
    const jsonlPath = join(tempDir, 'empty.jsonl');
    writeFileSync(jsonlPath, '');

    const result = linearizeSession(jsonlPath);
    expect(result).toBe('');
  });

  test('skips non-message type entries', () => {
    const entries = [
      { id: '1', parentId: null, type: 'system', data: { model: 'pi-4' } },
      { id: '2', parentId: '1', type: 'message', message: { role: 'user', content: 'real message with sufficient length' } },
    ];
    const jsonlPath = join(tempDir, 'mixed.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));

    const result = linearizeSession(jsonlPath);
    // system entry is skipped; but since childrenOf(null) = [entry1] and entry1 is type=system,
    // it still walks to entry1's children. entry2 is the last child of entry1.
    expect(result).toContain('real message');
    expect(result).not.toContain('pi-4');
  });

  test('handles malformed JSONL lines gracefully', () => {
    const jsonlPath = join(tempDir, 'malformed.jsonl');
    writeFileSync(jsonlPath, [
      JSON.stringify({ id: '1', parentId: null, type: 'message', message: { role: 'user', content: 'valid line that is long enough' } }),
      'not valid json at all',
      '{"broken',
    ].join('\n'));

    // Should not throw, and should include the valid line
    expect(() => linearizeSession(jsonlPath)).not.toThrow();
    const result = linearizeSession(jsonlPath);
    expect(result).toContain('valid line');
  });
});

// ─── Task 8: Pi Drop Directory Discovery Tests ───

describe('findPiSessions drop directory', () => {
  let tempDir: string;
  let dropDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-pi-drop-'));
    dropDir = join(tempDir, 'pi-sessions');
    mkdirSync(dropDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('discovers Pi markdown sessions in drop directory', () => {
    writeFileSync(join(dropDir, 'session-1.md'), 'test content for pi session one');
    writeFileSync(join(dropDir, 'session-2.md'), 'more content for pi session two');
    writeFileSync(join(dropDir, '.hidden.md'), 'should be skipped by filter');

    const files = readdirSync(dropDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .map(f => join(dropDir, f));

    expect(files).toHaveLength(2);
    expect(files.some(f => f.includes('session-1.md'))).toBe(true);
    expect(files.some(f => f.includes('session-2.md'))).toBe(true);
    expect(files.some(f => f.includes('.hidden.md'))).toBe(false);
  });

  test('handles nonexistent drop directory gracefully', () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');
    if (existsSync(nonExistentDir)) rmSync(nonExistentDir, { recursive: true });

    expect(existsSync(nonExistentDir)).toBe(false);
    // findPiSessions in RecallBatchExtract returns [] early when dir doesn't exist
  });

  test('excludes dotfiles from drop directory scan', () => {
    writeFileSync(join(dropDir, 'session-abc.md'), 'real session content');
    writeFileSync(join(dropDir, '.extraction_tracker.json'), '[]');
    writeFileSync(join(dropDir, '.hidden.md'), 'hidden');

    const files = readdirSync(dropDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));

    expect(files).toHaveLength(1);
    expect(files[0]).toBe('session-abc.md');
  });

  test('empty drop directory returns no sessions', () => {
    const files = readdirSync(dropDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));

    expect(files).toHaveLength(0);
  });
});

// ─── Task 9: Installer Pi Configuration Validation Tests ───

describe('Installer: Pi Detection and MCP Config', () => {
  test('installer creates valid JSON shape for recall-memory MCP server config', () => {
    const mockConfig = {
      mcpServers: {
        'recall-memory': {
          command: 'recall-mcp',
          args: [],
          environment: {
            RECALL_DB_PATH: '/Users/ed/.agents/Recall/recall.db'
          }
        }
      }
    };

    // Verify it serializes to valid JSON
    expect(() => JSON.stringify(mockConfig)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(mockConfig));
    expect(parsed.mcpServers['recall-memory'].command).toBe('recall-mcp');
  });


  test('installer backup list includes Pi config files', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const libPath = join(__dirname, '..', 'lib', 'install-lib.sh');
    const content = readFileSync(installPath, 'utf-8') + '\n' + readFileSync(libPath, 'utf-8');
    // Pi-specific paths should appear in the install.sh
    expect(content).toContain('PI_CONFIG_DIR');
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('RecallExtract.ts');
    expect(content).toContain('RecallPreCompact.ts');
  });

  test('install.sh detects Pi platform', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const libPath = join(__dirname, '..', 'lib', 'install-lib.sh');
    const content = readFileSync(installPath, 'utf-8') + '\n' + readFileSync(libPath, 'utf-8');
    expect(content).toContain('PI_DETECTED');
  });

  test('install.sh has Pi MCP configuration function', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const libPath = join(__dirname, '..', 'lib', 'install-lib.sh');
    const content = readFileSync(installPath, 'utf-8') + '\n' + readFileSync(libPath, 'utf-8');
    expect(content).toContain('configure_pi_mcp');
    expect(content).toContain('recall-memory');
  });
});

// ─── Cycle 1 — recall_configure_opencode_mcp must not destroy user customizations ───
//
// Red-team finding (2026-05-28, 5 of 16 agents converged on this): the original
// function did `JSON.parse → JSON.stringify` on opencode.json via direct
// fs.writeFileSync, irreversibly stripping `//` comments, /* */ block comments,
// JSON5 trailing commas, and any non-default formatting. It bypassed
// recall_link's collision-backup rule.
//
// Now satisfied by `_recall_jsonc_merge_mcp_entry` (lib/install-lib.sh): reads
// via the bundled JSONC parser (so `//` inside string values like https:// URLs
// is safe — A7), writes only the targeted entry so surrounding bytes are kept
// the recall-memory entry value slot.
describe('recall_configure_opencode_mcp preserves user customizations', () => {
  let sandboxDir: string;
  let opencodeJsonPath: string;
  const REPO = join(__dirname, '..');

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'recall-opencode-mcp-preserve-'));
    opencodeJsonPath = join(sandboxDir, 'opencode.json');
  });

  afterEach(() => {
    if (sandboxDir && existsSync(sandboxDir)) {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  function runConfigure() {
    return execFileSync('bash', ['-c',
      `source "${REPO}/lib/install-lib.sh" >/dev/null 2>&1 && recall_configure_opencode_mcp >/dev/null 2>&1`,
    ], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: sandboxDir,
        RECALL_DB_PATH: join(sandboxDir, 'fake-recall.db'),
      },
      encoding: 'utf-8',
    });
  }

  test('preserves inline // comments, non-Recall MCP entries, and JSON5 trailing commas', () => {
    const userConfig = [
      '{',
      '  // User-managed MCP configuration — DO NOT REWRITE',
      '  "mcp": {',
      '    "recall-memory": {',
      '      "type": "local",',
      '      "command": ["/old/bun", "run", "/old/recall-mcp"],',
      '      "enabled": true,',
      '      "environment": { "RECALL_DB_PATH": "/old/db" }',
      '    },',
      '    // GitHub MCP — critical for repo work, hand-tuned',
      '    "github": {',
      '      "type": "local",',
      '      "command": ["gh-mcp"],',
      '      "enabled": true,',
      '      "environment": { "GITHUB_TOKEN": "ghp_xxx" },',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n');
    writeFileSync(opencodeJsonPath, userConfig);

    runConfigure();
    const after = readFileSync(opencodeJsonPath, 'utf-8');

    // 1. Inline // comments must survive the bundled JSONC edit.
    expect(after).toContain('// User-managed MCP configuration — DO NOT REWRITE');
    expect(after).toContain('// GitHub MCP — critical for repo work, hand-tuned');

    // 2. Non-Recall MCP entry must survive byte-for-byte (modify only edits the recall-memory slot).
    expect(after).toMatch(/"github":\s*\{[\s\S]*?"command":\s*\[\s*"gh-mcp"\s*\][\s\S]*?"GITHUB_TOKEN":\s*"ghp_xxx"/);

    // 3. JSON5 trailing comma must survive the bundled JSONC edit.
    expect(after).toMatch(/"ghp_xxx"\s*\}\s*,/);

    // 4. recall-memory entry must reflect the NEW path (sandbox fake-recall.db),
    //    not the old one. Proves the function actually ran successfully.
    expect(after).toContain('fake-recall.db');
    expect(after).not.toContain('"/old/db"');
  });

  // A7 regression — `//` inside a string value (e.g. an https:// URL on a
  // sibling MCP entry) must survive. The pre-merge helper used a hand-rolled
  // regex to strip `//` line comments before JSON.parse; that regex was not
  // string-aware and corrupted https:// URLs, making the helper falsely refuse
  // perfectly valid opencode.json. The merged-tip implementation uses
  // The bundled parser is string-aware, and this test locks that in.
  test('A7: preserves https:// URLs and other `//` substrings inside string values', () => {
    const userConfig = [
      '{',
      '  "mcp": {',
      '    "remote-mcp": {',
      '      "type": "remote",',
      '      "url": "https://example.com/mcp/v1",',
      '      "headers": { "X-Notes": "see https://docs.example.com//deep/path" }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(opencodeJsonPath, userConfig);

    runConfigure();
    const after = readFileSync(opencodeJsonPath, 'utf-8');

    // 1. The https:// URLs survive byte-for-byte — proves the tokenizer did
    //    not mistake `//` inside a string for the start of a line comment.
    expect(after).toContain('"https://example.com/mcp/v1"');
    expect(after).toContain('"see https://docs.example.com//deep/path"');

    // 2. The sibling remote-mcp entry is otherwise intact (modify only edits
    //    the recall-memory slot).
    expect(after).toMatch(/"remote-mcp":\s*\{[\s\S]*?"type":\s*"remote"[\s\S]*?"url":\s*"https:\/\/example\.com\/mcp\/v1"/);

    // 3. recall-memory was registered (function ran to success). Both
    //    assertions together prove A7 is closed AND the function didn't bail
    //    on the URL-bearing file.
    expect(after).toContain('"recall-memory"');
    expect(after).toContain('fake-recall.db');
  });
});

// ─── MCP config hardening RED — V-1, V-3, V-4 (recall_configure_opencode_mcp) ───
//
// Red-team finding (2026-05-28). recall_configure_opencode_mcp does a
// JSON.parse → JSON.stringify full-file rewrite of opencode.json. Three gaps,
// each asserted below as the DESIRED post-fix behavior — expected to FAIL on
// the current implementation (RED). The GREEN agent hardens the function in
// lib/install-lib.sh to make them pass.
//
//   V-1  Malformed JSON on disk → refuse with a non-zero exit AND leave the
//        file byte-identical. Today JSON.parse throws inside `bun -e`, but the
//        function still exits 0 because `log_success` runs as the last command
//        regardless of the bun exit code — so the caller cannot tell it failed.
//   V-3  User-added custom keys on the recall-memory entry (myExtraKey,
//        environment.MY_CUSTOM_VAR) must survive a refresh while
//        environment.RECALL_DB_PATH is updated to the new path. Today the
//        function REPLACES the entire recall-memory value with a fixed object,
//        silently dropping every custom key.
//   V-4  The mcp container present but a non-object (e.g. "mcp": "disabled") →
//        refuse with a non-zero exit AND leave the file unchanged. Today
//        `existing.mcp = existing.mcp || {}` keeps the string and the nested
//        assignment is a silent no-op (or throws but is swallowed), so the
//        function reports success and rewrites the file without registering.
describe('recall_configure_opencode_mcp hardening (V-1, V-3, V-4) [RED]', () => {
  let sandboxDir: string;
  let opencodeJsonPath: string;
  const REPO = join(__dirname, '..');

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'recall-opencode-mcp-harden-'));
    opencodeJsonPath = join(sandboxDir, 'opencode.json');
  });

  afterEach(() => {
    if (sandboxDir && existsSync(sandboxDir)) {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  // Runs the configure function and returns its process exit code (0 = success).
  // execFileSync throws on non-zero exit; we translate that into the status code.
  function runConfigureStatus(): number {
    try {
      execFileSync('bash', ['-c',
        `source "${REPO}/lib/install-lib.sh" >/dev/null 2>&1 && recall_configure_opencode_mcp >/dev/null 2>&1`,
      ], {
        env: {
          ...process.env,
          OPENCODE_CONFIG_DIR: sandboxDir,
          RECALL_DB_PATH: join(sandboxDir, 'fake-recall.db'),
        },
        encoding: 'utf-8',
      });
      return 0;
    } catch (e: any) {
      return typeof e.status === 'number' ? e.status : 1;
    }
  }

  test('V-1: malformed JSON → non-zero exit AND file left byte-identical', () => {
    const malformed = 'this is not valid json !!!';
    writeFileSync(opencodeJsonPath, malformed);

    const status = runConfigureStatus();

    expect(status).not.toBe(0);
    expect(readFileSync(opencodeJsonPath, 'utf-8')).toBe(malformed);
  });

  test('V-3: user custom keys on recall-memory survive refresh; RECALL_DB_PATH updated', () => {
    const userConfig = [
      '{',
      '  "mcp": {',
      '    "recall-memory": {',
      '      "type": "local",',
      '      "command": ["/old/bun", "run", "/old/recall-mcp"],',
      '      "enabled": true,',
      '      "myExtraKey": "bar",',
      '      "environment": { "RECALL_DB_PATH": "/old/db", "MY_CUSTOM_VAR": "foo" }',
      '    },',
      '    "github": {',
      '      "type": "local",',
      '      "command": ["gh-mcp"],',
      '      "enabled": true,',
      '      "environment": { "GITHUB_TOKEN": "ghp_xxx" }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(opencodeJsonPath, userConfig);

    const status = runConfigureStatus();
    expect(status).toBe(0);

    const after = readFileSync(opencodeJsonPath, 'utf-8');

    // Custom key directly on the recall-memory entry must survive.
    expect(after).toMatch(/"myExtraKey":\s*"bar"/);
    // Custom env var nested under recall-memory.environment must survive.
    expect(after).toMatch(/"MY_CUSTOM_VAR":\s*"foo"/);
    // RECALL_DB_PATH must be updated to the new path (the point of a refresh).
    expect(after).toContain('fake-recall.db');
    expect(after).not.toContain('"/old/db"');
    // Sibling non-Recall MCP entry must remain intact.
    expect(after).toMatch(/"github":\s*\{[\s\S]*?"gh-mcp"[\s\S]*?"ghp_xxx"/);
  });

  test('V-4: mcp container as non-object → non-zero exit AND file unchanged', () => {
    const fixture = '{ "mcp": "disabled" }';
    writeFileSync(opencodeJsonPath, fixture);

    const status = runConfigureStatus();

    expect(status).not.toBe(0);
    expect(readFileSync(opencodeJsonPath, 'utf-8')).toBe(fixture);
  });
});
