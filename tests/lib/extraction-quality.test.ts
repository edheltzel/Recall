import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { evaluateQuality, shouldSkipExtraction, buildAdaptivePrompt } from '../../hooks/lib/extraction-quality';

const FIXTURES = join(__dirname, '../fixtures/extraction');

describe('evaluateQuality', () => {
  test('returns pass for valid extraction output', () => {
    const text = readFileSync(join(FIXTURES, 'quality/pass.txt'), 'utf-8');
    const result = evaluateQuality(text);
    expect(result.pass).toBe(true);
  });

  test('returns fail for thin output', () => {
    const text = readFileSync(join(FIXTURES, 'quality/fail-thin.txt'), 'utf-8');
    const result = evaluateQuality(text);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('below_word_count');
  });

  test('returns fail for output missing sections', () => {
    const text = readFileSync(join(FIXTURES, 'quality/fail-no-sections.txt'), 'utf-8');
    const result = evaluateQuality(text, { strict: true });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('missing_sections');
  });

  test('relaxed gate passes output that strict gate would fail', () => {
    const text = readFileSync(join(FIXTURES, 'quality/fail-no-sections.txt'), 'utf-8');
    const result = evaluateQuality(text, { strict: false });
    expect(result.pass).toBe(true);
  });
});

describe('shouldSkipExtraction', () => {
  test('returns true for tiny conversation', () => {
    const lines = readFileSync(join(FIXTURES, 'conversation-tiny.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const contentChars = lines
      .map((l: { content?: string }) => (l.content ?? '').length)
      .reduce((a: number, b: number) => a + b, 0);
    expect(shouldSkipExtraction(contentChars)).toBe(true);
  });

  test('returns false for adequate conversation', () => {
    const lines = readFileSync(join(FIXTURES, 'conversation-adequate.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const contentChars = lines
      .map((l: { content?: string }) => (l.content ?? '').length)
      .reduce((a: number, b: number) => a + b, 0);
    expect(shouldSkipExtraction(contentChars)).toBe(false);
  });
});

describe('buildAdaptivePrompt', () => {
  test('returns short variant for under 2000 chars', () => {
    const prompt = buildAdaptivePrompt(1500);
    expect(prompt.toLowerCase()).toMatch(/brief summary|brief|concise/);
    expect(prompt).not.toMatch(/ONE SENTENCE SUMMARY/);
  });

  test('returns full prompt for over 2000 chars', () => {
    const prompt = buildAdaptivePrompt(3000);
    expect(prompt).toMatch(/ONE SENTENCE SUMMARY/);
    expect(prompt).toMatch(/MAIN IDEAS/);
  });
});
