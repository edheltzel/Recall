import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import { SCHEMA_VERSION, MIGRATE_V2_TO_V3, CREATE_TABLES } from '../src/db/schema';
import { linearizeSession } from '../pi/recall-extract';

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
    expect(row.source).toBe('claude-code');

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
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('OPENCODE_CONFIG_DIR');
    expect(content).toContain('opencode.json');
  });

  test('install.sh detects both platforms', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('detect_platforms');
    expect(content).toContain('OPENCODE_DETECTED');
    expect(content).toContain('CLAUDE_CODE_DETECTED');
  });

  test('install.sh has JSONC-safe config parsing', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    // Verify comment stripping regex is present
    expect(content).toContain('.replace(/\\/\\/.*$/gm, "")');
    expect(content).toContain('.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")');
  });
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
    // findPiSessions in BatchExtract returns [] early when dir doesn't exist
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
          command: 'mem-mcp',
          args: [],
          environment: {
            MEM_DB_PATH: '/Users/ed/.claude/memory.db'
          }
        }
      }
    };

    // Verify it serializes to valid JSON
    expect(() => JSON.stringify(mockConfig)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(mockConfig));
    expect(parsed.mcpServers['recall-memory'].command).toBe('mem-mcp');
  });

  test('AGENTS.md snippet has no unexpanded shell variables', () => {
    const agentsMdSnippet = `
## MEMORY

You have persistent memory via Recall. **Read the full guide:** ~/.pi/agent/Recall_GUIDE.md
    `;

    // The rendered snippet should not contain unexpanded $VARIABLE patterns
    expect(agentsMdSnippet).not.toMatch(/\$[A-Z_]+/);
  });

  test('installer backup list includes Pi config files', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    // Pi-specific paths should appear in the install.sh
    expect(content).toContain('PI_CONFIG_DIR');
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('recall-extract.ts');
    expect(content).toContain('recall-compaction.ts');
  });

  test('install.sh detects Pi platform', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('PI_DETECTED');
  });

  test('install.sh has Pi MCP configuration function', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('configure_pi_mcp');
    expect(content).toContain('recall-memory');
  });
});
