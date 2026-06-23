import { describe, test, expect } from 'bun:test';

// The src/ seam (CLI + MCP import surface) and the canonical hooks implementation.
// #50 single-sources the write-safety scrub: src/lib re-exports the ONE canonical
// table from hooks/lib — there is no second copy. These imports must resolve to the
// SAME module, so this test guards against a future drift back into two copies.
import * as src from '../../src/lib/write-safety';
import * as canonical from '../../hooks/lib/write-safety';

// Structurally-valid fake secrets (never real credentials), assembled from parts so no
// contiguous token-shaped literal lives in source. Mirrors the corpus shape exercised
// by tests/hooks/write-safety.test.ts; the point here is cross-module byte-equality.
const ZW = String.fromCodePoint(0x200b); // zero-width space
const BIDI = String.fromCodePoint(0x202e); // right-to-left override
const FIXTURES: string[] = [
  '', // empty
  'plain prose with no secrets and the word api key in the vault',
  'sk-ant-api03-' + 'A'.repeat(40),
  'sk-proj-' + 'B'.repeat(40),
  'AKIAIOSFODNN7EXAMPLE',
  'ghp_' + 'd'.repeat(36),
  'Bearer ' + 'p'.repeat(32),
  'password=hunter2hunter2hunter2',
  '-----BEGIN RSA PRIVATE KEY-----\n' + 'x'.repeat(50) + '\n-----END RSA PRIVATE KEY-----',
  // Two secrets glued together (exercises tempered-greedy + fixpoint iteration).
  'Bearer ' + 'q'.repeat(20) + 'api_key=' + 'z'.repeat(20),
  // Invisible / bidi unicode mixed with a secret.
  `lead${ZW}ing ${BIDI}text npm_${'l'.repeat(36)} trail${ZW}ing`,
];

describe('#50 write-safety single source (src re-export === hooks canonical)', () => {
  test('src/lib re-exports the SAME function objects as hooks/lib (one source, not a copy)', () => {
    expect(src.scrub).toBe(canonical.scrub);
    expect(src.redactSecrets).toBe(canonical.redactSecrets);
    expect(src.stripInvisibleUnicode).toBe(canonical.stripInvisibleUnicode);
  });

  for (const input of FIXTURES) {
    const label = JSON.stringify(input.length > 40 ? input.slice(0, 40) + '…' : input);
    test(`scrub() byte-identical via both import paths: ${label}`, () => {
      const viaSrc = src.scrub(input);
      const viaCanonical = canonical.scrub(input);
      // Byte-identical text AND identical redaction kinds — proves no drift.
      expect(viaSrc.text).toBe(viaCanonical.text);
      expect(viaSrc.redactions).toEqual(viaCanonical.redactions);
    });
  }
});
