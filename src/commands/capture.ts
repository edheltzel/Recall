// Public `recall capture` — versioned ambient ingress (contract 1).
// Flags and stdin JSON share one validator, then feed host-ingest as raw text.

import { existsSync, readFileSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  ingestHostTranscript,
  type HostIngestResult,
  type HostTranscript,
} from '../lib/host-ingest.js';

export const CAPTURE_CONTRACT = 1;
export const CAPTURE_EVENTS = ['turn_end', 'session_end'] as const;
export type CaptureEvent = (typeof CAPTURE_EVENTS)[number];

/** KTD2: lowercase [a-z][a-z0-9-]{0,63}. Rejects empty, uppercase, underscores, spaces, path-like ids. */
export const HARNESS_ID = /^[a-z][a-z0-9-]{0,63}$/;

const MAX_CAPTURE_BYTES = 25 * 1024 * 1024;

export class CaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureValidationError';
  }
}

export interface CaptureCliOptions {
  contract?: string;
  harness?: string;
  event?: string;
  sessionId?: string;
  cwd?: string;
  project?: string;
  text?: string;
  textFile?: string;
}

export interface CapturePayload {
  contract: number;
  harness: string;
  event: CaptureEvent;
  text: string;
  sessionId?: string;
  cwd?: string;
  project?: string;
}

function usingFlagForm(options: CaptureCliOptions): boolean {
  return [
    options.harness,
    options.event,
    options.text,
    options.textFile,
    options.sessionId,
    options.cwd,
    options.project,
  ].some(value => value !== undefined);
}

async function readStdin(maxBytes = MAX_CAPTURE_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new CaptureValidationError(`capture payload exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function readTextFile(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new CaptureValidationError(`capture text file not found: ${path}`);
  }
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CAPTURE_BYTES) {
    throw new CaptureValidationError(`capture text file exceeds ${MAX_CAPTURE_BYTES} bytes`);
  }
  return readFileSync(path, 'utf-8');
}

function parseCaptureJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new CaptureValidationError('capture stdin must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptureValidationError('capture stdin must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function normalizeContract(value: unknown): number {
  if (value === undefined || value === null || value === '') return CAPTURE_CONTRACT;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new CaptureValidationError(
    `unsupported capture contract: ${String(value)} (expected ${CAPTURE_CONTRACT})`
  );
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new CaptureValidationError(`capture ${field} must be a string`);
  }
  return value;
}

export function validateCapturePayload(raw: Record<string, unknown>): CapturePayload {
  const contract = normalizeContract(raw.contract);
  if (contract !== CAPTURE_CONTRACT) {
    throw new CaptureValidationError(
      `unsupported capture contract: ${String(raw.contract)} (expected ${CAPTURE_CONTRACT})`
    );
  }

  if (typeof raw.harness !== 'string' || !raw.harness) {
    throw new CaptureValidationError('capture requires harness');
  }
  if (!HARNESS_ID.test(raw.harness)) {
    throw new CaptureValidationError(`invalid harness id: ${raw.harness}`);
  }

  if (typeof raw.event !== 'string' || !(CAPTURE_EVENTS as readonly string[]).includes(raw.event)) {
    throw new CaptureValidationError(
      `invalid capture event: ${String(raw.event ?? '')} (expected turn_end or session_end)`
    );
  }

  if (typeof raw.text !== 'string' || !raw.text.trim()) {
    throw new CaptureValidationError('capture text is empty');
  }
  if (Buffer.byteLength(raw.text, 'utf-8') > MAX_CAPTURE_BYTES) {
    throw new CaptureValidationError(`capture text exceeds ${MAX_CAPTURE_BYTES} bytes`);
  }

  const sessionId = optionalString(raw.session_id ?? raw.sessionId, 'session_id');
  if (sessionId !== undefined && (sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(sessionId))) {
    throw new CaptureValidationError('invalid session_id');
  }

  return {
    contract,
    harness: raw.harness,
    event: raw.event as CaptureEvent,
    text: raw.text,
    sessionId,
    cwd: optionalString(raw.cwd, 'cwd'),
    project: optionalString(raw.project, 'project'),
  };
}

export function ingestCaptureText(payload: CapturePayload): HostIngestResult {
  const input: HostTranscript = {
    source: payload.harness,
    sessionId: payload.sessionId ?? randomUUID(),
    messages: [{
      role: 'user',
      content: payload.text,
      sourcePosition: payload.harness === 'grok' || payload.harness === 'omp' ? 0 : undefined,
    }],
    cwd: payload.cwd,
    project: payload.project,
    incremental: false,
    reconcileComplete: true,
    finalize: true,
  };
  return ingestHostTranscript(input);
}

export async function runCapture(options: CaptureCliOptions): Promise<void> {
  let raw: Record<string, unknown>;

  if (usingFlagForm(options)) {
    if (options.text !== undefined && options.textFile !== undefined) {
      throw new CaptureValidationError('provide only one of --text or --text-file');
    }
    let text = options.text;
    if (options.textFile !== undefined) {
      text = readTextFile(options.textFile);
    } else if (text === undefined) {
      text = await readStdin();
    }
    raw = {
      contract: options.contract,
      harness: options.harness,
      event: options.event,
      text,
      session_id: options.sessionId,
      cwd: options.cwd,
      project: options.project,
    };
  } else {
    raw = parseCaptureJson(await readStdin());
    if (options.contract !== undefined) raw.contract = options.contract;
  }

  const payload = validateCapturePayload(raw);
  const result = ingestCaptureText(payload);
  if (result.redactions.length) {
    process.stderr.write(`Recall redacted: ${result.redactions.join(', ')}\n`);
  }
}
