// Native omp extension: session_stop → package-local `bun dist/index.js capture`.
// Self-contained — no src/ imports, no @oh-my-pi runtime import.

import { spawn } from 'node:child_process';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import type { z } from 'zod';
import { scrub } from '../../hooks/lib/write-safety';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'index.js');
const CHILD_TIMEOUT_MS = 30_000;

export const MAX_OMP_STDIN_BYTES = 25 * 1024 * 1024;

/** Head fraction borrowed from oh-my-pi snapcompact TRUNCATE_HEAD_RATIO (MIT). */
const TRUNCATE_HEAD_RATIO = 0.6;
const TRUNCATION_MARKER = '\n\n[Recall omp capture truncated]\n\n';

function captureStdin(text: string, sessionId: string, cwd: string): string {
  return JSON.stringify({
    contract: 1,
    harness: 'omp',
    event: 'turn_end',
    text,
    session_id: sessionId,
    cwd,
  });
}

function escapedStep(text: string, index: number): { next: number; utf8: number; escaped: number } {
  const lead = text.charCodeAt(index);
  if (lead >= 0xd800 && lead <= 0xdbff && index + 1 < text.length) {
    const tail = text.charCodeAt(index + 1);
    if (tail >= 0xdc00 && tail <= 0xdfff) return { next: index + 2, utf8: 4, escaped: 4 };
  }
  if (lead <= 0x1f) {
    const short = lead === 0x08 || lead === 0x09 || lead === 0x0a || lead === 0x0c || lead === 0x0d;
    return { next: index + 1, utf8: 1, escaped: short ? 2 : 6 };
  }
  if (lead === 0x22 || lead === 0x5c) return { next: index + 1, utf8: 1, escaped: 2 };
  if (lead >= 0xd800 && lead <= 0xdfff) return { next: index + 1, utf8: 3, escaped: 6 };
  if (lead <= 0x7f) return { next: index + 1, utf8: 1, escaped: 1 };
  if (lead <= 0x7ff) return { next: index + 1, utf8: 2, escaped: 2 };
  return { next: index + 1, utf8: 3, escaped: 3 };
}

function measure(text: string): { utf8: number; escaped: number } {
  let utf8 = 0;
  let escaped = 0;
  for (let index = 0; index < text.length;) {
    const step = escapedStep(text, index);
    utf8 += step.utf8;
    escaped += step.escaped;
    index = step.next;
  }
  return { utf8, escaped };
}

function takeHead(text: string, budget: number): { end: number; utf8: number } {
  let escaped = 0;
  let utf8 = 0;
  let index = 0;
  while (index < text.length) {
    const step = escapedStep(text, index);
    if (escaped + step.escaped > budget) break;
    escaped += step.escaped;
    utf8 += step.utf8;
    index = step.next;
  }
  return { end: index, utf8 };
}

function takeTail(text: string, budget: number, minStart: number): { start: number; utf8: number } {
  let escaped = 0;
  let utf8 = 0;
  let index = text.length;
  while (index > minStart) {
    let start = index - 1;
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff && start > minStart) {
      const lead = text.charCodeAt(start - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) start -= 1;
    }
    if (start < minStart) break;
    const step = escapedStep(text, start);
    if (step.next !== index || escaped + step.escaped > budget) break;
    escaped += step.escaped;
    utf8 += step.utf8;
    index = start;
  }
  return { start: index, utf8 };
}

function cutForBudget(text: string, keptEscaped: number): { head: string; tail: string; keptUtf8: number } {
  const headBudget = Math.floor(keptEscaped * TRUNCATE_HEAD_RATIO);
  const head = takeHead(text, headBudget);
  const tail = takeTail(text, keptEscaped - headBudget, head.end);
  return {
    head: text.slice(0, head.end),
    tail: text.slice(tail.start),
    keptUtf8: head.utf8 + tail.utf8,
  };
}

/** Keep head 60% / tail 40% of the escaped payload budget. Two streaming scans, one serialize. */
function trimCaptureText(
  text: string,
  sessionId: string,
  cwd: string,
): { text: string; dropped: number } | undefined {
  const measured = measure(text);
  const empty = Buffer.byteLength(captureStdin('', sessionId, cwd), 'utf8');
  const markerEscaped = measure(TRUNCATION_MARKER).escaped;
  if (empty + measured.escaped <= MAX_OMP_STDIN_BYTES) return undefined;

  const keptEscaped = Math.max(0, MAX_OMP_STDIN_BYTES - empty - markerEscaped);
  const cut = cutForBudget(text, keptEscaped);
  return {
    text: `${cut.head}${TRUNCATION_MARKER}${cut.tail}`,
    dropped: measured.utf8 - cut.keptUtf8,
  };
}

