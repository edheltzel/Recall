import { describe, expect, test } from 'bun:test';
import { scoreCandidate } from '../../src/providers/jev';

describe('scoreCandidate', () => {
  test('posts one keep/demote/drop choice and returns it', async () => {
    const calls: Array<{ url: string; method?: string; headers?: HeadersInit; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        headers: init?.headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          disposition: {
            type: 'choice',
            choice: 'drop',
            probabilities: { keep: 0.02, demote: 0.05, drop: 0.93 },
            confidence: 0.88,
          },
        },
        usage: { input_tokens: 10, output_tokens: 4 },
      }));
    };

    const decision = await scoreCandidate(
      { kind: 'breadcrumb', text: 'hi', project: 'Recall' },
      { fetch: fetchImpl, apiKey: 'test-key' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].method).toBe('POST');
    const headers = new Headers(calls[0].headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('content-type')).toBe('application/json');

    const body = JSON.parse(calls[0].body ?? '{}') as {
      model: string;
      state: Record<string, string>;
      questions: Record<string, { type: string; instructions: string; criteria: Record<string, unknown> }>;
    };
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ kind: 'breadcrumb', text: 'hi', project: 'Recall' });
    const question = body.questions.disposition;
    expect(question.type).toBe('choice');
    expect(question.instructions).toContain('kept, demoted, or dropped');
    expect(Object.keys(question.criteria).sort()).toEqual(['demote', 'drop', 'keep']);
    expect(decision).toEqual({
      choice: 'drop',
      probabilities: { keep: 0.02, demote: 0.05, drop: 0.93 },
      confidence: 0.88,
    });
  });
});
