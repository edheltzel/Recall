import { describe, expect, test } from 'bun:test';
import {
  JEV_KEY_ENV,
  scoreCandidates,
  type JevBatchCandidate,
} from '../../hooks/lib/jev';

const SECRET = 'jev-test-secret';

const RUBRIC = {
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

const candidates: JevBatchCandidate[] = [
  {
    id: 'd0',
    kind: 'decision',
    text: 'Use bun:sqlite, not a second database.',
    project: 'Recall',
    confidence: 'high',
  },
  {
    id: 'l0',
    kind: 'learning',
    text: 'EEXIST on lock file: switched to SQLite extraction_locks',
    project: 'Recall',
  },
  {
    id: 'b0',
    kind: 'breadcrumb',
    text: 'Hooks must not import from src',
    project: 'Recall',
  },
];

type Call = { url: string; method?: string; headers?: HeadersInit; body?: string };

function recordedFetch(
  handler: (init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return handler(init);
  };
  return { fetch: fetchImpl, calls };
}

function choiceResponse(answers: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: 8, output_tokens: 3 },
  }), { status });
}

const scoredAnswers = {
  d0: {
    type: 'choice',
    choice: 'keep',
    probabilities: { keep: 0.71, demote: 0.2, drop: 0.09 },
    confidence: 0.55,
  },
  l0: {
    type: 'choice',
    choice: 'demote',
    probabilities: { keep: 0.25, demote: 0.5, drop: 0.25 },
    confidence: 0.25,
  },
  b0: {
    type: 'choice',
    choice: 'drop',
    probabilities: { keep: 0.01, demote: 0.02, drop: 0.97 },
    confidence: 0.93,
  },
};

describe('hook scoreCandidates', () => {
  test('posts one request whose questions each name one candidate path', async () => {
    const seen = recordedFetch(() => choiceResponse(scoredAnswers));
    const result = await scoreCandidates(candidates, {
      fetch: seen.fetch,
      apiKey: SECRET,
      env: {},
    });

    expect(JEV_KEY_ENV).toBe('JEV_RECALL_KEY');
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen.calls[0].method).toBe('POST');
    const headers = new Headers(seen.calls[0].headers);
    expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(seen.calls[0].body).not.toContain(SECRET);

    const body = JSON.parse(seen.calls[0].body ?? '{}') as {
      model: string;
      state: { candidates: Record<string, Record<string, string>> };
      questions: Record<string, { type: string; instructions: string; criteria: unknown }>;
    };
    expect(body.model).toBe('jev-latest');
    expect(body.state.candidates.l0).toEqual({
      kind: 'learning',
      text: 'EEXIST on lock file: switched to SQLite extraction_locks',
      project: 'Recall',
    });
    expect(body.state.candidates.d0.confidence).toBe('high');
    expect(Object.keys(body.questions)).toEqual(['d0', 'l0', 'b0']);
    for (const id of ['d0', 'l0', 'b0']) {
      expect(body.questions[id].type).toBe('choice');
      expect(body.questions[id].criteria).toEqual(RUBRIC);
      expect(body.questions[id].instructions.match(/`[^`]+`/g)).toEqual([`\`candidates.${id}.text\``]);
    }
    expect(body.questions.d0.instructions).not.toBe(body.questions.l0.instructions);
    expect(result).toEqual({
      status: 'scored',
      decisions: {
        d0: {
          choice: 'keep',
          probabilities: { keep: 0.71, demote: 0.2, drop: 0.09 },
          confidence: 0.55,
        },
        l0: {
          choice: 'demote',
          probabilities: { keep: 0.25, demote: 0.5, drop: 0.25 },
          confidence: 0.25,
        },
        b0: {
          choice: 'drop',
          probabilities: { keep: 0.01, demote: 0.02, drop: 0.97 },
          confidence: 0.93,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('a missing key skips and a failed response does not throw', async () => {
    const seen = recordedFetch(() => new Response(SECRET, { status: 502 }));
    const skipped = await scoreCandidates(candidates, { fetch: seen.fetch, env: { JEV_RECALL_KEY: '' } });
    expect(seen.calls).toHaveLength(0);
    expect(skipped).toEqual({ status: 'skipped', ids: ['d0', 'l0', 'b0'] });

    const failed = await scoreCandidates(candidates, {
      fetch: seen.fetch,
      apiKey: SECRET,
      env: {},
    });
    expect(failed).toEqual({ status: 'error', error: 'Jev request failed: HTTP 502' });
    expect(JSON.stringify(failed)).not.toContain(SECRET);

    const malformed = recordedFetch(() => new Response('{', { status: 200 }));
    const unreadable = await scoreCandidates([candidates[2]], {
      fetch: malformed.fetch,
      apiKey: SECRET,
      env: {},
    });
    expect(unreadable).toEqual({ status: 'error', error: 'Jev response was not valid JSON' });

    const partial = recordedFetch(() => choiceResponse({ d0: scoredAnswers.d0 }));
    const missing = await scoreCandidates([candidates[0], candidates[1]], {
      fetch: partial.fetch,
      apiKey: SECRET,
      env: {},
    });
    expect(missing).toEqual({ status: 'error', error: 'Jev response missing an answer for l0' });
  });
});
