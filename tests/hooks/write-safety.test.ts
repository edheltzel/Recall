import { describe, test, expect } from 'bun:test';
import { redactSecrets, stripInvisibleUnicode, scrub } from '../../hooks/lib/write-safety';

// Built from codepoints (not literal invisibles) so the test source stays clean and a
// linter can't silently strip a fixture char and make a test falsely pass.
const ZWSP = String.fromCodePoint(0x200b);
const INVISIBLE_CODEPOINTS = [
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width + LRM/RLM
  0x202a, 0x202c, 0x202e, // bidi embed/override (sample of 202A–202E)
  0x2066, 0x2069, // bidi isolates (sample of 2066–2069)
  0xfeff, // BOM / zero-width no-break space
];

// Fake, structurally-valid secrets — never real credentials. Each must match its
// pattern so the redaction path is exercised.
const SECRET_CASES: { kind: string; secret: string }[] = [
  { kind: 'anthropic-key', secret: 'sk-ant-api03-' + 'A'.repeat(40) },
  { kind: 'openai-key', secret: 'sk-proj-' + 'B'.repeat(40) },
  { kind: 'openai-key', secret: 'sk-' + 'C'.repeat(40) },
  { kind: 'aws-akid', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { kind: 'github-pat', secret: 'ghp_' + 'd'.repeat(36) },
  { kind: 'github-pat', secret: 'github_pat_' + 'e'.repeat(30) },
  { kind: 'gitlab-pat', secret: 'glpat-' + 'f'.repeat(24) },
  // Assembled from parts so no contiguous token-shaped literal lives in source
  // (GitHub push-protection flags the literal form), yet still matches the regex.
  { kind: 'slack-token', secret: 'xox' + 'b-' + '1234567890-' + 'abcdefghijklmno' },
  { kind: 'slack-webhook', secret: 'https://hooks.slack.com/services/T00000000/B00000000/' + 'g'.repeat(24) },
  { kind: 'google-api-key', secret: 'AIza' + 'h'.repeat(35) },
  { kind: 'stripe-key', secret: 'sk_live_' + 'i'.repeat(24) },
  { kind: 'sendgrid-key', secret: 'SG.' + 'j'.repeat(22) + '.' + 'k'.repeat(22) },
  { kind: 'npm-token', secret: 'npm_' + 'l'.repeat(36) },
  { kind: 'jwt', secret: 'eyJ' + 'm'.repeat(20) + '.' + 'n'.repeat(20) + '.' + 'o'.repeat(20) },
  { kind: 'bearer-token', secret: 'Bearer ' + 'p'.repeat(32) },
  { kind: 'generic-assignment', secret: 'password=hunter2hunter2hunter2' },
];

describe('redactSecrets', () => {
  for (const { kind, secret } of SECRET_CASES) {
    test(`redacts ${kind}: raw secret absent, marker present`, () => {
      const input = `before ${secret} after`;
      const { text, redactions } = redactSecrets(input);

      // Mutation `/$^/` on this pattern => secret survives unredacted => RED.
      // keepsPrefix kinds retain the label (e.g. `password=`, `Bearer `), so assert on
      // the value portion only.
      const secretValue = secret.replace(/^(password=|Bearer )/, '');
      expect(text).not.toContain(secretValue);
      expect(text).toContain(`[REDACTED:${kind}]`);
      expect(redactions).toContain(kind);
    });
  }

  test('keepsPrefix retains the key/label but redacts the value', () => {
    const { text } = redactSecrets('password=hunter2hunter2hunter2');
    expect(text).toBe('password=[REDACTED:generic-assignment]');
  });

  test('Bearer prefix retained, token redacted', () => {
    const { text } = redactSecrets('Authorization: Bearer ' + 'z'.repeat(32));
    expect(text).toContain('Bearer [REDACTED:bearer-token]');
    expect(text).not.toContain('z'.repeat(32));
  });

  test('Bearer keyword is matched case-insensitively (BEARER)', () => {
    const { text, redactions } = redactSecrets('BEARER ' + 'z'.repeat(32));
    expect(text).not.toContain('z'.repeat(32));
    expect(redactions).toContain('bearer-token');
  });

  test('redacts a PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA' + 'q'.repeat(40),
      'r'.repeat(40),
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { text, redactions } = redactSecrets(`key:\n${pem}\ndone`);
    expect(text).not.toContain('MIIEowIBAAKCAQEA');
    expect(text).toContain('[REDACTED:pem-private-key]');
    expect(redactions).toContain('pem-private-key');
  });

  test('redactions reports kinds, never the secret value', () => {
    const secret = 'sk-ant-api03-' + 'S'.repeat(40);
    const { redactions } = redactSecrets(`token ${secret}`);
    expect(redactions).toEqual(['anthropic-key']);
    for (const r of redactions) {
      expect(r).not.toContain('S'.repeat(40)); // kind label never carries the secret value
      expect(secret).not.toContain(r);
    }
  });

  // False-positive guard: ordinary prose must NOT be over-redacted.
  // A mutation that broadens a pattern (drops the keyword/length anchor) turns these RED.
  const PROSE = [
    'the api key is in the vault',
    'the result = 42 today',
    'x = y for all cases',
    'this is password protected content',
    'please review the secret plan tomorrow',
    // High-entropy-looking but non-secret strings must NOT be over-redacted.
    'data: aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=', // base64 blob
    'id 550e8400-e29b-41d4-a716-446655440000 here', // UUID
    'commit e9d2037a1b2c3d4e5f6071829304a5b6c7d8e9f0 landed', // git SHA
    'see src/lib/sqlite-writers.ts:124 for the writer', // file path:line
    'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // hex hash
    'set RECALL_DB_PATH and EXTRACTION_MAX_CONCURRENT then run', // env var names
    'the Bearer of bad news arrived early', // "Bearer" as a plain word
    'use the sk- prefix convention here', // "sk-" as a plain word
  ];
  for (const prose of PROSE) {
    test(`does not over-redact prose: "${prose}"`, () => {
      const { text, redactions } = redactSecrets(prose);
      expect(text).toBe(prose);
      expect(redactions).toEqual([]);
    });
  }
});

