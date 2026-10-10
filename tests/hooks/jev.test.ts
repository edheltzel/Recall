import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  JEV_KEY_ENV,
  resolveJevKey,
  scoreCandidate,
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

const homes: string[] = [];

function disposableHome(body?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'recall-jev-env-'));
  homes.push(home);
  if (body !== undefined) writeFileSync(join(home, '.env'), body);
  return home;
}

describe('resolveJevKey', () => {
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  test('a non-blank environment value wins and a blank one falls back to the file', async () => {
    const secret = 'file-only-secret';
    const home = disposableHome(`JEV_RECALL_KEY=${secret}\n`);
    expect(resolveJevKey({ JEV_RECALL_KEY: 'env-wins', HOME: home })).toBe('env-wins');
    expect(resolveJevKey({ JEV_RECALL_KEY: '   ', HOME: home })).toBe(secret);

    const fromEnv = recordedFetch(() => choiceResponse({ d0: scoredAnswers.d0 }));
    await scoreCandidates([candidates[0]], {
      fetch: fromEnv.fetch,
      env: { JEV_RECALL_KEY: 'env-wins', HOME: home },
    });
    expect(new Headers(fromEnv.calls[0].headers).get('authorization')).toBe('Bearer env-wins');
    expect(fromEnv.calls[0].body).not.toContain(secret);

    const fromFile = recordedFetch(() => choiceResponse({ d0: scoredAnswers.d0 }));
    const scored = await scoreCandidates([candidates[0]], {
      fetch: fromFile.fetch,
      env: { JEV_RECALL_KEY: '  ', HOME: home },
    });
    expect(scored.status).toBe('scored');
    expect(new Headers(fromFile.calls[0].headers).get('authorization')).toBe(`Bearer ${secret}`);
  });

  test('parses export, quotes, comments, and CRLF, and ignores a commented line', () => {
    const secret = 'quoted-secret';
    expect(resolveJevKey({}, disposableHome('export JEV_RECALL_KEY=exported\n'))).toBe('exported');
    expect(resolveJevKey({}, disposableHome('JEV_RECALL_KEY="double"\n'))).toBe('double');
    expect(resolveJevKey({}, disposableHome("JEV_RECALL_KEY='single'\n"))).toBe('single');
    expect(resolveJevKey({}, disposableHome('JEV_RECALL_KEY=raw # trailing\n'))).toBe('raw');
    expect(resolveJevKey({}, disposableHome('JEV_RECALL_KEY="keep # this" # drop\n'))).toBe('keep # this');
    expect(resolveJevKey({}, disposableHome(`export JEV_RECALL_KEY=${secret}\r\n`))).toBe(secret);
    expect(resolveJevKey({}, disposableHome(`# JEV_RECALL_KEY=${secret}\n# export JEV_RECALL_KEY=${secret}\n`))).toBeUndefined();
    expect(resolveJevKey({}, disposableHome('JEV_RECALL_KEY=old\nJEV_RECALL_KEY=new\n'))).toBe('new');
    expect(resolveJevKey({}, disposableHome(`JEV_RECALL_KEY_EXTRA=${secret}\nOTHER=nope\n`))).toBeUndefined();
  });

  test('a missing or unreadable file skips, and thrown errors omit the key', async () => {
    const secret = 'never-print-this';
    const empty = disposableHome();
    expect(resolveJevKey({ JEV_RECALL_KEY: '' }, empty)).toBeUndefined();
    const skipped = await scoreCandidates([candidates[0]], {
      fetch: recordedFetch(() => choiceResponse(scoredAnswers)).fetch,
      env: { HOME: empty, JEV_RECALL_KEY: '' },
    });
    expect(skipped).toEqual({ status: 'skipped', ids: ['d0'] });

    const broken = disposableHome();
    mkdirSync(join(broken, '.env'));
    expect(resolveJevKey({}, broken)).toBeUndefined();

    const home = disposableHome(`JEV_RECALL_KEY='${secret}'\n`);
    const thrown = recordedFetch(() => {
      throw new Error(`socket failed for ${secret}`);
    });
    let message = '';
    try {
      await scoreCandidate({ text: 'hi' }, {
        fetch: thrown.fetch,
        env: { HOME: home, JEV_RECALL_KEY: '   ' },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Jev request failed');
    expect(message).not.toContain(secret);

    const batch = await scoreCandidates([candidates[0]], {
      fetch: thrown.fetch,
      env: { HOME: home },
    });
    expect(batch).toEqual({ status: 'error', error: 'Jev request failed' });
    expect(JSON.stringify(batch)).not.toContain(secret);
  });
});
