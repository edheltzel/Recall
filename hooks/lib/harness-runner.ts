// Shared harness call. Hooks import this file; src/ re-exports it.
// Named calls use the production callers below. An injected caller overrides one id.
// An id with no proven stdin contract does not spawn.

import { execFile, execFileSync } from 'child_process';
import type { HarnessStep, LocalQueryMode, NamedHarnessId } from './extractor-config';
import { findClaudeCli } from './hosts/claude/extraction-provider';

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
  env?: NodeJS.ProcessEnv;
}

export type SpawnFailureCode = 'missing' | 'timeout' | 'exit' | 'empty' | 'error';

export type SpawnOutcome =
  | { ok: true; stdout: string }
  | { ok: false; code: SpawnFailureCode; message: string };

export type SpawnFn = (request: SpawnRequest) => SpawnOutcome;

export interface ProvenCall {
  executable: string;
  argv: string[];
  env?: NodeJS.ProcessEnv;
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

const PRODUCTION_PROVEN: Partial<Record<NamedHarnessId, ProvenCaller>> = {
  claude: (model) => ({
    executable: findClaudeCli() ?? 'claude',
    argv: ['-p', '--model', model, '--output-format', 'text', '--setting-sources', ''],
    env: { CLAUDECODE: '' },
  }),
  // Pi print mode: piped stdin is the prompt when no message argument is passed.
  pi: (model) => ({
    executable: 'pi',
    argv: ['--print', '--model', model],
  }),
  // codex exec help: pass `-` and the instructions are read from stdin.
  codex: (model) => ({
    executable: 'codex',
    argv: ['exec', '-m', model, '-'],
  }),
};

function defaultSpawn(request: SpawnRequest): SpawnOutcome {
  try {
    const options: { input: string; encoding: 'utf-8'; timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {
      input: request.stdin,
      encoding: 'utf-8',
      timeout: request.timeoutMs,
    };
    if (request.maxBuffer !== undefined) options.maxBuffer = request.maxBuffer;
    if (request.env) options.env = { ...process.env, ...request.env };
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

const DEFAULT_MAX_BUFFER = 1024 * 1024;

function defaultSpawnAsync(request: SpawnRequest): Promise<SpawnOutcome> {
  const options: { encoding: 'utf-8'; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv } = {
    encoding: 'utf-8',
    timeout: request.timeoutMs,
    maxBuffer: request.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
  if (request.env) options.env = { ...process.env, ...request.env };
  const { promise, resolve } = Promise.withResolvers<SpawnOutcome>();
  const child = execFile(request.executable, request.argv, options, (error, stdout) => {
    if (!error) {
      resolve(stdout.trim() ? { ok: true, stdout } : { ok: false, code: 'empty', message: 'empty stdout' });
      return;
    }
    const code = 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') resolve({ ok: false, code: 'missing', message: 'binary not found' });
    else if (code === 'ETIMEDOUT') resolve({ ok: false, code: 'timeout', message: 'timed out' });
    else resolve({ ok: false, code: 'exit', message: 'call failed' });
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(request.stdin);
  return promise;
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
  const request = spawnRequest(call.executable, call.argv, input, call.env);
  const first = spawn(request);
  if (first.ok || first.code !== 'missing' || !isTTY) return finish(first);
  const path = input.readPath?.().trim() ?? '';
  if (!path) return { ok: false, error: 'binary not found' };
  const retry = spawn(spawnRequest(path, call.argv, input, call.env));
  return finish(retry, path);
}

export async function runHarnessStepAsync(input: RunHarnessInput): Promise<RunResult> {
  if (input.step.kind === 'local') return { ok: true, local: input.step.mode };
  const spawn = input.spawn
    ? (request: SpawnRequest) => Promise.resolve(input.spawn!(request))
    : defaultSpawnAsync;
  const isTTY = input.isTTY ?? false;
  const call = resolveCall(input);
  if (!call.ok) return call;
  const first = await spawn(spawnRequest(call.executable, call.argv, input, call.env));
  if (first.ok || first.code !== 'missing' || !isTTY) return finish(first);
  const path = input.readPath?.().trim() ?? '';
  if (!path) return { ok: false, error: 'binary not found' };
  return finish(await spawn(spawnRequest(path, call.argv, input, call.env)), path);
}

function resolveCall(
  input: RunHarnessInput,
): { ok: true; executable: string; argv: string[]; env?: NodeJS.ProcessEnv } | { ok: false; error: string } {
  const step = input.step;
  if (step.kind === 'command') {
    const [executable, ...argv] = step.argv;
    if (!executable) return { ok: false, error: 'command argv is empty' };
    return { ok: true, executable, argv };
  }
  if (step.kind !== 'named') return { ok: false, error: 'unsupported step' };
  const model = step.model.trim() || input.defaults?.[step.id] || RECALL_HARNESS_DEFAULTS[step.id] || '';
  if (!model) return { ok: false, error: `no Recall default for ${step.id}` };
  const proven = { ...PRODUCTION_PROVEN, ...input.proven };
  const call = proven[step.id]?.(model) ?? null;
  if (!call) return { ok: false, error: `${step.id} is not a proven call` };
  return { ok: true, executable: call.executable, argv: call.argv, env: call.env };
}

function spawnRequest(
  executable: string,
  argv: string[],
  input: RunHarnessInput,
  env?: NodeJS.ProcessEnv,
): SpawnRequest {
  const request: SpawnRequest = {
    executable,
    argv,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
  };
  if (input.maxBuffer !== undefined) request.maxBuffer = input.maxBuffer;
  if (env) request.env = env;
  return request;
}
