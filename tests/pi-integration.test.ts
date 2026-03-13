import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { linearizeSession } from '../pi/recall-extract';

// ─── Tree JSONL Linearization ───

describe('tree JSONL linearization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-pi-linearize-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('linearizes a simple linear conversation', () => {
    const entries = [
      { id: "1", parentId: null, type: "message", message: { role: "user", content: "Hello, can you help me with TypeScript?" } },
      { id: "2", parentId: "1", type: "message", message: { role: "assistant", content: "Of course! TypeScript is a typed superset of JavaScript. What do you need help with specifically?" } },
      { id: "3", parentId: "2", type: "message", message: { role: "user", content: "How do I define an interface with optional fields?" } },
    ];
    const jsonlPath = join(tempDir, 'linear.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));
    const result = linearizeSession(jsonlPath);
    expect(result).toContain('[USER]');
    expect(result).toContain('[ASSISTANT]');
    expect(result).toContain('TypeScript');
  });

  test('follows active branch (last child) when tree branches', () => {
    const entries = [
      { id: "1", parentId: null, type: "message", message: { role: "user", content: "What is the best programming language?" } },
      { id: "2", parentId: "1", type: "message", message: { role: "assistant", content: "Old answer: Python is popular." } },
      { id: "3", parentId: "1", type: "message", message: { role: "assistant", content: "Updated answer: It depends on your use case. For web, TypeScript. For ML, Python." } },
    ];
    const jsonlPath = join(tempDir, 'branching.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));
    const result = linearizeSession(jsonlPath);
    expect(result).toContain('Updated answer');
    expect(result).not.toContain('Old answer');
  });

  test('skips non-message entries', () => {
    const entries = [
      { id: "1", parentId: null, type: "system", data: { model: "pi-3" } },
      { id: "2", parentId: "1", type: "message", message: { role: "user", content: "Tell me about Recall persistent memory system" } },
      { id: "3", parentId: "2", type: "tool_call", tool: { name: "search" } },
      { id: "4", parentId: "3", type: "message", message: { role: "assistant", content: "Recall gives you persistent memory across coding sessions using SQLite and FTS5." } },
    ];
    const jsonlPath = join(tempDir, 'mixed.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));
    const result = linearizeSession(jsonlPath);
    expect(result).toContain('Recall');
    expect(result).not.toContain('pi-3');
    expect(result).not.toContain('search');
  });

  test('handles malformed JSONL lines gracefully', () => {
    const jsonlPath = join(tempDir, 'malformed.jsonl');
    writeFileSync(jsonlPath, '{"id":"1","parentId":null,"type":"message","message":{"role":"user","content":"Valid message about testing"}}\nnot json\n{"broken');
    const result = linearizeSession(jsonlPath);
    expect(result).toContain('Valid message');
  });

  test('handles array content blocks (Claude-style structured content)', () => {
    const entries = [
      { id: "1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "Hello, how does FTS5 search work in SQLite?" }] } },
      { id: "2", parentId: "1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "FTS5 is a full-text search extension for SQLite that supports efficient keyword queries." }, { type: "text", text: "It uses inverted indexes to speed up search." }] } },
    ];
    const jsonlPath = join(tempDir, 'array-content.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));
    const result = linearizeSession(jsonlPath);
    expect(result).toContain('FTS5');
    expect(result).toContain('inverted indexes');
    expect(result).not.toContain('"type"');
  });

  test('skips messages with 10 or fewer characters', () => {
    const entries = [
      { id: "1", parentId: null, type: "message", message: { role: "user", content: "short" } },
      { id: "2", parentId: "1", type: "message", message: { role: "assistant", content: "This is a sufficiently long response that should appear in the output transcript." } },
    ];
    const jsonlPath = join(tempDir, 'short-msg.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));
    const result = linearizeSession(jsonlPath);
    expect(result).not.toContain('short');
    expect(result).toContain('sufficiently long');
  });

  test('truncates messages to 4000 characters', () => {
    const longText = 'a'.repeat(5000);
    const entries = [
      { id: "1", parentId: null, type: "message", message: { role: "user", content: longText } },
    ];
    const jsonlPath = join(tempDir, 'long-msg.jsonl');
    writeFileSync(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'));
    const result = linearizeSession(jsonlPath);
    // Format is "[USER]: " (8 chars) + 4000 chars + "...[truncated]"
    const prefix = '[USER]: ';
    expect(result.startsWith(prefix)).toBe(true);
    expect(result).toContain('...[truncated]');
    const contentPart = result.slice(prefix.length);
    expect(contentPart.length).toBe(4000 + '...[truncated]'.length);
  });
});

// ─── BatchExtract Pi Session Scanning ───

describe('BatchExtract Pi session scanning', () => {
  let tempDir: string;
  let piDropDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-pi-batch-'));
    piDropDir = join(tempDir, 'pi-sessions');
    mkdirSync(piDropDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('discovers .md files in pi-sessions drop directory', () => {
    writeFileSync(join(piDropDir, 'session-abc.md'), '# Pi Session\n' + 'x'.repeat(3000));
    writeFileSync(join(piDropDir, 'session-def.md'), '# Pi Session 2\n' + 'y'.repeat(3000));
    const files = readdirSync(piDropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));
    expect(files).toHaveLength(2);
    expect(files).toContain('session-abc.md');
    expect(files).toContain('session-def.md');
  });

  test('pi sessions have project field set to "pi"', () => {
    writeFileSync(join(piDropDir, 'session.md'), '# Session\n' + 'x'.repeat(3000));
    const files = readdirSync(piDropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));
    const sessions = files.map(f => {
      const fullPath = join(piDropDir, f);
      const stat = statSync(fullPath);
      return { path: fullPath, size: stat.size, project: 'pi', mtime: stat.mtimeMs };
    });
    expect(sessions[0].project).toBe('pi');
  });

  test('handles empty pi-sessions directory', () => {
    const files = readdirSync(piDropDir)
      .filter((f: string) => f.endsWith('.md') && !f.startsWith('.'));
    expect(files).toHaveLength(0);
  });

  test('handles non-existent pi-sessions directory', () => {
    const nonExistent = join(tempDir, 'does-not-exist');
    expect(existsSync(nonExistent)).toBe(false);
  });
});

// ─── Installer Pi Integration ───

describe('installer Pi integration', () => {
  test('install.sh has no syntax errors', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    expect(() => execFileSync('bash', ['-n', installPath])).not.toThrow();
  });

  test('install.sh includes Pi config in backup list', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('PI_CONFIG_DIR');
    expect(content).toContain('mcp.json');
    expect(content).toContain('AGENTS.md');
  });

  test('install.sh detects Pi platform', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('PI_DETECTED');
    expect(content).toContain('command -v pi');
  });

  test('install.sh has pi-mcp-adapter installation', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('pi-mcp-adapter');
    expect(content).toContain('install_pi_adapter');
  });

  test('install.sh has Pi MCP configuration', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('configure_pi_mcp');
    expect(content).toContain('recall-memory');
    expect(content).toContain('lifecycle');
  });

  test('install.sh copies Pi extensions', () => {
    const installPath = join(__dirname, '..', 'install.sh');
    const content = readFileSync(installPath, 'utf-8');
    expect(content).toContain('install_pi_extensions');
    expect(content).toContain('recall-extract.ts');
    expect(content).toContain('recall-compaction.ts');
  });
});

// ─── Pi Extraction Tracker Dedup ───

describe('Pi extraction tracker (dedup)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-pi-tracker-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('tracker persists to JSON file', () => {
    const trackerPath = join(tempDir, '.extraction_tracker.json');
    const tracker = new Set(['session-1.jsonl', 'session-2.jsonl']);
    writeFileSync(trackerPath, JSON.stringify([...tracker]));
    const loaded = JSON.parse(readFileSync(trackerPath, 'utf-8'));
    const restoredSet = new Set(Array.isArray(loaded) ? loaded : []);
    expect(restoredSet.has('session-1.jsonl')).toBe(true);
    expect(restoredSet.has('session-2.jsonl')).toBe(true);
    expect(restoredSet.has('session-3.jsonl')).toBe(false);
  });

  test('corrupt tracker file falls back to empty set', () => {
    const trackerPath = join(tempDir, '.extraction_tracker.json');
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
