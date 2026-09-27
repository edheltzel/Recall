// Shared harness call. Hooks import this file; src/ re-exports it.
// Named calls run only through an injected proven caller. An unknown id does not spawn.

import { execFileSync } from 'child_process';
import type { HarnessStep, LocalQueryMode, NamedHarnessId } from './extractor-config';

// ponytail: only Claude has a model string already used by Recall. Other ids fail closed until a default is added.
export const RECALL_HARNESS_DEFAULTS: Partial<Record<NamedHarnessId, string>> = {
  claude: 'haiku',
};

export interface SpawnRequest {
  executable: string;
  argv: string[];
  stdin: string;
  timeoutMs: number;
  maxBuffer?: number;
}

export type SpawnFailureCode = 'missing' | 'timeout' | 'exit' | 'empty' | 'error';

export type SpawnOutcome =
  | { ok: true; stdout: string }
  | { ok: false; code: SpawnFailureCode; message: string };

export type SpawnFn = (request: SpawnRequest) => SpawnOutcome;

export interface ProvenCall {
  executable: string;
  argv: string[];
}

export type ProvenCaller = (model: string) => ProvenCall | null;

export type RunResult =
  | { ok: true; text: string }
  | { ok: true; local: LocalQueryMode }
  | { ok: false; error: string };

export interface RunHarnessInput {
  step: HarnessStep;
  stdin: string;
  timeoutMs: number;
  maxBuffer?: number;
  isTTY?: boolean;
  readPath?: () => string;
  spawn?: SpawnFn;
  proven?: Partial<Record<NamedHarnessId, ProvenCaller>>;
  defaults?: Partial<Record<NamedHarnessId, string>>;
}

function defaultSpawn(request: SpawnRequest): SpawnOutcome {
  try {
    const options: { input: string; encoding: 'utf-8'; timeout: number; maxBuffer?: number } = {
      input: request.stdin,
      encoding: 'utf-8',
      timeout: request.timeoutMs,
    };
    if (request.maxBuffer !== undefined) options.maxBuffer = request.maxBuffer;
    const stdout = execFileSync(request.executable, request.argv, options);
    if (!stdout.trim()) return { ok: false, code: 'empty', message: 'empty stdout' };
    return { ok: true, stdout };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return { ok: false, code: 'missing', message: 'binary not found' };
    if (code === 'ETIMEDOUT') return { ok: false, code: 'timeout', message: 'timed out' };
    return { ok: false, code: 'exit', message: 'call failed' };
  }
}

function hide(message: string, secret: string): string {
  return secret ? message.split(secret).join('[path]') : message;
}

function finish(outcome: SpawnOutcome, secret = ''): RunResult {
  if (outcome.ok) {
    const text = outcome.stdout.trim();
    return text ? { ok: true, text } : { ok: false, error: 'empty stdout' };
  }
  return { ok: false, error: hide(outcome.message, secret) };
}

export function runHarnessStep(input: RunHarnessInput): RunResult {
  if (input.step.kind === 'local') return { ok: true, local: input.step.mode };
  const spawn = input.spawn ?? defaultSpawn;
  const isTTY = input.isTTY ?? process.stdin?.isTTY === true;
  const call = resolveCall(input);
  if (!call.ok) return call;
  const request = spawnRequest(call.executable, call.argv, input);
  const first = spawn(request);
  if (first.ok || first.code !== 'missing' || !isTTY) return finish(first);
  const path = input.readPath?.().trim() ?? '';
  if (!path) return { ok: false, error: 'binary not found' };
  const retry = spawn(spawnRequest(path, call.argv, input));
  return finish(retry, path);
}

function resolveCall(
  input: RunHarnessInput,
): { ok: true; executable: string; argv: string[] } | { ok: false; error: string } {
  const step = input.step;
  if (step.kind === 'command') {
    const [executable, ...argv] = step.argv;
    if (!executable) return { ok: false, error: 'command argv is empty' };
    return { ok: true, executable, argv };
  }
  if (step.kind !== 'named') return { ok: false, error: 'unsupported step' };
  const model = step.model.trim() || input.defaults?.[step.id] || RECALL_HARNESS_DEFAULTS[step.id] || '';
  if (!model) return { ok: false, error: `no Recall default for ${step.id}` };
  const proven = input.proven?.[step.id];
  const call = proven?.(model) ?? null;
  if (!call) return { ok: false, error: `${step.id} is not a proven call` };
  return { ok: true, executable: call.executable, argv: call.argv };
}

function spawnRequest(
  executable: string,
  argv: string[],
  input: RunHarnessInput,
): SpawnRequest {
  const request: SpawnRequest = {
    executable,
    argv,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
  };
  if (input.maxBuffer !== undefined) request.maxBuffer = input.maxBuffer;
  return request;
}