describe('stripInvisibleUnicode', () => {
  test('strips zero-width, bidi, and BOM codepoints; keeps visible text', () => {
    const dirty = 'a' + INVISIBLE_CODEPOINTS.map((cp) => String.fromCodePoint(cp) + 'x').join('');
    const clean = stripInvisibleUnicode(dirty);

    // Mutation: remove the strip (return text unchanged) => an invisible survives => RED.
    expect(clean).toBe('a' + 'x'.repeat(INVISIBLE_CODEPOINTS.length));
    for (const cp of INVISIBLE_CODEPOINTS) {
      expect(clean).not.toContain(String.fromCodePoint(cp));
    }
  });

  test('leaves ordinary text (incl. punctuation/emoji) untouched', () => {
    const s = 'Hello, world — café 🚀 done.';
    expect(stripInvisibleUnicode(s)).toBe(s);
  });
});

describe('scrub (compose: strip then redact)', () => {
  test('strips invisibles first, then redacts the now-contiguous secret', () => {
    // A zero-width char hidden inside the key would defeat redaction if redaction ran
    // first; scrub strips it, making the key contiguous and redactable.
    const obfuscated = 'sk-ant-api03-' + 'A'.repeat(20) + ZWSP + 'A'.repeat(20);
    const { text, redactions } = scrub(`leak ${obfuscated} end`);
    expect(text).not.toContain('A'.repeat(40));
    expect(text).toContain('[REDACTED:anthropic-key]');
    expect(redactions).toContain('anthropic-key');
    expect(text).not.toContain(ZWSP);
  });

  test('clean prose passes through unchanged with no redactions', () => {
    const s = 'the api key is in the vault';
    expect(scrub(s)).toEqual({ text: s, redactions: [] });
  });
});

// Regression: two secrets concatenated with NO separator. A naive greedy distinctive-
// prefix class consumed the SECOND secret's anchor (`Bearer ` / assignment keyword),
// stranding its value in cleartext. The tempered-greedy classes must stop at the anchor
// so the second credential is redacted too. (Mutation: drop the NEXT_CRED lookahead =>
// the prefix over-runs the anchor => the second value leaks => RED.)
describe('concatenated secrets — no anchor-stranding leak (RedTeam HIGH)', () => {
  const CONCAT_CASES: { name: string; input: string; leak: string }[] = [
    { name: 'anthropic + bearer', input: 'sk-ant-api03-' + 'A'.repeat(40) + 'Bearer ' + 'p'.repeat(32), leak: 'p'.repeat(32) },
    { name: 'openai + assignment', input: 'sk-' + 'C'.repeat(40) + 'api_key=supersecret123', leak: 'supersecret123' },
    { name: 'github_pat + bearer', input: 'github_pat_' + 'e'.repeat(30) + 'Bearer ' + 'p'.repeat(32), leak: 'p'.repeat(32) },
    { name: 'glpat + bearer', input: 'glpat-' + 'f'.repeat(24) + 'Bearer ' + 'p'.repeat(32), leak: 'p'.repeat(32) },
    { name: 'bearer + assignment', input: 'Bearer ' + 'p'.repeat(32) + 'password=anothersecret99', leak: 'anothersecret99' },
    { name: 'anthropic + assignment', input: 'sk-ant-api03-' + 'A'.repeat(40) + 'password=zzzzzzzzzzzz', leak: 'zzzzzzzzzzzz' },
    // Round 2 — case-insensitive anchor + fixpoint exposure:
    { name: 'openai + UPPERCASE assignment', input: 'sk-' + 'C'.repeat(40) + 'API_KEY=supersecret123', leak: 'supersecret123' },
    { name: 'assignment + glued Bearer (fixpoint)', input: 'password=xxxxxxxxBearer ' + 'p'.repeat(32), leak: 'p'.repeat(32) },
    { name: 'triple chain openai+assign+bearer', input: 'sk-' + 'C'.repeat(40) + 'API_KEY=xxxxxxxxBearer ' + 'p'.repeat(32), leak: 'p'.repeat(32) },
  ];
  for (const { name, input, leak } of CONCAT_CASES) {
    test(`${name}: second credential value fully redacted`, () => {
      const { text } = scrub(input);
      expect(text).not.toContain(leak);
    });
  }
});
