import { describe, expect, test } from 'bun:test';
import {
  scoreCandidate,
  scoreCandidates,
  type JevBatchCandidate,
} from '../../src/providers/jev';

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

const MEANINGS = [
  'keep: store it at normal importance because a later session would need it.',
  'demote: store it at reduced importance because it is real but weak, partial, or soon stale.',
  'drop: do not store it because it has no future recall value.',
];

function instructionsFor(id: string): string {
  return [
    `Should the candidate at \`candidates.${id}.text\` be kept, demoted, or dropped when Recall ingests it?`,
    ...MEANINGS,
    'Use kind and project on that same candidate when those fields are present.',
  ].join(' ');
}

const candidates: JevBatchCandidate[] = [
  {
    id: 'd0',
    kind: 'decision',
    text: 'Use bun:sqlite, not a second database.',
    project: 'Recall',
    confidence: 'high',
  },
  {
    id: 'd1',
    kind: 'decision',
    text: 'Keep the legacy markdown writer.',
    confidence: 'low',
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

function posted(call: Call): {
  model: string;
  state: { candidates?: Record<string, Record<string, string>> };
  questions: Record<string, { type: string; instructions: string; criteria: unknown }>;
} {
  return JSON.parse(call.body ?? '{}');
}

function choiceResponse(answers: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: 10, output_tokens: 4 },
  }), { status });
}

describe('scoreCandidate', () => {
  test('posts one keep/demote/drop choice and returns it', async () => {
    const seen = recordedFetch(() => choiceResponse({
      disposition: {
        type: 'choice',
        choice: 'drop',
        probabilities: { keep: 0.02, demote: 0.05, drop: 0.93 },
        confidence: 0.88,
      },
    }));

    const decision = await scoreCandidate(
      { kind: 'breadcrumb', text: 'hi', project: 'Recall' },
      { fetch: seen.fetch, apiKey: 'test-key' },
    );

    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen.calls[0].method).toBe('POST');
    const headers = new Headers(seen.calls[0].headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('content-type')).toBe('application/json');

    const body = posted(seen.calls[0]);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ kind: 'breadcrumb', text: 'hi', project: 'Recall' });
    const question = body.questions.disposition;
    expect(question.type).toBe('choice');
    expect(question.instructions).toBe([
      'Should this candidate memory item be kept, demoted, or dropped when Recall ingests it?',
      ...MEANINGS,
      'Judge `text`, and use `kind` and `project` when those fields are present.',
    ].join(' '));
    expect(question.criteria).toEqual(RUBRIC);
    expect(decision).toEqual({
      choice: 'drop',
      probabilities: { keep: 0.02, demote: 0.05, drop: 0.93 },
      confidence: 0.88,
    });
  });

  test('still throws when the key is missing or blank and does not fetch', async () => {
    const seen = recordedFetch(() => choiceResponse({}));
    const options = { fetch: seen.fetch, env: { JEV_RECALL_KEY: '   ' } };
    await expect(scoreCandidate({ text: 'hi' }, options)).rejects.toThrow('JEV_RECALL_KEY is not set');
    await expect(scoreCandidate({ text: 'hi' }, { fetch: seen.fetch, env: {} })).rejects.toThrow(
      'JEV_RECALL_KEY is not set',
    );
    expect(seen.calls).toHaveLength(0);
  });

  test('still throws when the request is not ok', async () => {
    const seen = recordedFetch(() => new Response('down', { status: 503 }));
    await expect(scoreCandidate({ text: 'hi' }, { fetch: seen.fetch, apiKey: 'test-key' })).rejects.toThrow(
      'Jev request failed: HTTP 503',
    );
  });
});

