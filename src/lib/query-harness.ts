// Query harness sits in front of local search. It does not wrap hybridSearch.
import {
  resolveHarnessConfig,
  type HarnessList,
  type LocalQueryMode,
  type NamedHarnessId,
} from './extractor-config.js';
import {
  runHarnessStepAsync,
  type ProvenCaller,
  type SpawnFn,
} from './harness-runner.js';

const QUERY_TIMEOUT_MS = 30000;

export type QueryHarnessAnswer =
  | { kind: 'local'; mode: LocalQueryMode }
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: string };

export interface QueryHarnessOptions {
  fileText?: string | null;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  readPath?: () => string;
  spawn?: SpawnFn;
  proven?: Partial<Record<NamedHarnessId, ProvenCaller>>;
}

export function unqualifiedQueryRoute(flags: { keyword?: boolean; vector?: boolean }): 'keyword' | 'semantic' | 'configured' {
  if (flags.keyword) return 'keyword';
  if (flags.vector) return 'semantic';
  return 'configured';
}

export async function resolveQueryHarness(
  question: string,
  options: QueryHarnessOptions = {},
): Promise<QueryHarnessAnswer> {
  const resolved = resolveHarnessConfig({
    fileText: options.fileText,
    env: options.env,
  });
  const query = resolved.query;
  if (!query.ok) return { kind: 'error', error: query.error };
  if (query.absent) return { kind: 'local', mode: 'hybrid' };
  return walkQuery(question, query.value, options);
}

async function walkQuery(
  question: string,
  list: HarnessList,
  options: QueryHarnessOptions,
): Promise<QueryHarnessAnswer> {
  let lastError = 'query harness failed';
  for (const step of [list.primary, ...list.fallback]) {
    if (step.kind === 'local') return { kind: 'local', mode: step.mode };
    const result = await runHarnessStepAsync({
      step,
      stdin: question,
      timeoutMs: QUERY_TIMEOUT_MS,
      isTTY: options.isTTY ?? false,
      readPath: options.readPath,
      spawn: options.spawn,
      proven: options.proven,
    });
    if (result.ok && 'text' in result) return { kind: 'text', text: result.text };
    if (result.ok && 'local' in result) return { kind: 'local', mode: result.local };
    if (!result.ok) lastError = result.error;
  }
  return { kind: 'error', error: lastError };
}
