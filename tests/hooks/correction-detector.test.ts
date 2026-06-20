// Unit coverage for the pure correction detector (issue #52 P4).
//
// Pure string -> { isCorrection, matched? }, so no DB/temp-dir setup is needed.
// The two mutation guards the brief calls out are exercised explicitly:
//   - drop the NEGATIVE list  → a benign affirmation misclassifies as a correction
//   - drop the DIRECTIVE check → a bare weak lead fires without an imperative
// Both have a fixture below whose assertion flips RED under that mutation.

import { describe, test, expect } from 'bun:test';
import { detectCorrection } from '../../hooks/lib/correction-detector';

describe('strong patterns fire alone', () => {
  test.each([
    "That's wrong.",
    "that's incorrect",
    "I told you before to use the cache",
    "don't do that",
    "not like that",
    "we already discussed this",
    "please don't change the schema",
    "that's not what I asked for",
    "that's not right",
  ])('%j is a correction', (text) => {
    expect(detectCorrection(text).isCorrection).toBe(true);
  });

  test('"that\'s not right" survives the "that\'s right" affirmation suppressor', () => {
    // The negative ^that's right must NOT swallow the real correction — the "not"
    // breaks the affirmation match.
    expect(detectCorrection("that's not right").isCorrection).toBe(true);
    expect(detectCorrection("that's right").isCorrection).toBe(false);
  });
});

describe('weak leads require a directive', () => {
  test('"actually use X" fires, bare "actually" does not', () => {
    expect(detectCorrection('actually use the parser helper').isCorrection).toBe(true);
    expect(detectCorrection('actually').isCorrection).toBe(false);
  });

  test('a weak lead with NO directive does not fire (directive-requirement guard)', () => {
    // Mutation: drop the directive requirement (weak leads fire alone) → this
    // turns true → RED. "nope"/"hmm" carry no directive word.
    expect(detectCorrection('actually, nope').isCorrection).toBe(false);
    expect(detectCorrection('actually, hmm').isCorrection).toBe(false);
    expect(detectCorrection('no, whatever').isCorrection).toBe(false);
  });

  test('"no, use X" and "stop, run Y" fire via the directive', () => {
    expect(detectCorrection('no, use the other file').isCorrection).toBe(true);
    expect(detectCorrection('stop, run the tests first').isCorrection).toBe(true);
  });
});

describe('negative patterns suppress (load-bearing)', () => {
  test.each([
    'no problem',
    'no worries',
    'no thanks',
    'no need',
    'correct!',
    "that's right",
    'perfect, ship it',
  ])('%j is NOT a correction', (text) => {
    expect(detectCorrection(text).isCorrection).toBe(false);
  });

  test('negatives rescue benign affirmations that would otherwise fire via weak+directive', () => {
    // Mutation: drop the NEGATIVE list → both of these fire (weak lead + a
    // directive word like "that"/"use" follows) → RED. The negative pass is the
    // ONLY thing keeping them out.
    expect(detectCorrection('actually, that looks great').isCorrection).toBe(false);
    expect(detectCorrection('no problem, use the default').isCorrection).toBe(false);
  });
});

describe('config-overridable extra patterns', () => {
  test('an env-provided pattern fires like a strong pattern; absent it does not', () => {
    expect(detectCorrection('zoinks the build broke').isCorrection).toBe(false);
    expect(
      detectCorrection('zoinks the build broke', { extraPatterns: ['^zoinks'] }).isCorrection
    ).toBe(true);
  });

  test('an invalid extra pattern is skipped rather than thrown', () => {
    // A bad regex source must never crash the turn — it is simply ignored.
    expect(() => detectCorrection('hello', { extraPatterns: ['(unclosed'] })).not.toThrow();
    expect(detectCorrection('hello', { extraPatterns: ['(unclosed'] }).isCorrection).toBe(false);
  });
});

describe('edge cases', () => {
  test('empty / whitespace / non-string input is not a correction', () => {
    expect(detectCorrection('').isCorrection).toBe(false);
    expect(detectCorrection('   ').isCorrection).toBe(false);
    expect(detectCorrection(undefined as unknown as string).isCorrection).toBe(false);
  });

  test('ordinary prose is not a correction', () => {
    expect(detectCorrection('Can you add a test for the parser?').isCorrection).toBe(false);
    expect(detectCorrection('Thanks, that works great').isCorrection).toBe(false);
  });

  test('reports which pattern matched', () => {
    expect(detectCorrection("that's wrong").matched).toBe('thats-wrong');
    expect(detectCorrection('actually use it').matched).toBe('actually-lead');
  });
});
