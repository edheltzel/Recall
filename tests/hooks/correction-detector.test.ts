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
    // Mutation: drop the NEGATIVE list → both of these fire (weak lead + a verb
    // directive — "stop there, run …" / "no problem, use …") → RED. The negative
    // pass is the ONLY thing keeping them out.
    expect(detectCorrection('stop there, run the old build').isCorrection).toBe(false);
    expect(detectCorrection('no problem, use the default').isCorrection).toBe(false);
  });
});

describe('benign prose with a weak lead but no verb directive (#52 over-fire fix)', () => {
  // H2: the bare pointer words (the/that/this/it) were dropped from DIRECTIVE_WORDS,
  // so a weak lead ("no,"/"actually,"/"stop,") followed only by pointer prose is no
  // longer a correction. A verbatim-write feature must favor precision over recall.
  // Mutation: restore the/that/this/it to DIRECTIVE_WORDS → every row below fires → RED.
  test.each([
    'no, the build is green',
    'actually, the tests pass',
    'no, it works now',
    "no, that's fine",
    'actually, this is great',
    'stop, the server is up',
  ])('%j is NOT a correction', (text) => {
    expect(detectCorrection(text).isCorrection).toBe(false);
  });

  test('real verb-directive corrections STILL fire (no recall regression)', () => {
    // The fix must not silence genuine corrections — these all carry a verb.
    expect(detectCorrection('no, use the other file').isCorrection).toBe(true);
    expect(detectCorrection('stop, run the tests first').isCorrection).toBe(true);
    expect(detectCorrection('actually use the parser helper').isCorrection).toBe(true);
  });
});

describe('#137: missed real corrections now captured (recall, no precision regression)', () => {
  // Each phrase class from issue #137 (RedTeam finding #3 on PR #136) fires as a
  // strong pattern — terse corrections directed at the agent's just-done work.
  test.each([
    "that's not it",
    "no, that's not it",
    'you misunderstood',
    "you've misunderstood",
    'you have misunderstood me',
    'revert that',
    'undo that',
    'undo it',
    'revert that change',
    "that's the wrong approach",
    "that's the wrong file",
    'you got it wrong',
    "you've got it wrong",
    'nope, different file',
    'no, different approach',
    'nope — different function entirely',
  ])('%j IS a correction', (text) => {
    expect(detectCorrection(text).isCorrection).toBe(true);
  });

  // No-false-positive-regression guard (PR #159 RedTeam NO-GO). The first nine are
  // the exact benign phrases RedTeam confirmed fired ONLY on the over-broad first
  // cut; the rest broaden the sample to realistic developer prose. ALL must stay
  // benign — these are the verbatim-write false positives #137 forbids reintroducing.
  // Mutation: loosen any new pattern back toward its unanchored/greedy form → a row
  // below flips → RED.
  test.each([
    // —— the nine RedTeam-confirmed regressions ——
    'revert that commit when you get a chance', // forward request, not a correction
    'undo that last cell in my notebook', // request about the user's own state
    'can you undo this for me please', // polite request
    'lets revert this approach next sprint', // planning, future tense
    "that's the wrong number you dialed", // fires on ANY "wrong <noun>"
    "that's the wrong assumption people make", // about a concept, not the agent
    'nope, different topic entirely', // benign topic shift, no dev target
    'no, different strokes for different folks', // idiom
    'you misunderstood the assignment', // third-party / mid-sentence remark
    // —— broadened realistic developer prose ——
    'can you revert the migration after the deploy lands', // forward request
    'we should undo this refactor eventually', // planning
    'undo functionality is broken in the editor', // "undo" as a subject, no pointer
    "that's the wrong button in the mockup, FYI", // non-dev-action noun
    'you misunderstood my earlier message, let me re-explain', // trailing object
    "you understood the spec perfectly", // affirmation, not "misunderstood"
    'you got it exactly right', // "got it right", not "got it wrong"
    'you got it', // bare affirmation
    'no different than before, leave it as is', // "no different than" idiom
    "that's not ideal, but ship it", // "not it" vs "not ideal"
    "that's not it's job to validate", // possessive "it's", not the correction
    "let's go with a different approach to logging", // not a "no/nope" rejection lead
  ])('%j is NOT a correction', (text) => {
    expect(detectCorrection(text).isCorrection).toBe(false);
  });

  test('reports the new pattern labels', () => {
    expect(detectCorrection("that's not it").matched).toBe('thats-not-it');
    expect(detectCorrection('you misunderstood').matched).toBe('you-misunderstood');
    expect(detectCorrection('revert that').matched).toBe('revert-undo-that');
    expect(detectCorrection("that's the wrong approach").matched).toBe('thats-wrong-approach');
    expect(detectCorrection('you got it wrong').matched).toBe('you-got-it-wrong');
    expect(detectCorrection('nope, different file').matched).toBe('nope-different');
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
