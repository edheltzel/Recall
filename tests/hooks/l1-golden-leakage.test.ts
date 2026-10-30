// Ph0b PREP (ATL-RECALL-GLOBAL-PROJECT-DB-01): golden L1 snapshots + leakage.
// Test-only; no production code changed. Regenerate goldens (v0.10.2 baseline
// ONLY) with: UPDATE_L1_GOLDEN=1 bun test tests/hooks/l1-golden-leakage.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { seedL1Fixture, PROJ_A, PROJ_B, GLOBAL_MARK, B_MARK } from '../fixtures/l1-golden/seed';

const GOLDEN_DIR = join(import.meta.dir, '../fixtures/l1-golden');
const FLAG = 'RECALL_L1_GLOBAL_SLOTS'; // PROPOSED Ph0c flag; default OFF (unset)
let idDir: string;
let folderDir: string; // no git: basename fallback only → N=0 for slots
let remoteDir: string; // git remote origin → project detected → N=3 (Ph0c)
const N_GLOBAL = 3;
const saved: Record<string, string | undefined> = {};

function golden(name: string, actual: string) {
  const p = join(GOLDEN_DIR, `${name}.golden.md`);
  if (process.env.UPDATE_L1_GOLDEN === '1' || !existsSync(p)) writeFileSync(p, actual);
  expect(actual).toBe(readFileSync(p, 'utf-8'));
}

async function ctx(projectDir: string) {
  process.env.CURSOR_PROJECT_DIR = projectDir;
  const m = await import('../../hooks/lib/session-start-context');
  return m.gatherContext();
}

beforeAll(() => {
  for (const k of ['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'RECALL_IDENTITY_PATH', FLAG]) saved[k] = process.env[k];
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env[FLAG];
  setupTestDb();
  seedL1Fixture();
  idDir = mkdtempSync(join(tmpdir(), 'ph0b-id-'));
  writeFileSync(join(idDir, 'identity.md'), '# Ed\nGlobal identity fixture.\n');
  process.env.RECALL_IDENTITY_PATH = join(idDir, 'identity.md');
  folderDir = join(idDir, PROJ_A); mkdirSync(folderDir);
  remoteDir = join(idDir, 'checkout'); mkdirSync(remoteDir);
  execFileSync('git', ['init', '-q'], { cwd: remoteDir });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/x/${PROJ_A}.git`], { cwd: remoteDir });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(idDir, { recursive: true, force: true });
  teardownTestDb();
});

describe('Ph0b golden L1 (flag OFF = v0.10.2 baseline)', () => {
  test('flag default is OFF', () => {
    expect(process.env[FLAG]).toBeUndefined();
  });

  test('no-project session (N=0) is byte-identical to golden', async () => {
    // cwd "/" → not a git repo, basename "" → project undefined.
    const { detectProject } = await import('../../hooks/lib/session-start-context');
    expect(detectProject('/')).toBeFalsy();
    const out = await ctx('/');
    expect(out).not.toContain('**Project:**');
    golden('no-project', out);
  });

  test('no-project byte-identical even with flag ON (gate 1)', async () => {
    const base = await ctx('/');
    process.env[FLAG] = '1';
    try { expect(await ctx('/')).toBe(base); } finally { delete process.env[FLAG]; }
  });

  test('project-A session golden (current degraded behavior)', async () => {
    const { assembleL1 } = await import('../../hooks/lib/session-start-context');
    const rows = assembleL1(PROJ_A);
    golden('project-alpha-rows', JSON.stringify(rows.map(r => [r.table, r.id, r.project, r.importance]), null, 1));
  });
});

describe('Ph0c prep: git-remote-only scope (captain lock 2/3/4)', () => {
  test('folder-name-only session: basename fallback, no git remote', async () => {
    const { detectProject } = await import('../../hooks/lib/session-start-context');
    expect(detectProject(folderDir)).toBe(PROJ_A); // today: basename counts
    expect(() => execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: folderDir, stdio: 'pipe' })).toThrow();
  });

  test('git-remote session: project from origin', async () => {
    const { detectProject } = await import('../../hooks/lib/session-start-context');
    expect(detectProject(remoteDir)).toBe(PROJ_A);
  });

  test('folder-name-only session is byte-identical to golden (flag OFF)', async () => {
    golden('folder-name-only', await ctx(folderDir));
  });

  test('folder-name-only session byte-identical with flag ON (N=0, no slots)', async () => {
    const base = await ctx(folderDir);
    process.env[FLAG] = '1';
    try { expect(await ctx(folderDir)).toBe(base); } finally { delete process.env[FLAG]; }
  });

  test('git-remote session, flag OFF: byte-identical to golden (= today)', async () => {
    golden('git-remote-flag-off', await ctx(remoteDir));
  });

  test('flag OFF: git-remote and folder-name sessions with same name render identically today', async () => {
    expect(await ctx(remoteDir)).toBe(await ctx(folderDir));
  });

  // Ph0c flag-ON acceptance lives in tests/hooks/l1-global-slots.test.ts
});

describe('Ph0b leakage', () => {
  test('project A never receives project B rows', async () => {
    const { assembleL1 } = await import('../../hooks/lib/session-start-context');
    const rows = assembleL1(PROJ_A);
    expect(rows.every(r => r.project === PROJ_A || r.project === null)).toBe(true);
    expect(rows.some(r => r.content.includes(B_MARK))).toBe(false);
  });

  test('project B never receives project A rows', async () => {
    const { assembleL1 } = await import('../../hooks/lib/session-start-context');
    expect(assembleL1(PROJ_B).some(r => r.project === PROJ_A)).toBe(false);
  });

  test('characterization: flag OFF, project session has ZERO globals (Ph0 degradation)', async () => {
    const { assembleL1 } = await import('../../hooks/lib/session-start-context');
    expect(assembleL1(PROJ_A).some(r => r.project === null)).toBe(false);
  });

  test('L1 total ≤ 12 and reserved LoA at front', async () => {
    const { assembleL1, L1_TOTAL_SLOTS } = await import('../../hooks/lib/session-start-context');
    for (const p of [undefined, PROJ_A, PROJ_B]) {
      const rows = assembleL1(p);
      expect(rows.length).toBeLessThanOrEqual(L1_TOTAL_SLOTS);
      const firstNonLoa = rows.findIndex(r => r.table !== 'loa');
      if (firstNonLoa > 0) expect(rows.slice(0, firstNonLoa).every(r => r.table === 'loa')).toBe(true);
    }
  });

});