export interface OmpSessionStopEvent {
  signal?: AbortSignal;
}

export interface OmpExtensionContext {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
    confirm?: (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean>;
  };
  sessionManager: {
    getSessionId: () => string;
    getBranch: (fromId?: string) => unknown[];
  };
}

export interface OmpToolResult {
  content: { type: 'text'; text: string }[];
}

export interface OmpExtensionAPI {
  on(
    event: 'session_stop',
    handler: (event: OmpSessionStopEvent, ctx: OmpExtensionContext) => unknown,
  ): void;
  registerTool?(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: RecallDumpParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: OmpExtensionContext,
    ): Promise<OmpToolResult>;
  }): void;
  zod?: typeof z;
  logger?: { warn: (message: string) => void };
}

export interface RecallDumpParams {
  title: string;
  project?: string;
  tags?: string;
  continues?: number;
  skip_fabric?: boolean;
}

export type RunBoundedChild = (
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
  onOutput?: (chunk: string) => void,
) => Promise<number | null>;

function warn(ctx: OmpExtensionContext, pi: OmpExtensionAPI | undefined, message: string): void {
  try {
    if (ctx.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(message, 'warning');
      return;
    }
  } catch {
    // fall through to logger/stderr
  }
  try {
    pi?.logger?.warn(message);
  } catch {
    // ignore
  }
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // ignore
  }
}

/** Spawn a child, write stdin, honor abort (SIGTERM then SIGKILL). `onOutput` opts into stdout+stderr. */
export function runBoundedChild(
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<number | null> {
  if (signal.aborted) return Promise.resolve(null);

  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const output = onOutput ? 'pipe' : 'ignore';
  const child = spawn(file, [...args], { stdio: ['pipe', output, output] });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8').on('data', (chunk: string) => onOutput?.(chunk));
  }

  const onAbort = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 500);
  };

  const settle = (err: Error | null, code: number | null) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    clearTimeout(killTimer);
    if (err) reject(err);
    else resolve(code);
  };

  child.once('error', err => settle(err, null));
  child.once('close', code => settle(null, code));

  child.stdin?.on('error', () => {
    // EPIPE after kill / early exit — do not reject
  });
  child.stdin?.end(stdin, 'utf8');

  signal.addEventListener('abort', onAbort, { once: true });

  return promise;
}

const SKIP_ROLES: Record<string, true> = {
  developer: true, system: true, toolResult: true, bashExecution: true,
  pythonExecution: true, fileMention: true, hookMessage: true,
};

function ompMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new Error('omp lifecycle capture received a malformed session entry');
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const row = part as Record<string, unknown>;
    if (typeof row.type !== 'string' || !row.type) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    if (row.type !== 'text') continue;
    if (typeof row.text !== 'string') {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    if (row.text) parts.push(row.text);
  }
  return parts.join('\n');
}

export interface OmpMessage { role: 'user' | 'assistant'; content: string; timestamp?: string }

/** Ordered user/assistant messages. Malformed branches throw so capture/dump is not partial. */
export function ompBranchMessages(entries: unknown): OmpMessage[] {
  if (!Array.isArray(entries)) {
    throw new Error('omp lifecycle capture requires an entries array');
  }
  const messages: OmpMessage[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.type !== 'string' || !row.type) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const nativeId = typeof row.id === 'string' && row.id ? row.id : undefined;
    if (nativeId) {
      if (seenIds.has(nativeId)) {
        throw new Error('omp lifecycle capture received duplicate native ids');
      }
      seenIds.add(nativeId);
    }
    if (row.type !== 'message') continue;
    if (!nativeId || !row.message || typeof row.message !== 'object' || Array.isArray(row.message)) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const message = row.message as Record<string, unknown>;
    if (typeof message.role !== 'string' || !message.role) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    if (Object.hasOwn(SKIP_ROLES, message.role)) continue;
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const content = ompMessageText(message.content);
    if (!content.trim()) continue;
    messages.push({
      role: message.role,
      content,
      timestamp: typeof row.timestamp === 'string' && row.timestamp ? row.timestamp : undefined,
    });
  }
  return messages;
}

