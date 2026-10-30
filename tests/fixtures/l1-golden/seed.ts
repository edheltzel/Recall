// Ph0b (ATL-RECALL-GLOBAL-PROJECT-DB-01) — deterministic L1 seed for golden
// snapshots + leakage tests. Test-only. Fixed created_at so output is stable.
import { getDb } from '../../../src/db/connection';
import { addDecision, addLearning, addBreadcrumb, createLoaEntry } from '../../../src/lib/memory';

export const PROJ_A = 'alpha-app';
export const PROJ_B = 'beta-svc';
export const GLOBAL_MARK = 'GLOBALROW';
export const B_MARK = 'BETAROW';

export function seedL1Fixture(): void {
  const db = getDb();
  let day = 1;
  const stamp = (table: string, id: number) =>
    db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`)
      .run(`2026-01-${String(day++).padStart(2, '0')}T00:00:00Z`, id);

  // Globals (project NULL): high-importance identity/preference rows + low-importance strays.
  stamp('decisions', addDecision({ project: null as any, decision: `${GLOBAL_MARK} prefer Bun + TS`, reasoning: 'human-wide', status: 'active', importance: 9 } as any));
  stamp('learnings', addLearning({ project: null as any, problem: `${GLOBAL_MARK} commit style`, solution: 'conventional commits', importance: 8 } as any));
  stamp('breadcrumbs', addBreadcrumb({ project: null as any, content: `${GLOBAL_MARK} stray low-imp note`, importance: 3 } as any));
  stamp('loa_entries', createLoaEntry({ project: null as any, title: `${GLOBAL_MARK} LoA global`, fabric_extract: 'x', importance: 9 } as any));

  // Project A rows.
  for (let i = 0; i < 6; i++) {
    stamp('decisions', addDecision({ project: PROJ_A, decision: `ALPHAROW decision ${i}`, status: 'active', importance: 5 + (i % 3) } as any));
  }
  stamp('learnings', addLearning({ project: PROJ_A, problem: 'ALPHAROW learning', solution: 's', importance: 6 } as any));
  stamp('loa_entries', createLoaEntry({ project: PROJ_A, title: 'ALPHAROW LoA', fabric_extract: 'x', importance: 7 } as any));

  // Project B rows (must never appear in A).
  stamp('decisions', addDecision({ project: PROJ_B, decision: `${B_MARK} decision`, status: 'active', importance: 10 } as any));
  stamp('learnings', addLearning({ project: PROJ_B, problem: `${B_MARK} learning`, solution: 's', importance: 10 } as any));
  stamp('breadcrumbs', addBreadcrumb({ project: PROJ_B, content: `${B_MARK} crumb`, importance: 10 } as any));
  stamp('loa_entries', createLoaEntry({ project: PROJ_B, title: `${B_MARK} LoA`, fabric_extract: 'x', importance: 10 } as any));
}
