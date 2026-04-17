// mem benchmark — Phase 2 benchmarking CLI integration.
//
// Thin wrapper over benchmarks/runner.ts. We keep the actual implementation
// outside src/ so the CLI binary stays small and benchmarks can be run
// directly with `bun run benchmarks/runner.ts` without depending on the dist
// build.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SUITES_AVAILABLE = [
  { id: 'A', name: 'Cross-session recall', status: 'planned' },
  { id: 'B', name: 'Token efficiency', status: 'built' },
  { id: 'C', name: 'Precision under noise', status: 'planned' },
  { id: 'D', name: 'Structured-knowledge fidelity', status: 'planned' },
  { id: 'E', name: 'Real-world replay', status: 'planned' },
] as const;

type SuiteId = typeof SUITES_AVAILABLE[number]['id'];

interface RunBenchmarkOptions {
  suite?: string;
  project?: string;
}

function findBenchmarksDir(): string | null {
  // From dist/, repo root is one level up. From `bun run` with the CLI in
  // src/, root is the project root. Walk up from cwd looking for the dir.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'benchmarks', 'runner.ts');
    if (existsSync(candidate)) return join(dir, 'benchmarks');
    const next = join(dir, '..');
    if (next === dir) break;
    dir = next;
  }
  return null;
}

export async function runBenchmark(options: RunBenchmarkOptions = {}): Promise<void> {
  const dir = findBenchmarksDir();
  if (!dir) {
    console.error('Benchmark harness not found. The benchmarks/ directory must be present in the project root.');
    process.exit(1);
  }

  const suite = (options.suite || '').toUpperCase() as SuiteId | '';
  if (suite && !SUITES_AVAILABLE.some(s => s.id === suite)) {
    console.error(`Unknown suite: ${options.suite}. Run 'mem benchmark list' to see available suites.`);
    process.exit(1);
  }

  // Defer the actual harness load — it imports bun:sqlite and other things
  // we don't want to drag into the main CLI bundle unless asked.
  const runnerPath = join(dir, 'runner.ts');
  const { runBenchmarks } = await import(runnerPath);

  const out = await runBenchmarks({
    suite: suite || undefined,
    project: options.project,
  });

  if (out.markdownPath) {
    console.log(`Wrote ${out.jsonlPath}`);
    console.log(`Wrote ${out.markdownPath}`);
    console.log('');
    console.log(readFileSync(out.markdownPath, 'utf-8'));
  } else {
    console.log(JSON.stringify(out.result, null, 2));
  }
}

export function listBenchmarks(): void {
  console.log('Available benchmark suites:\n');
  for (const s of SUITES_AVAILABLE) {
    const tag = s.status === 'built' ? '✓' : '·';
    console.log(`  ${tag} ${s.id}  ${s.name.padEnd(36)} ${s.status}`);
  }
  console.log('');
  console.log("Run with 'mem benchmark run <suite-id>' (e.g. 'mem benchmark run B').");
}

export function reportLatestBenchmark(): void {
  const dir = findBenchmarksDir();
  if (!dir) {
    console.error('Benchmark harness not found.');
    process.exit(1);
  }
  const resultsDir = join(dir, 'results');
  if (!existsSync(resultsDir)) {
    console.log('No benchmark results yet. Run `mem benchmark run` first.');
    return;
  }
  const mdFiles = readdirSync(resultsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, path: join(resultsDir, f), mtime: statSync(join(resultsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (mdFiles.length === 0) {
    console.log('No benchmark results yet. Run `mem benchmark run` first.');
    return;
  }
  console.log(`# Latest benchmark report: ${mdFiles[0].name}\n`);
  console.log(readFileSync(mdFiles[0].path, 'utf-8'));
}