describe('scoreCandidates', () => {
  test('posts one choice per candidate and returns keep, demote, and drop', async () => {
    const seen = recordedFetch(() => choiceResponse({
      d0: {
        type: 'choice',
        choice: 'keep',
        probabilities: { drop: 0.05, keep: 0.8, demote: 0.15 },
        confidence: 0.7,
      },
      d1: {
        type: 'choice',
        choice: 'demote',
        probabilities: { keep: 0.2, demote: 0.6, drop: 0.2 },
        confidence: 0.4,
      },
      l0: {
        type: 'choice',
        choice: 'drop',
        probabilities: { keep: 0, demote: 0, drop: 1 },
        confidence: 0,
      },
      b0: {
        type: 'choice',
        choice: 'keep',
        probabilities: { keep: 0.9, demote: 0.1, drop: 0 },
        confidence: 0.84,
      },
    }));

    const result = await scoreCandidates(candidates, {
      fetch: seen.fetch,
      apiKey: SECRET,
      env: {},
    });

    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen.calls[0].method).toBe('POST');
    const headers = new Headers(seen.calls[0].headers);
    expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(seen.calls[0].body).not.toContain(SECRET);

    const body = posted(seen.calls[0]);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({
      candidates: {
        d0: {
          kind: 'decision',
          text: 'Use bun:sqlite, not a second database.',
          project: 'Recall',
          confidence: 'high',
        },
        d1: {
          kind: 'decision',
          text: 'Keep the legacy markdown writer.',
          confidence: 'low',
        },
        l0: {
          kind: 'learning',
          text: 'EEXIST on lock file: switched to SQLite extraction_locks',
          project: 'Recall',
        },
        b0: {
          kind: 'breadcrumb',
          text: 'Hooks must not import from src',
          project: 'Recall',
        },
      },
    });
    expect(Object.keys(body.questions)).toEqual(['d0', 'd1', 'l0', 'b0']);
    for (const id of ['d0', 'd1', 'l0', 'b0']) {
      const question = body.questions[id];
      expect(question.type).toBe('choice');
      expect(question.instructions).toBe(instructionsFor(id));
      expect(question.instructions.match(/`[^`]+`/g)).toEqual([`\`candidates.${id}.text\``]);
      expect(question.criteria).toEqual(RUBRIC);
    }
    expect(body.questions.d0.instructions).not.toContain('EEXIST');
    expect(body.questions.l0.instructions).not.toContain('candidates.d0');

    expect(result).toEqual({
      status: 'scored',
      decisions: {
        d0: {
          choice: 'keep',
          probabilities: { keep: 0.8, demote: 0.15, drop: 0.05 },
          confidence: 0.7,
        },
        d1: {
          choice: 'demote',
          probabilities: { keep: 0.2, demote: 0.6, drop: 0.2 },
          confidence: 0.4,
        },
        l0: {
          choice: 'drop',
          probabilities: { keep: 0, demote: 0, drop: 1 },
          confidence: 0,
        },
        b0: {
          choice: 'keep',
          probabilities: { keep: 0.9, demote: 0.1, drop: 0 },
          confidence: 0.84,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('a missing or blank key skips every candidate and does not fetch', async () => {
    const seen = recordedFetch(() => new Response(SECRET, { status: 500 }));
    const missing = await scoreCandidates(candidates, { fetch: seen.fetch, env: {} });
    const blank = await scoreCandidates(candidates, {
      fetch: seen.fetch,
      apiKey: '   ',
      env: { JEV_RECALL_KEY: SECRET },
    });
    const blankEnv = await scoreCandidates(candidates, {
      fetch: seen.fetch,
      env: { JEV_RECALL_KEY: ' \n ' },
    });

    expect(seen.calls).toHaveLength(0);
    expect(missing).toEqual({ status: 'skipped', ids: ['d0', 'd1', 'l0', 'b0'] });
    expect(blank).toEqual(missing);
    expect(blankEnv).toEqual(missing);
    expect(JSON.stringify(blank)).not.toContain(SECRET);
  });

  test('an empty list with a key does not fetch', async () => {
    const seen = recordedFetch(() => choiceResponse({}));
    const result = await scoreCandidates([], { fetch: seen.fetch, apiKey: SECRET, env: {} });
    expect(seen.calls).toHaveLength(0);
    expect(result).toEqual({ status: 'scored', decisions: {} });
  });

  test('a bad or duplicate id fails open without a fetch', async () => {
    const seen = recordedFetch(() => choiceResponse({}));
    const bad = await scoreCandidates(
      [{ id: SECRET, kind: 'decision', text: 'Use bun:sqlite' }],
      { fetch: seen.fetch, apiKey: 'other-token', env: {} },
    );
    const duplicate = await scoreCandidates(
      [candidates[0], { ...candidates[1], id: 'd0' }],
      { fetch: seen.fetch, apiKey: SECRET, env: {} },
    );
    expect(seen.calls).toHaveLength(0);
    expect(bad).toEqual({ status: 'error', error: 'Jev candidate id must be d<n>, l<n>, or b<n>' });
    expect(duplicate).toEqual({ status: 'error', error: 'Jev candidates include a duplicate id' });
    expect(JSON.stringify(bad)).not.toContain(SECRET);
    expect(JSON.stringify(duplicate)).not.toContain(SECRET);
  });

  test('transport and response failures return a key-free error', async () => {
    const cases: Array<{ response: () => Response | Promise<Response>; error: string }> = [
      {
        response: () => new Response(SECRET, { status: 500 }),
        error: 'Jev request failed: HTTP 500',
      },
      {
        response: () => new Response(SECRET, { status: 200 }),
        error: 'Jev response was not valid JSON',
      },
      {
        response: () => choiceResponse({}),
        error: 'Jev response missing an answer for d0',
      },
      {
        response: () => choiceResponse({
          d0: { type: 'choice', choice: 'archive', probabilities: { keep: 1, demote: 0, drop: 0 }, confidence: 1 },
        }),
        error: 'Jev response missing a keep, demote, or drop choice',
      },
      {
        response: () => choiceResponse({
          d0: { type: 'choice', choice: 'keep', probabilities: { keep: 1, demote: 0, drop: 0 } },
        }),
        error: 'Jev response missing confidence',
      },
      {
        response: () => choiceResponse({
          d0: { type: 'choice', choice: 'keep', probabilities: { keep: 1, demote: 0 }, confidence: 1 },
        }),
        error: 'Jev response missing probabilities',
      },
    ];

    for (const item of cases) {
      const seen = recordedFetch(item.response);
      const result = await scoreCandidates(
        [candidates[0]],
        { fetch: seen.fetch, apiKey: SECRET, env: {} },
      );
      expect(seen.calls).toHaveLength(1);
      expect(result).toEqual({ status: 'error', error: item.error });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }

    const thrown = recordedFetch(() => {
      throw new Error(`connect ${SECRET}`);
    });
    const hidden = await scoreCandidates([candidates[0]], {
      fetch: thrown.fetch,
      apiKey: SECRET,
      env: {},
    });
    expect(hidden).toEqual({ status: 'error', error: 'Jev request failed' });

    const plain = recordedFetch(() => {
      throw new Error('socket hang up');
    });
    const visible = await scoreCandidates([candidates[0]], {
      fetch: plain.fetch,
      apiKey: SECRET,
      env: {},
    });
    expect(visible).toEqual({ status: 'error', error: 'Jev request failed: socket hang up' });
    expect(JSON.stringify(visible)).not.toContain(SECRET);
  });

  test('a missing per-id answer fails the whole batch', async () => {
    const seen = recordedFetch(() => choiceResponse({
      d0: {
        type: 'choice',
        choice: 'keep',
        probabilities: { keep: 1, demote: 0, drop: 0 },
        confidence: 1,
      },
    }));
    const result = await scoreCandidates(
      [candidates[0], candidates[2]],
      { fetch: seen.fetch, apiKey: SECRET, env: {} },
    );
    expect(seen.calls).toHaveLength(1);
    expect(result).toEqual({ status: 'error', error: 'Jev response missing an answer for l0' });
  });

  test('a hung request times out without throwing or revealing the key', async () => {
    const seen = recordedFetch((init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error(`aborted ${SECRET}`), { name: 'AbortError' }));
      }, { once: true });
    }));

    const result = await scoreCandidates([candidates[3]], {
      fetch: seen.fetch,
      apiKey: SECRET,
      env: {},
      timeoutMs: 30,
    });

    expect(seen.calls).toHaveLength(1);
    expect(result).toEqual({ status: 'error', error: 'Jev request timed out' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
