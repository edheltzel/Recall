// Shared result schema for the benchmark harness.
//
// Every suite returns a `SuiteResult`. The runner concatenates suite results
// into a `RunResult`, writes it as JSONL to benchmarks/results/, and renders a
// markdown summary alongside.
//
// Design rule (lesson from MemPalace): suites NEVER return composite scores.
// They return per-metric numbers with units. The summary renders them side by
// side; interpretation is the reader's job. We do not blend retrieval-presence
// into accuracy or vice versa.

export type SuiteId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface MetricSample {
  /** Stable identifier (e.g. 'wake_up_chars', 'l1_records'). */
  name: string;
  /** Numeric value of the measurement. */
  value: number;
  /** Human-readable unit (e.g. 'chars', 'tokens (est)', 'records'). */
  unit: string;
  /** Optional context — what scenario / project / corpus produced this. */
  scope?: string;
  /**
   * Optional comparison delta vs a baseline.
   * Positive = current is greater than baseline. Reported separately from value.
   */
  vsBaseline?: {
    baseline: string;       // baseline label (e.g. 'v1-flat-blob', 'CLAUDE.md')
    baselineValue: number;
    delta: number;          // value - baselineValue
    deltaPct: number;       // (value - baselineValue) / baselineValue * 100, when meaningful
  };
}

export interface SuiteResult {
  suite: SuiteId;
  name: string;
  description: string;
  ranAt: string;            // ISO timestamp
  durationMs: number;
  samples: MetricSample[];
  /**
   * Caveats the reader needs to know — what this measurement does NOT mean,
   * known confounders, sample-size warnings. Surface them in the markdown report.
   */
  caveats: string[];
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  recallVersion: string;
  hostInfo: {
    platform: string;
    bunVersion: string;
  };
  suites: SuiteResult[];
}

/**
 * Estimate token count from char count.
 *
 * Rough heuristic — 1 token ≈ 4 chars for typical English/code. NOT a tokenizer.
 * We use this only for relative comparison (e.g. "v2 is 30% smaller than v1").
 * Anyone reading these numbers should treat them as char-derived estimates,
 * not actual model-tokenizer output.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