const OMP_CURATED_DESCRIPTION = 'Curated fabric extraction from omp session end.';

function ompLoaLockPath(sessionId: string): string {
  const dir = process.env.RECALL_HOME || join(homedir(), '.agents', 'Recall');
  return join(dir, `omp-loa-${sessionId}.pid`);
}

function recallDbPath(): string {
  const home = homedir();
  const raw = process.env.RECALL_DB_PATH;
  if (!raw) return join(home, '.agents', 'Recall', 'recall.db');
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return home + raw.slice(1);
  return raw;
}

/** True when the Curated snapshot is missing or behind the lifecycle high-water. Read-only. */
export function curatedSnapshotBehind(sessionId: string): boolean {
  let db: Database;
  try {
    db = new Database(recallDbPath(), { readonly: true });
  } catch {
    return false;
  }
  try {
    const hw = db.query<{ id: number | null }, [string]>(`
      SELECT MAX(message_id) AS id FROM active_host_ingest_messages
      WHERE source = 'omp' AND session_id = ?
    `).get(sessionId);
    if (!hw?.id) return false;
    const row = db.query<{ snapshot: number | null }, [string, string]>(`
      SELECT snapshot_max_message_id AS snapshot FROM loa_entries
      WHERE session_id = ? AND description = ?
      ORDER BY id DESC LIMIT 1
    `).get(sessionId, OMP_CURATED_DESCRIPTION);
    if (!row) return true;
    return (row.snapshot ?? -1) < hw.id;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function exclusiveLoaLock(sessionId: string): boolean {
  try {
    closeSync(openSync(ompLoaLockPath(sessionId), 'wx'));
    return true;
  } catch {
    return false;
  }
}

function releaseLoaLock(sessionId: string): void {
  try {
    unlinkSync(ompLoaLockPath(sessionId));
  } catch {
    // lock already gone
  }
}

export function spawnLoaOmpEnd(sessionId: string, launch: typeof spawn = spawn): void {
  const child = launch('bun', [CLI_PATH, 'loa', 'omp-end', sessionId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export async function captureOmpSessionStop(
  event: OmpSessionStopEvent,
  ctx: OmpExtensionContext,
  pi?: OmpExtensionAPI,
  runChild: RunBoundedChild = runBoundedChild,
  curatedAhead: (sessionId: string) => boolean = curatedSnapshotBehind,
  acquireLock: (sessionId: string) => boolean = exclusiveLoaLock,
  spawnDetached: (sessionId: string) => void = spawnLoaOmpEnd,
): Promise<void> {
  try {
    if (event.signal?.aborted) {
      warn(ctx, pi, 'Recall omp capture cancelled');
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getBranch();
    if (!sessionId) {
      warn(ctx, pi, 'Recall omp capture failed');
      return;
    }

    let text = scrub(ompBranchMessages(entries).map(message => message.content).join('\n\n')).text;
    if (!text.trim()) return;

    const trimmed = trimCaptureText(text, sessionId, ctx.cwd);
    if (trimmed) {
      text = trimmed.text;
      warn(ctx, pi, `Recall omp capture truncated: ${trimmed.dropped} bytes dropped`);
    }

    const payload = captureStdin(text, sessionId, ctx.cwd);
    if (Buffer.byteLength(payload, 'utf8') > MAX_OMP_STDIN_BYTES) {
      warn(ctx, pi, 'Recall omp capture skipped: payload exceeds 25MiB');
      return;
    }
    const { code, aborted } = await runCli(runChild, ['capture'], payload, event.signal, CHILD_TIMEOUT_MS);
    if (code !== 0) {
      warn(ctx, pi, aborted ? 'Recall omp capture cancelled' : 'Recall omp capture failed');
      return;
    }
    if (aborted) return;
    let locked = false;
    try {
      if (!curatedAhead(sessionId)) return;
      if (!acquireLock(sessionId)) return;
      locked = true;
      spawnDetached(sessionId);
    } catch {
      if (locked) releaseLoaLock(sessionId);
      warn(ctx, pi, 'Recall omp curated extract failed');
    }
  } catch {
    warn(ctx, pi, 'Recall omp capture failed');
  }
}

/** Run the package-local CLI under the caller's signal plus a hard timeout. */
async function runCli(
  runChild: RunBoundedChild,
  args: readonly string[],
  payload: string,
  outer: AbortSignal | undefined,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
): Promise<{ code: number | null; aborted: boolean }> {
  if (outer?.aborted) return { code: null, aborted: true };

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref();
  const signal = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;
  try {
    const code = await runChild('bun', [CLI_PATH, ...args], payload, signal, onOutput);
    return { code, aborted: signal.aborted };
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
}

/** The fabric Extractor can take minutes on a long session. */
const DUMP_TIMEOUT_MS = 5 * 60_000;

/**
 * `recall_dump` tool: the live branch and session id come from omp itself, so the dump
 * matches this conversation on every profile and branch. `recall dump` without this
 * input refuses inside omp rather than guessing from files. Requires user confirmation.
 */
export async function dumpOmpSession(
  params: RecallDumpParams,
  ctx: OmpExtensionContext,
  signal?: AbortSignal,
  runChild: RunBoundedChild = runBoundedChild,
): Promise<OmpToolResult> {
  const reply = (text: string): OmpToolResult => ({ content: [{ type: 'text', text }] });
  try {
    if (signal?.aborted) return reply('Recall dump cancelled');
    // Dumping is always the user's call (agent-skills/AGENTS.md): the model can request
    // it, but nothing is written without a yes in the omp UI. Headless sessions refuse.
    if (!ctx.hasUI || !ctx.ui?.confirm) return reply('Recall dump needs the interactive omp UI to confirm; nothing was saved');
    const approved = await ctx.ui.confirm('Save this conversation to Recall?', `recall dump "${params.title}"`, { signal });
    if (signal?.aborted) return reply('Recall dump cancelled');
    if (!approved) return reply('Recall dump declined; nothing was saved');
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return reply('Recall dump failed: omp did not report a session id');
    const messages = ompBranchMessages(ctx.sessionManager.getBranch());
    if (messages.length === 0) return reply('Recall dump skipped: no user or assistant text in this session yet');
    const payload = JSON.stringify({ contract: 1, harness: 'omp', session_id: sessionId, cwd: ctx.cwd, messages });
    if (Buffer.byteLength(payload, 'utf8') > MAX_OMP_STDIN_BYTES) {
      return reply('Recall dump skipped: conversation text exceeds 25MiB');
    }

    const args = ['dump', '--stdin'];
    if (params.project) args.push('-p', params.project);
    if (params.tags) args.push('-t', params.tags);
    if (params.continues !== undefined) args.push('-c', String(params.continues));
    if (params.skip_fabric) args.push('--skip-fabric');
    // `--` keeps a title like `--help` from being parsed as an option.
    args.push('--', params.title);

    let output = '';
    const { code, aborted } = await runCli(runChild, args, payload, signal, DUMP_TIMEOUT_MS, chunk => {
      output += chunk;
    });
    if (code === 0) return reply(output.trim() || 'Recall dump saved');
    if (aborted) return reply('Recall dump cancelled');
    return reply(`Recall dump failed (exit ${code})${output.trim() ? `\n${output.trim()}` : ''}`);
  } catch (error) {
    if (signal?.aborted) return reply('Recall dump cancelled');
    return reply(`Recall dump failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default function recallOmpExtension(pi: OmpExtensionAPI): void {
  pi.on('session_stop', (event, ctx) => captureOmpSessionStop(event, ctx, pi));
  const z = pi.zod;
  if (!pi.registerTool || !z) return;
  pi.registerTool({
    name: 'recall_dump',
    label: 'Recall dump',
    description: 'Save this omp conversation (its live branch) to Recall and write a Curated LoA entry. Use this for do-recall-dump inside omp.',
    parameters: z.object({
      title: z.string().min(1).describe('Descriptive title for this session'),
      project: z.string().optional().describe('Project name tag'),
      tags: z.string().optional().describe('Comma-separated tags'),
      continues: z.number().int().positive().optional().describe('Previous LoA entry id to chain from'),
      skip_fabric: z.boolean().optional().describe('Write a basic summary instead of running the fabric Extractor'),
    }),
    execute: (_toolCallId, params, signal, _onUpdate, ctx) => dumpOmpSession(params, ctx, signal),
  });
}
