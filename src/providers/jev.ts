const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const QUESTION_ID = 'disposition';

export const JEV_KEY_ENV = 'JEV_RECALL_KEY';

export type JevDisposition = 'keep' | 'demote' | 'drop';

export interface JevCandidate {
  text: string;
  kind?: string;
  project?: string;
}

export interface JevDecision {
  choice: JevDisposition;
  probabilities: Record<JevDisposition, number>;
  confidence: number;
}

const DISPOSITIONS: readonly JevDisposition[] = ['keep', 'demote', 'drop'];

const INSTRUCTIONS = [
  'Should this candidate memory item be kept, demoted, or dropped when Recall ingests it?',
  'keep: store it at normal importance because a later session would need it.',
  'demote: store it at reduced importance because it is real but weak, partial, or soon stale.',
  'drop: do not store it because it has no future recall value.',
  'Judge `text`, and use `kind` and `project` when those fields are present.',
].join(' ');

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

export interface ScoreCandidateOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

function requiredKey(env: NodeJS.ProcessEnv): string {
  const key = env[JEV_KEY_ENV];
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error(`${JEV_KEY_ENV} is not set`);
  }
  return key;
}

function stateFor(candidate: JevCandidate): Record<string, string> {
  const state: Record<string, string> = {};
  if (candidate.kind) state.kind = candidate.kind;
  state.text = candidate.text;
  if (candidate.project) state.project = candidate.project;
  return state;
}

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

export async function scoreCandidate(
  candidate: JevCandidate,
  options: ScoreCandidateOptions = {},
): Promise<JevDecision> {
  const apiKey = options.apiKey ?? requiredKey(options.env ?? process.env);
  const call = options.fetch ?? fetch;
  const response = await call(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      state: stateFor(candidate),
      model: MODEL,
      questions: {
        [QUESTION_ID]: {
          type: 'choice',
          instructions: INSTRUCTIONS,
          criteria: CRITERIA,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Jev request failed: HTTP ${response.status}`);
  }

  const body = await response.json() as {
    answers?: Record<string, {
      type?: unknown;
      choice?: unknown;
      probabilities?: unknown;
      confidence?: unknown;
    }>;
  };
  const answer = body.answers?.[QUESTION_ID];
  if (!answer || answer.type !== 'choice' || !isDisposition(answer.choice)) {
    throw new Error('Jev response missing a keep, demote, or drop choice');
  }
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) {
    throw new Error('Jev response missing confidence');
  }

  return {
    choice: answer.choice,
    probabilities: readProbabilities(answer.probabilities),
    confidence: answer.confidence,
  };
}
