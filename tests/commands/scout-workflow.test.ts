// Contract tests for the recall-scout codebase-scouting workflow.
//
// The scout workflow is a doc/prompt surface, not executable code, so these
// tests assert the *contracts* that make it correct and safe:
//   1. The canonical agent skill exists and carries the full workflow.
//   2. It is memory-first, has the required report sections, enforces the
//      sensitive-data boundary, and keeps artifacts opt-in.
//   2b. CodeGraph integration: the capability ladder probes with
//       `codegraph status --json` and OFFERS `codegraph init` (never auto-runs),
//       and the query discipline keeps the scout token-frugal.
//   3. DRY: the four platform guides reference the canonical block and do NOT
//      hand-copy its body (per the MANDATORY DRY rule in CLAUDE.md/AGENTS.md).
//   4. The artifacts policy is recorded in canonical AGENTS.md; CLAUDE.md is a
//      symlink to it.
//   5. recall-scout is listed in the user-facing docs (agent-skills, README).

import { describe, test, expect } from 'bun:test';
import { readFileSync, lstatSync, readlinkSync } from 'fs';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8');

const SCOUT = read('agent-skills/recall-scout/SKILL.md');

// The four platform guides that must REFERENCE the canonical block, never copy it.
const GUIDE_PATHS = [
  'FOR_CLAUDE.md',
  'FOR_PI.md',
  'FOR_OPENCODE.md',
  'opencode/recall-memory.md',
];

// A distinctive sentence that lives only in the canonical workflow body.
// If it appears in a guide, someone hand-copied the body — a DRY violation.
const CANONICAL_SENTINEL =
  'This is the canonical scouting workflow; platform guides reference it and only remap tool names.';

describe('agent-skills/recall-scout/SKILL.md — canonical workflow', () => {
  test('has frontmatter describing a codebase scout', () => {
    expect(SCOUT.startsWith('---')).toBe(true);
    expect(SCOUT).toMatch(/description:.*scout/i);
  });

  test('is memory-first: search Recall before git or source', () => {
    expect(SCOUT).toMatch(/memory first/i);
    // The ordering instruction must be explicit: memory before git history/source.
    expect(SCOUT).toMatch(/before reading git history or source/i);
  });

  test('produces all required report sections', () => {
    for (const section of [
      'Memory summary',
      'Repo map',
      'Tech stack',
      'Key paths',
      'Conventions',
      'Tests',
      'Risks',
      'Next steps',
    ]) {
      expect(SCOUT).toContain(section);
    }
  });

  test('reports in chat', () => {
    expect(SCOUT).toMatch(/in chat/i);
  });

  test('enforces the sensitive-data boundary', () => {
    expect(SCOUT).toMatch(/sensitive-data boundary/i);
    // No secrets / credentials.
    expect(SCOUT).toMatch(/secret|credential/i);
    // No generated / vendored files.
    expect(SCOUT).toMatch(/generated|vendored|node_modules/i);
    // Never touch the live database.
    expect(SCOUT).toContain('recall.db');
    // No cross-project memory leakage.
    expect(SCOUT).toMatch(/cross-project/i);
  });

  test('keeps artifacts opt-in to .agents/atlas/artifacts/ only', () => {
    expect(SCOUT).toContain('.agents/atlas/artifacts/');
    expect(SCOUT).toMatch(/chat-only by default/i);
    // Opt-in: only when the directory exists or the user asks.
    expect(SCOUT).toMatch(/opt-in|already exists|explicitly asks/i);
    // handoffs/ stays reserved — scout artifacts must never go there.
    expect(SCOUT).toMatch(/\.agents\/atlas\/handoffs\/.*reserved|never write scout artifacts/i);
  });
});

