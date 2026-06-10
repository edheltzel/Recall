// Benchmark runner — orchestrates suites and writes results.
//
// Usage from CLI: `recall benchmark run [suite]` (see src/commands/benchmark.ts).
// Direct invocation: `bun run benchmarks/runner.ts [suite]`.
//
// Output: a JSONL file at benchmarks/results/<timestamp>-<suite>.jsonl plus a
// rendered markdown report at benchmarks/results/<timestamp>-<suite>.md. The
// JSONL is the source of truth (machine-readable, diffable). The markdown is
// a human-friendly view of the same data.

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { runSuiteB } from './suites/suite-b-token-efficiency.js';
import type { RunResult, SuiteResult, SuiteId } from './types.js';

const RESULTS_DIR = join(import.meta.dir, 'results');

interface RunOptions {
  /** Restrict to a single suite, or omit to run all available. */
  suite?: SuiteId;
  /** Optional override for the project scope passed to each suite. */
  project?: string;
  /** When true, do not write results to disk — return only. */
  dryRun?: boolean;
}

interface RunOutput {
  result: RunResult;
  jsonlPath?: string;
  markdownPath?: string;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function dispatchSuite(suite: SuiteId, project?: string): Promise<SuiteResult | null> {
  switch (suite) {
    case 'B':
      return runSuiteB({ project });
    case 'A':
    case 'C':
    case 'D':
    case 'E':
      // Stub — these suites are planned but not implemented in this slice.
      // Returning null lets the runner skip them cleanly.
      return null;
  }
}

export async function runBenchmarks(options: RunOptions = {}): Promise<RunOutput> {
  const startedAt = new Date().toISOString();

  const suiteIds: SuiteId[] = options.suite ? [options.suite] : ['A', 'B', 'C', 'D', 'E'];
  const suites: SuiteResult[] = [];

  for (const id of suiteIds) {
    const result = await dispatchSuite(id, options.project);
    if (result) suites.push(result);
  }

  const finishedAt = new Date().toISOString();

  const recallVersion = await readVersion();
  const result: RunResult = {
    startedAt,
    finishedAt,
    recallVersion,
    hostInfo: {
      platform: `${process.platform}-${process.arch}`,
      bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
    },
    suites,
  };

  if (options.dryRun) return { result };

  const slug = timestampSlug();
  const suiteSuffix = options.suite ? `suite-${options.suite}` : 'all';
  const jsonlPath = join(RESULTS_DIR, `${slug}-${suiteSuffix}.jsonl`);
  const markdownPath = join(RESULTS_DIR, `${slug}-${suiteSuffix}.md`);

  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, JSON.stringify(result) + '\n', 'utf-8');
  writeFileSync(markdownPath, renderMarkdown(result), 'utf-8');

  return { result, jsonlPath, markdownPath };
}

async function readVersion(): Promise<string> {
  // Avoid importing src/version.ts so this file stays runnable from a cold tree.
  try {
    const pkgPath = join(import.meta.dir, '..', 'package.json');
    if (existsSync(pkgPath)) {
      const { readFileSync } = await import('fs');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      return String(pkg.version ?? 'unknown');
    }
  } catch {
    // Non-fatal
  }
  return 'unknown';
}

export function renderMarkdown(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Recall Benchmark Run`);
  lines.push('');
  lines.push(`- **Started:** ${result.startedAt}`);
  lines.push(`- **Finished:** ${result.finishedAt}`);
  lines.push(`- **Recall version:** ${result.recallVersion}`);
  lines.push(`- **Host:** ${result.hostInfo.platform} (Bun ${result.hostInfo.bunVersion})`);
  lines.push('');

  if (result.suites.length === 0) {
    lines.push('_No suites ran._');
    return lines.join('\n');
  }

  for (const suite of result.suites) {
    lines.push(`## Suite ${suite.suite} — ${suite.name}`);
    lines.push('');
    lines.push(suite.description);
    lines.push('');
    lines.push(`_Ran in ${suite.durationMs} ms at ${suite.ranAt}._`);
    lines.push('');

    if (suite.samples.length === 0) {
      lines.push('_No samples produced._');
    } else {
      lines.push('| Metric | Value | Unit | Scope | vs Baseline |');
      lines.push('|---|---:|---|---|---|');
      for (const s of suite.samples) {
        const baseline = s.vsBaseline
          ? `${s.vsBaseline.baseline}: ${s.vsBaseline.delta >= 0 ? '+' : ''}${s.vsBaseline.delta} (${s.vsBaseline.deltaPct.toFixed(1)}%)`
          : '—';
        lines.push(`| ${s.name} | ${s.value} | ${s.unit} | ${s.scope ?? '—'} | ${baseline} |`);
      }
    }
    lines.push('');

    if (suite.caveats.length > 0) {
      lines.push('### Caveats');
      lines.push('');
      for (const c of suite.caveats) lines.push(`- ${c}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('_All metrics are unblended. We do not publish composite scores. See the per-suite caveats before drawing conclusions._');

  return lines.join('\n');
}

// Direct execution: `bun run benchmarks/runner.ts [suite] [project]`
const runsAsScript = process.argv[1]?.endsWith('runner.ts');
if (runsAsScript) {
  const suiteArg = process.argv[2] as SuiteId | undefined;
  const project = process.argv[3];
  runBenchmarks({ suite: suiteArg, project }).then((out) => {
    if (out.markdownPath) {
      console.log(`Wrote ${out.jsonlPath}`);
      console.log(`Wrote ${out.markdownPath}`);
    } else {
      console.log(JSON.stringify(out.result, null, 2));
    }
  }).catch((err) => {
    console.error(`Benchmark run failed: ${err}`);
    process.exit(1);
  });
}
