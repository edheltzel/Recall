import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Guard for the chunk.ts audit note (PR #55 review, issue #76). The note claims
// every input-scaled SQL placeholder list in src/ and hooks/ routes through
// `chunked()` — a point-in-time global assertion that rots silently the first
// time someone adds an unchunked `IN (${ids.map(() => '?')})` elsewhere. This
// test turns that prose into an enforced invariant: a new input-scaled
// placeholder list that bypasses the helper (and is not a provably fixed-size
// site) fails CI.

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCAN_DIRS = ['src', 'hooks'];

// The arrow that builds exactly one bind placeholder — the shared tell of both
// `x.map(() => '?')` and `Array.from(x, () => '?')`.
const PLACEHOLDER_IDIOM = /\(\)\s*=>\s*['"]\?['"]/;
const CHUNKED_CALL = /\bchunked\(/;

// Sites whose placeholder count is fixed (bounded by a schema column list, not
// by input size) and so are safe without chunking. Keyed by repo-relative path
// with the reason it is exempt. A hook cannot import src/lib/chunk.ts (see the
// self-contained-hooks rule), so a hook with a genuinely input-scaled list must
// inline a local chunking equivalent rather than land here.
const FIXED_SIZE_ALLOWLIST: Record<string, string> = {
  'hooks/lib/consolidate-core.ts':
    'VALUES placeholder count tracks the fixed `cols` schema array, not input size',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

// Drop comments so prose that merely quotes the idiom (the chunk.ts audit note,
// the dedup.ts "input-scaled IN (?,...)" remark) does not register as real
// placeholder construction. The `[^:]` guard keeps `https://` intact.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('chunk audit invariant', () => {
  const files = SCAN_DIRS.flatMap(walk);

  test('scans a non-empty source set', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test('every input-scaled placeholder list chunks (or is allowlisted fixed-size)', () => {
    const offenders = files.filter((rel) => {
      const code = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      if (!PLACEHOLDER_IDIOM.test(code)) return false;
      return !CHUNKED_CALL.test(code) && !(rel in FIXED_SIZE_ALLOWLIST);
    });
    if (offenders.length > 0) {
      throw new Error(
        `Input-scaled SQL placeholder list bypasses chunked():\n  ${offenders.join('\n  ')}\n` +
          `Route it through src/lib/chunk.ts's chunked() (hooks inline a local equivalent), or ` +
          `add the site to FIXED_SIZE_ALLOWLIST with a reason if the placeholder count is fixed.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  test('allowlist entries stay meaningful (still build placeholders, never chunk)', () => {
    for (const [rel, reason] of Object.entries(FIXED_SIZE_ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(0);
      const code = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      // If the file stopped building placeholders, or started chunking, the
      // exemption is dead weight — fail so it gets removed.
      expect(PLACEHOLDER_IDIOM.test(code)).toBe(true);
      expect(CHUNKED_CALL.test(code)).toBe(false);
    }
  });

  test('detection is not vacuous: an unchunked list is flagged, a comment is not', () => {
    const bypass = `const sql = 'DELETE FROM t WHERE id IN (' + ids.map(() => '?').join(',') + ')';`;
    expect(PLACEHOLDER_IDIOM.test(stripComments(bypass))).toBe(true);
    expect(CHUNKED_CALL.test(stripComments(bypass))).toBe(false);

    const commentOnly = `// example: ids.map(() => '?')\n/* Array.from(x, () => '?') */\nconst x = 1;`;
    expect(PLACEHOLDER_IDIOM.test(stripComments(commentOnly))).toBe(false);
  });
});
