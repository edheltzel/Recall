// Self-contained batch scorer for hooks. Never import from src/.

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

export const JEV_KEY_ENV = 'JEV_RECALL_KEY';

export type JevDisposition = 'keep' | 'demote' | 'drop';

export interface JevDecision {
  choice: JevDisposition;
  probabilities: Record<JevDisposition, number>;
  confidence: number;
}

const DISPOSITIONS: readonly JevDisposition[] = ['keep', 'demote', 'drop'];

const MEANINGS = [
  'keep: store it at normal importance because a later session would need it.',
  'demote: store it at reduced importance because it is real but weak, partial, or soon stale.',
  'drop: do not store it because it has no future recall value.',
];

const CRITERIA = {
  keep: {
    what: 'A durable fact, decision, learning, or project-specific context worth recalling later.',
    not: 'A greeting, acknowledgement, or passing remark with no lasting fact.',
  },
  demote: {
    what: 'Real work context that is weak, incomplete, or soon stale, so lower importance is enough.',
    not: 'A durable fact that later sessions need, or content with no recall value at all.',
  },
  drop: {
    what: 'No future recall value: a greeting, acknowledgement, chit-chat, or text that is not about the work.',
    not: 'Any concrete fact, decision, learning, or project context.',
  },
};

export interface ScoreCandidatesOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface JevBatchCandidate {
  id: string;
  kind: 'decision' | 'learning' | 'breadcrumb';
  text: string;
  project?: string;
  confidence?: 'high' | 'medium' | 'low';
}

export type JevBatchResult =
  | { status: 'skipped'; ids: string[] }
  | { status: 'error'; error: string }
  | { status: 'scored'; decisions: Record<string, JevDecision> };

// The stop hook must not wait on a hung socket.
const BATCH_TIMEOUT_MS = 15_000;
const CANDIDATE_ID = /^[dlb]\d+$/;

function isDisposition(value: unknown): value is JevDisposition {
  return DISPOSITIONS.some(name => name === value);
}

function readProbabilities(value: unknown): Record<JevDisposition, number> {
  if (!value || typeof value !== 'object') {
    throw new Error('Jev response missing probabilities');
  }
  const raw = value as Record<string, unknown>;
  const probabilities = {} as Record<JevDisposition, number>;
  for (const name of DISPOSITIONS) {
    const probability = raw[name];
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
      throw new Error('Jev response missing probabilities');
    }
    probabilities[name] = probability;
  }
  return probabilities;
}

function decisionFromAnswer(answer: unknown): JevDecision {
  if (!answer || typeof answer !== 'object') {
    throw new Error('Jev response missing a keep, demote, or drop choice');
  }
  const record = answer as {
    type?: unknown;
    choice?: unknown;
    probabilities?: unknown;
    confidence?: unknown;
  };
  if (record.type !== 'choice' || !isDisposition(record.choice)) {
    throw new Error('Jev response missing a keep, demote, or drop choice');
  }
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) {
    throw new Error('Jev response missing confidence');
  }
  return {
    choice: record.choice,
    probabilities: readProbabilities(record.probabilities),
    confidence: record.confidence,
  };
}

function presentKey(value: string): string | undefined {
  const key = value.trim();
  return key === '' ? undefined : key;
}

function batchKey(options: ScoreCandidatesOptions): string | undefined {
  if (options.apiKey !== undefined) return presentKey(options.apiKey);
  const raw = (options.env ?? process.env)[JEV_KEY_ENV];
  return typeof raw === 'string' ? presentKey(raw) : undefined;
}

function candidateIdError(candidates: readonly JevBatchCandidate[]): string | undefined {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!CANDIDATE_ID.test(candidate.id)) {
      return 'Jev candidate id must be d<n>, l<n>, or b<n>';
    }
    if (seen.has(candidate.id)) return 'Jev candidates include a duplicate id';
    seen.add(candidate.id);
  }
  return undefined;
}

