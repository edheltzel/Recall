// Suite B — Token efficiency.
//
// Measures the size of the bundle injected at session start. The goal is to
// make the L0+L1 cost transparent and to enable regression detection: if a
// future change inflates the wake-up bundle by 3x, we want a number that
// catches it.
//
// What this suite is NOT:
// - It does NOT measure retrieval quality (Suite A).
// - It does NOT measure precision under noise (Suite C).
// - It does NOT measure answer accuracy (Suite A's grader).
// Token cost matters, but optimizing it without measuring quality is how you
// end up shipping a 170-token bundle that recalls nothing useful.

import { runSuiteB_v1Baseline, runSuiteB_v2Tiered } from './suite-b-internals.js';
import { snapshotClaudeMd } from '../baselines/claude-md.js';
import { estimateTokens, type SuiteResult, type MetricSample } from '../types.js';

export interface SuiteBOptions {
  project?: string;
}

export async function runSuiteB(options: SuiteBOptions = {}): Promise<SuiteResult> {
  const t0 = performance.now();

  const v2 = runSuiteB_v2Tiered(options.project);
  const v1 = runSuiteB_v1Baseline(options.project);
  const claudeMd = snapshotClaudeMd();

  const samples: MetricSample[] = [];

  // ── v2 (tiered) measurements ──────────────────────────────────────
  samples.push({
    name: 'v2_total_chars',
    value: v2.totalChars,
    unit: 'chars',
    scope: options.project ?? 'auto-detected',
  });
  samples.push({
    name: 'v2_total_tokens_est',
    value: estimateTokens(v2.totalChars),
    unit: 'tokens (est, 4ch/tok)',
    scope: options.project ?? 'auto-detected',
  });
  samples.push({
    name: 'v2_l0_chars',
    value: v2.l0Chars,
    unit: 'chars',
    scope: 'identity tier',
  });
  samples.push({
    name: 'v2_l1_chars',
    value: v2.l1Chars,
    unit: 'chars',
    scope: 'ranked tier',
  });
  samples.push({
    name: 'v2_l1_records',
    value: v2.l1RecordCount,
    unit: 'records',
    scope: 'ranked tier',
  });
  samples.push({
    name: 'v2_loa_records_in_l1',
    value: v2.l1LoaCount,
    unit: 'records',
    scope: 'curated tier reserved slots',
  });

  // ── v1 baseline (flat blob) ────────────────────────────────────────
  // The v1 SessionRecall returned a flat decisions+breadcrumbs+learnings
  // blob capped at 8000 chars. We simulate it from the same DB so the
  // comparison is fair (same corpus, same project filter).
  samples.push({
    name: 'v1_total_chars',
    value: v1.totalChars,
    unit: 'chars',
    scope: options.project ?? 'auto-detected',
    vsBaseline: makeDelta('v2-tiered', v1.totalChars, v2.totalChars),
  });

  // ── CLAUDE.md baseline ────────────────────────────────────────────
  samples.push({
    name: 'claude_md_total_chars',
    value: claudeMd.totalChars,
    unit: 'chars',
    scope: 'static memory baseline',
    vsBaseline: makeDelta('v2-tiered', claudeMd.totalChars, v2.totalChars),
  });
  samples.push({
    name: 'claude_md_global_chars',
    value: claudeMd.globalChars,
    unit: 'chars',
    scope: claudeMd.globalPath ?? '(missing)',
  });
  samples.push({
    name: 'claude_md_project_chars',
    value: claudeMd.projectChars,
    unit: 'chars',
    scope: claudeMd.projectPath ?? '(missing)',
  });

  const durationMs = Math.round(performance.now() - t0);

  return {
    suite: 'B',
    name: 'Token efficiency',
    description: 'Measures the byte cost of session-start memory injection across v2 (tiered SessionRecall), v1 (simulated flat blob), and CLAUDE.md (static baseline). All char counts; token estimates use 4 chars/token.',
    ranAt: new Date().toISOString(),
    durationMs,
    samples,
    caveats: [
      'Token estimates use chars/4 — NOT a real tokenizer. Use only for relative comparison.',
      'v1 baseline simulates the pre-tiered SessionRecall blob from the same DB. It is not a snapshot of historical output.',
      'CLAUDE.md and Recall are complementary, not competitors. CLAUDE.md is static and hand-written; Recall is dynamic and auto-extracted. The comparison is a sanity check on relative budget, not a winner declaration.',
      'Scope = the project tag used to filter records. If absent, results vary with the directory the runner was invoked from.',
      'L0 size depends entirely on the user-edited identity.md. A larger L0 is not better — it is just larger.',
    ],
  };
}

function makeDelta(againstLabel: string, value: number, baselineValue: number) {
  if (baselineValue === 0) {
    return { baseline: againstLabel, baselineValue, delta: value, deltaPct: 0 };
  }
  return {
    baseline: againstLabel,
    baselineValue,
    delta: value - baselineValue,
    deltaPct: ((value - baselineValue) / baselineValue) * 100,
  };
}
