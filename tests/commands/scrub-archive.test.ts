// recall scrub-archive — issue #157 acceptance criteria.
//
// Behavior under test:
// - redacts secrets + invisible unicode across all three surface kinds
//   (markdown/log, JSON, per-session transcript.md) in place
// - backs up every changed file before rewriting; the backup keeps the original
// - idempotent: a second sweep changes nothing further
// - clean files are never backed up or rewritten (no spurious churn)
// - JSON surfaces stay structurally valid; non-secret fields survive
// - --dry-run reports without writing
// - the import-legacy guard: a secret planted in DISTILLED.md cannot survive an
//   import-legacy run into the DB

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runScrubArchive, type ScrubArchiveOptions } from '../../src/commands/scrub-archive';
import { runImportLegacy } from '../../src/commands/import-legacy';
import { getDb } from '../../src/db/connection';

// Realistic secret shapes the canonical pattern table actually redacts.
const AWS = 'AKIAIOSFODNN7EXAMPLE'; // aws-akid
const GH = 'ghp_0123456789abcdefghij0123456789abcdef'; // github-pat
const ZWSP = '​'; // zero-width space (invisible unicode)
const NOW = new Date('2026-01-02T03:04:05Z');

let root: string;
let memoryDir: string;
let sessionsDir: string;
let backupDir: string;
let logs: string[];
const origLog = console.log;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recall-scrub-'));
  memoryDir = join(root, 'MEMORY');
  mkdirSync(memoryDir, { recursive: true });
  sessionsDir = join(root, 'sessions');
  backupDir = join(root, 'backups');
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
});

afterEach(() => {
  console.log = origLog;
  rmSync(root, { recursive: true, force: true });
});

function opts(extra: Partial<ScrubArchiveOptions> = {}): ScrubArchiveOptions {
  return { memoryDir, sessionsDir, backupDir, now: NOW, ...extra };
}

function writeTranscript(date: string, session: string, body: string): string {
  const dir = join(sessionsDir, date, session);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'transcript.md');
  writeFileSync(p, body, 'utf-8');
  return p;
}

const backupRoot = () => join(backupDir, 'scrub-archive-20260102-030405');

describe('scrub-archive — cross-surface redaction', () => {
  test('redacts secrets across markdown, JSON, and transcript surfaces in place, with backups', () => {
    const distilled = join(memoryDir, 'DISTILLED.md');
    const sessionIndex = join(memoryDir, 'SESSION_INDEX.json');
    writeFileSync(distilled, `# Distilled\nleaked ${AWS}${ZWSP} key\n`, 'utf-8');
    writeFileSync(sessionIndex, JSON.stringify({ sessions: [{ summary: `token ${GH}`, project: 'demo' }] }, null, 2), 'utf-8');
    const transcript = writeTranscript('2026-01-02', 'sess1', `# Session\nsecret ${AWS} inline\n`);

    runScrubArchive(opts());

    // Secrets gone from every surface, in place.
    expect(readFileSync(distilled, 'utf-8')).not.toContain(AWS);
    expect(readFileSync(distilled, 'utf-8')).toContain('[REDACTED:aws-akid]');
    expect(readFileSync(distilled, 'utf-8')).not.toContain(ZWSP);
    expect(readFileSync(sessionIndex, 'utf-8')).not.toContain(GH);
    expect(readFileSync(transcript, 'utf-8')).not.toContain(AWS);

    // JSON stays structurally valid and non-secret fields survive.
    const parsed = JSON.parse(readFileSync(sessionIndex, 'utf-8'));
    expect(parsed.sessions[0].project).toBe('demo');
    expect(parsed.sessions[0].summary).toContain('[REDACTED:github-pat]');

    // Backups exist and retain the ORIGINAL secret (recovery path).
    expect(readFileSync(join(backupRoot(), 'MEMORY', 'DISTILLED.md'), 'utf-8')).toContain(AWS);
    expect(readFileSync(join(backupRoot(), 'sessions', '2026-01-02', 'sess1', 'transcript.md'), 'utf-8')).toContain(AWS);

    expect(logs.join('\n')).toMatch(/Changed:\s+3/);
  });
});

describe('scrub-archive — idempotency and clean-file discipline', () => {
  test('a second sweep changes nothing further', () => {
    const distilled = join(memoryDir, 'DISTILLED.md');
    writeFileSync(distilled, `leaked ${AWS} key\n`, 'utf-8');

    runScrubArchive(opts());
    const afterFirst = readFileSync(distilled, 'utf-8');
    logs = [];
    runScrubArchive(opts());

    expect(readFileSync(distilled, 'utf-8')).toBe(afterFirst);
    expect(logs.join('\n')).toMatch(/Changed:\s+0/);
    // No -1 backup variant — the second sweep backed nothing up.
    expect(existsSync(join(backupRoot(), 'MEMORY', 'DISTILLED-1.md'))).toBe(false);
  });

  test('clean files are not backed up or rewritten', () => {
    const distilled = join(memoryDir, 'DISTILLED.md');
    const clean = '# Distilled\nnothing sensitive here\n';
    writeFileSync(distilled, clean, 'utf-8');

    runScrubArchive(opts());

    expect(readFileSync(distilled, 'utf-8')).toBe(clean);
    expect(existsSync(backupRoot())).toBe(false);
    expect(logs.join('\n')).toMatch(/Changed:\s+0/);
  });
});

