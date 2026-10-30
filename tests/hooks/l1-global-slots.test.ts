// Ph0c (ATL-RECALL-GLOBAL-PROJECT-DB-01): flag-ON acceptance for N=3 reserved
// global slots, git-remote projects only. Own DB so extra rows don't touch goldens.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { addDecision } from '../../src/lib/memory';
import { seedL1Fixture, PROJ_A, PROJ_B, GLOBAL_MARK, B_MARK } from '../fixtures/l1-golden/seed';
import * as ssc from '../../hooks/lib/session-start-context';

const GOLDEN_DIR = join(import.meta.dir, '../fixtures/l1-golden');
const PROJ_G = 'gamma-big';
let dir: string, folderDir: string, remoteA: string, remoteG: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'RECALL_IDENTITY_PATH', ssc.GLOBAL_SLOTS_FLAG, ssc.GLOBAL_MIN_IMPORTANCE_ENV];

function gitRepo(name: string, remote: string) {
  const d = join(dir, name); mkdirSync(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/x/${remote}.git`], { cwd: d });
  return d;
}
const ctx = (d: string) => { process.env.CURSOR_PROJECT_DIR = d; return ssc.gatherContext(); };
const on = () => { process.env[ssc.GLOBAL_SLOTS_FLAG] = '1'; };

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.CLAUDE_PROJECT_DIR;
  setupTestDb();
  seedL1Fixture();
  for (let i = 0; i < 15; i++) addDecision({ project: PROJ_G, decision: `GAMMAROW ${i}`, status: 'active', importance: 6 } as any);
  dir = mkdtempSync(join(tmpdir(), 'ph0c-'));
  writeFileSync(join(dir, 'identity.md'), '# Ed\nGlobal identity fixture.\n');
  process.env.RECALL_IDENTITY_PATH = join(dir, 'identity.md');
  folderDir = join(dir, PROJ_A); mkdirSync(folderDir);
  remoteA = gitRepo('checkout-a', PROJ_A);
  remoteG = gitRepo('checkout-g', PROJ_G);
});
afterEach(() => { delete process.env[ssc.GLOBAL_SLOTS_FLAG]; delete process.env[ssc.GLOBAL_MIN_IMPORTANCE_ENV]; });
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(dir, { recursive: true, force: true });
  teardownTestDb();
});

describe('Ph0c flag ON, git remote: N=3 reserved globals', () => {
  test('signal: hasGitRemote true for remote, false for folder-only; detectProject unchanged', () => {
    expect(ssc.hasGitRemote(remoteA)).toBe(true);
    expect(ssc.hasGitRemote(folderDir)).toBe(false);
    expect(ssc.detectProject(folderDir)).toBe(PROJ_A);
    expect(ssc.detectProject(remoteA)).toBe(PROJ_A);
  });

  test(`exactly ${ssc.L1_RESERVED_GLOBAL_SLOTS} global rows in L1`, () => {
    const { rows } = ssc.assembleL1Blend(PROJ_A);
    expect(rows.filter(r => r.project === null).length).toBe(3);
  });

  test('globals sit right after reserved LoA and are protected from trim', () => {
    const { rows, protectedCount } = ssc.assembleL1Blend(PROJ_A);
    const loaN = rows.findIndex(r => r.project === null);
    expect(rows.slice(0, loaN).every(r => r.table === 'loa' && r.project === PROJ_A)).toBe(true);
    expect(rows.slice(loaN, loaN + 3).every(r => r.project === null)).toBe(true);
    expect(protectedCount).toBe(loaN + 3);
  });

  test('total ≤12, ≤4 LoA reserved; big project fills to exactly 12 (12-LoA-3 project slots)', () => {
    const { rows } = ssc.assembleL1Blend(PROJ_G);
    expect(rows.length).toBe(12);
    expect(rows.filter(r => r.project === null).length).toBe(3);
    expect(rows.filter(r => r.project === PROJ_G).length).toBe(9);
  });

  test('unused global slots backfill with project rows', () => {
    const { rows } = ssc.assembleL1Blend(PROJ_G, 3, 9); // floor 9 → only 2 globals qualify
    expect(rows.filter(r => r.project === null).length).toBe(2);
    expect(rows.filter(r => r.project === PROJ_G).length).toBe(10);
    expect(rows.length).toBe(12);
  });

  test('zero cross-project rows; globals render without [project] tag', () => {
    on();
    const out = ctx(remoteA);
    expect(out).not.toContain(B_MARK);
    expect(out).not.toContain('GAMMAROW');
    for (const line of out.split('\n').filter(l => l.includes(GLOBAL_MARK))) expect(line).not.toMatch(/\]\*\* \[/);
    expect(out).toContain(GLOBAL_MARK);
  });

  test('globals survive MAX_L1_CHARS trim (keep count never below protected)', () => {
    expect(ssc.l1KeepRows(12, 99999, 7, 2)).toBe(7);
    expect(ssc.l1KeepRows(12, 99999, ssc.L1_RESERVED_LOA_SLOTS, 2)).toBe(ssc.L1_RESERVED_LOA_SLOTS); // flag-off math unchanged
  });

  test('optional floor (off by default): ★3 stray global never wins; floor env filters', () => {
    expect(ssc.assembleL1Blend(PROJ_A).rows.some(r => r.content.includes('stray'))).toBe(false);
    on(); process.env[ssc.GLOBAL_MIN_IMPORTANCE_ENV] = '9';
    expect(ctx(remoteA).split('\n').filter(l => l.includes(GLOBAL_MARK)).length).toBe(2);
  });

  test('flag ON output differs from flag-OFF golden only in L1 rows', () => {
    const off = readFileSync(join(GOLDEN_DIR, 'git-remote-flag-off.golden.md'), 'utf-8');
    on();
    const onOut = ctx(remoteA);
    const nonL1 = (s: string) => s.split('\n').filter(l => !l.startsWith('- **['));
    expect(nonL1(onOut)).toEqual(nonL1(off));
    expect(onOut).not.toBe(off);
  });
});

describe('Ph0c flag ON, NO git remote: N=0 byte-identical', () => {
  test('folder-name-only session identical with flag ON', () => {
    const base = ctx(folderDir); on();
    expect(ctx(folderDir)).toBe(base);
  });
  test('no-project (cwd /) identical with flag ON', () => {
    const base = ctx('/'); on();
    expect(ctx('/')).toBe(base);
  });
  test('flag default OFF: git-remote session unchanged vs flag-off path', () => {
    expect(ssc.globalSlotsEnabled({})).toBe(false);
    expect(ctx(remoteA).includes(GLOBAL_MARK)).toBe(false);
  });
});
