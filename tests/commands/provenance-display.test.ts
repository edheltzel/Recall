import { describe, test, expect } from 'bun:test';
import { formatProvenanceTag } from '../../src/commands/provenance-display.js';

// The shared provenance display contract (issue #42, #75). This single helper
// backs `recall search`, `recall semantic`, `recall hybrid`, and the bare
// `recall <query>` default, so the contract is pinned once here. The byte-for-
// byte tag strings must stay identical to the original inline runSearch block.
describe('formatProvenanceTag display contract (issue #42, #75)', () => {
  test('default: known provenance stays quiet (empty tag)', () => {
    expect(formatProvenanceTag('user_authored', false)).toBe('');
    expect(formatProvenanceTag('verbatim', undefined)).toBe('');
  });

  test('default: unknown (NULL/undefined) is always flagged', () => {
    expect(formatProvenanceTag(null, false)).toBe(' ⚠ [provenance: unknown]');
    expect(formatProvenanceTag(undefined, undefined)).toBe(' ⚠ [provenance: unknown]');
  });

  test('--show-provenance: known value is shown verbatim with leading space', () => {
    expect(formatProvenanceTag('extracted', true)).toBe(' [provenance: extracted]');
    expect(formatProvenanceTag('user_authored', true)).toBe(' [provenance: user_authored]');
  });

  test('--show-provenance: unknown renders as "unknown" (no warning glyph)', () => {
    expect(formatProvenanceTag(null, true)).toBe(' [provenance: unknown]');
    expect(formatProvenanceTag(undefined, true)).toBe(' [provenance: unknown]');
  });
});