describe('scrub-archive — dry run', () => {
  test('reports what would change without writing or backing up', () => {
    const distilled = join(memoryDir, 'DISTILLED.md');
    const original = `leaked ${AWS} key\n`;
    writeFileSync(distilled, original, 'utf-8');

    runScrubArchive(opts({ dryRun: true }));

    expect(readFileSync(distilled, 'utf-8')).toBe(original); // untouched
    expect(existsSync(backupRoot())).toBe(false);
    expect(logs.join('\n')).toMatch(/Would change:\s+1/);
    expect(logs.join('\n')).toContain('[DRY RUN] No files were modified.');
  });
});

describe('scrub-archive — malformed JSON', () => {
  test('invalid JSON is left untouched, not corrupted', () => {
    const errors = join(memoryDir, 'ERROR_PATTERNS.json');
    const broken = `{ not valid json ${AWS}`;
    writeFileSync(errors, broken, 'utf-8');

    runScrubArchive(opts());

    expect(readFileSync(errors, 'utf-8')).toBe(broken);
    expect(logs.join('\n')).toMatch(/invalid JSON/);
  });
});

describe('import-legacy guard (#157)', () => {
  test('a secret in DISTILLED.md cannot survive import-legacy into the DB — content AND project columns', () => {
    setupTestDb();
    try {
      const distilled = join(memoryDir, 'DISTILLED.md');
      // Plant a secret in BOTH the body and the PROJECT header field — the
      // project lands in loa_entries.project and is just as much an amplifier.
      writeFileSync(
        distilled,
        `## Extracted: 2026-01-02 | proj-${AWS}\nSESSION: Test session\nDeploy used ${AWS} for access.\n`,
        'utf-8'
      );

      runImportLegacy({ yes: true, source: 'distilled', memoryDir });

      const row = getDb()
        .prepare('SELECT title, fabric_extract, project FROM loa_entries ORDER BY id DESC LIMIT 1')
        .get() as { title: string; fabric_extract: string; project: string };
      expect(row).toBeTruthy();
      expect(row.fabric_extract).not.toContain(AWS);
      expect(row.fabric_extract).toContain('[REDACTED:aws-akid]');
      // The project column must be scrubbed too (RedTeam reproduced a leak here).
      expect(row.project).not.toContain(AWS);
      expect(row.project).toContain('[REDACTED:aws-akid]');
    } finally {
      teardownTestDb();
    }
  });
});

describe('scrub-archive — hostile filesystem', () => {
  test('a dangling symlink under sessions/ does not abort the sweep; other surfaces still scrubbed', () => {
    // A real MEMORY surface and a valid transcript that MUST still get scrubbed.
    const distilled = join(memoryDir, 'DISTILLED.md');
    writeFileSync(distilled, `leaked ${AWS} key\n`, 'utf-8');
    const goodTranscript = writeTranscript('2026-01-03', 'sessA', `# Session\nsecret ${AWS} here\n`);

    // A dangling symlink date entry pointing at a nonexistent target — statSync
    // on it throws ENOENT, which previously crashed the whole sweep.
    mkdirSync(sessionsDir, { recursive: true });
    symlinkSync(join(root, 'does-not-exist'), join(sessionsDir, '2026-01-02'));

    // Must not throw.
    expect(() => runScrubArchive(opts())).not.toThrow();

    // Sweep completed: the other surfaces were scrubbed despite the bad symlink.
    expect(readFileSync(distilled, 'utf-8')).not.toContain(AWS);
    expect(readFileSync(goodTranscript, 'utf-8')).not.toContain(AWS);
    expect(logs.join('\n')).toMatch(/\[SKIP\] sessions\/2026-01-02/);
  });

  test('an unreadable (mode 000) surface does not abort the sweep; other surfaces still scrubbed', () => {
    const distilled = join(memoryDir, 'DISTILLED.md');
    writeFileSync(distilled, `leaked ${AWS} key\n`, 'utf-8');

    // A transcript the process cannot read — readFileSync throws EACCES, which
    // previously aborted the whole sweep and left DISTILLED.md un-scrubbed.
    const locked = writeTranscript('2026-01-04', 'sessB', `secret ${AWS}\n`);
    chmodSync(locked, 0o000);

    try {
      expect(() => runScrubArchive(opts())).not.toThrow();

      // The readable surface was still scrubbed despite the unreadable one.
      expect(readFileSync(distilled, 'utf-8')).not.toContain(AWS);
      expect(logs.join('\n')).toMatch(/\[SKIP\] sessions\/2026-01-04\/sessB\/transcript\.md — unreadable/);
    } finally {
      chmodSync(locked, 0o644); // restore so afterEach cleanup can remove it
    }
  });
});