describe('CodeGraph integration — capability ladder + query discipline', () => {
  test('probes with codegraph status --json and branches on initialized', () => {
    expect(SCOUT).toContain('codegraph status --json');
    expect(SCOUT).toContain('initialized');
  });

  test('offers codegraph init on an unindexed repo — never auto-runs it', () => {
    expect(SCOUT).toMatch(/explicit user yes/i);
    expect(SCOUT).toMatch(/never auto-run/i);
  });

  test('caps explore calls and forbids re-pasting source into the report', () => {
    expect(SCOUT).toMatch(/query discipline/i);
    expect(SCOUT).toMatch(/at most two/i);
    expect(SCOUT).toMatch(/never re-paste/i);
  });

  test('prefers cappable CLI forms and treats the backstop as fallback', () => {
    expect(SCOUT).toContain('--limit');
    expect(SCOUT).toContain('--symbols-only');
    expect(SCOUT).toMatch(/backstop means fallback, not second pass/i);
  });

  test('symbol misses are string-matched, not exit-checked', () => {
    expect(SCOUT).toMatch(/not found/i);
    expect(SCOUT).toContain('exit 0');
  });

  test('remains an enhancement, never a hard dependency', () => {
    expect(SCOUT).toMatch(/enhancement, never a hard dependency/i);
    expect(SCOUT).toMatch(/producible with zero CodeGraph/i);
  });

  test('tech stack reads manifests only — lockfiles stay boundary-excluded', () => {
    expect(SCOUT).toMatch(/from manifests only/i);
    expect(SCOUT).toMatch(/lockfiles stay behind the sensitive-data boundary/i);
  });
});

describe('DRY — guides reference the canonical block, never copy it', () => {
  for (const guide of GUIDE_PATHS) {
    test(`${guide} references agent-skills/recall-scout/SKILL.md`, () => {
      expect(read(guide)).toContain('agent-skills/recall-scout/SKILL.md');
    });

    test(`${guide} does not hand-copy the canonical body`, () => {
      expect(read(guide)).not.toContain(CANONICAL_SENTINEL);
    });
  }

  test('the canonical sentinel lives only in the scout skill', () => {
    expect(SCOUT).toContain(CANONICAL_SENTINEL);
    const copies = GUIDE_PATHS.filter((g) => read(g).includes(CANONICAL_SENTINEL));
    expect(copies).toEqual([]);
  });
});

describe('artifacts policy is recorded in the canonical dev guide', () => {
  // AGENTS.md is the single source of truth; CLAUDE.md is a symlink to it so
  // Claude Code loads it. The policy lives in AGENTS.md only.
  test('AGENTS.md documents the .agents/atlas/artifacts/ policy', () => {
    const body = read('AGENTS.md');
    expect(body).toContain('.agents/atlas/artifacts/');
    // handoffs/ remains reserved for handoffs.
    expect(body).toMatch(/\.agents\/atlas\/handoffs\/.*reserved|reserved for session handoff/i);
  });

  test('CLAUDE.md is a symlink to AGENTS.md (no duplicated content)', () => {
    // CLAUDE.md is a SYMLINK to AGENTS.md, not a file containing `@AGENTS.md`.
    // The contract this test defends is unchanged — "CLAUDE.md must never carry
    // a second copy of the guide" — but a symlink satisfies it by construction:
    // there is literally one file, so content can't drift. Assert the LINK, not
    // the content; reading CLAUDE.md now yields all of AGENTS.md, which is the
    // point, so any content assertion here would be asserting AGENTS.md twice.
    const link = lstatSync(join(repoRoot, 'CLAUDE.md'));
    expect(link.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repoRoot, 'CLAUDE.md'))).toBe('AGENTS.md');

    // Resolving it must land on the canonical guide, not a stale copy.
    expect(read('CLAUDE.md')).toBe(read('AGENTS.md'));
  });

  // Guards the known cross-platform failure mode of the symlink approach: on a
  // checkout with core.symlinks=false (common on Windows), git materializes
  // CLAUDE.md as a PLAIN FILE whose whole content is the string "AGENTS.md" —
  // and Claude Code would silently load that as the entire guide. The assertion
  // above fails loudly in that case rather than shipping a broken guide.
  test('CLAUDE.md did not degrade into a literal-path text file', () => {
    const body = read('CLAUDE.md');
    expect(body.trim()).not.toBe('AGENTS.md');
    expect(body).toContain('.agents/atlas/artifacts/');
  });
});

describe('recall-scout is listed for users', () => {
  test('docs/agent-skills.md lists the skill', () => {
    expect(read('docs/agent-skills.md')).toContain('recall-scout');
  });

  test('README.md lists the skill', () => {
    expect(read('README.md')).toContain('recall-scout');
  });
});