function candidateFields(candidate: JevBatchCandidate): Record<string, string> {
  const fields: Record<string, string> = {};
  if (candidate.kind) fields.kind = candidate.kind;
  fields.text = candidate.text;
  if (candidate.project) fields.project = candidate.project;
  if (candidate.confidence) fields.confidence = candidate.confidence;
  return fields;
}

function instructionsFor(id: string): string {
  return [
    `Should the candidate at \`candidates.${id}.text\` be kept, demoted, or dropped when Recall ingests it?`,
    ...MEANINGS,
    'Use kind and project on that same candidate when those fields are present.',
  ].join(' ');
}

function batchState(candidates: readonly JevBatchCandidate[]): {
  candidates: Record<string, Record<string, string>>;
} {
  const records: Record<string, Record<string, string>> = {};
  for (const candidate of candidates) records[candidate.id] = candidateFields(candidate);
  return { candidates: records };
}

function batchQuestions(candidates: readonly JevBatchCandidate[]): Record<string, {
  type: 'choice';
  instructions: string;
  criteria: typeof CRITERIA;
}> {
  const questions: Record<string, {
    type: 'choice';
    instructions: string;
    criteria: typeof CRITERIA;
  }> = {};
  for (const candidate of candidates) {
    questions[candidate.id] = {
      type: 'choice',
      instructions: instructionsFor(candidate.id),
      criteria: CRITERIA,
    };
  }
  return questions;
}

function readBatch(body: unknown, ids: readonly string[]): Record<string, JevDecision> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Jev response missing a keep, demote, or drop choice');
  }
  const answers = (body as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('Jev response missing a keep, demote, or drop choice');
  }
  const map = answers as Record<string, unknown>;
  const decisions: Record<string, JevDecision> = {};
  for (const id of ids) {
    if (!Object.hasOwn(map, id)) {
      throw new Error(`Jev response missing an answer for ${id}`);
    }
    decisions[id] = decisionFromAnswer(map[id]);
  }
  return decisions;
}

function failure(error: string): JevBatchResult {
  return { status: 'error', error };
}

function redact(message: string, apiKey: string): string {
  if (apiKey.length > 0 && message.includes(apiKey)) return 'Jev request failed';
  return message;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function startTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  (timer as { unref?: () => void }).unref?.();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function transportError(error: unknown, apiKey: string): string {
  if (!(error instanceof Error) || error.message.trim() === '') return 'Jev request failed';
  if (apiKey.length > 0 && error.message.includes(apiKey)) return 'Jev request failed';
  return `Jev request failed: ${error.message}`;
}

async function cancelRemainingBody(response: Response): Promise<void> {
  const body = response.body;
  if (body === null || response.bodyUsed || body.locked) return;
  try {
    await body.cancel();
  } catch {
    // Cancel must not replace the Jev error string.
  }
}

export async function scoreCandidates(
  candidates: readonly JevBatchCandidate[],
  options: ScoreCandidatesOptions = {},
): Promise<JevBatchResult> {
  const ids = candidates.map(candidate => candidate.id);
  const apiKey = batchKey(options);
  if (apiKey === undefined) return { status: 'skipped', ids };

  const idError = candidateIdError(candidates);
  if (idError) return failure(idError);
  if (candidates.length === 0) return { status: 'scored', decisions: {} };

  const call = options.fetch ?? fetch;
  const timeout = startTimeout(options.timeoutMs ?? BATCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await call(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: batchState(candidates),
          model: MODEL,
          questions: batchQuestions(candidates),
        }),
        signal: timeout.signal,
      });
    } catch (error) {
      if (timeout.signal.aborted || isTimeout(error)) return failure('Jev request timed out');
      return failure(transportError(error, apiKey));
    }

    if (!response.ok) {
      await cancelRemainingBody(response);
      return failure(`Jev request failed: HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      await cancelRemainingBody(response);
      return failure('Jev response was not valid JSON');
    }

    try {
      return { status: 'scored', decisions: readBatch(body, ids) };
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Jev response missing a keep, demote, or drop choice';
      return failure(redact(message, apiKey));
    }
  } finally {
    timeout.done();
  }
}
