// Minimal write-safety guard — self-contained, pure, no imports from src/ (Key Conventions).
//
// SCOPE (deliberately a subset — Karpathy §2, minimum that solves the problem):
// This is the SEED for issue #50's full shared content-scanner, NOT that scanner.
// It carries only the *load-bearing* subset that issues #51/#52 need before any
// auto-write: (a) ~high-confidence secret redaction, (b) invisible/bidi unicode
// stripping. It intentionally OMITS the false-positive-prone injection/exfil
// regexes, severity tiers, policy engine, and config matrix — those stay for #50,
// which later supersedes this file by porting the pattern table up into src/.
//
// Pure string -> string. No DB, no I/O, no dbPath. Redaction is visible-by-design:
// secrets are replaced with a `[REDACTED:<kind>]` marker so search still finds the
// surrounding context. P0 of #51 builds ONLY this guard — it is not yet wired into
// any write path (that is later phases).

// Start of a following KNOWN credential whose own pattern must get a chance to match.
// When two secrets are concatenated with no separator, a naive greedy distinctive-prefix
// class would consume the next secret's anchor (the `Bearer ` keyword, or a
// `key=`/`key:` assignment keyword) and strand that second token's value in cleartext.
// The tempered-greedy classes below stop at this anchor so the next pattern still fires.
// NOTE (#50 deferral): truly-unprefixed standalone secrets concatenated with NO
// recognizable anchor at all are out of this subset — full entropy detection is #50.
const NEXT_CRED = String.raw`(?:Bearer\s|(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=])`;

// Tempered greedy: consume one char of `cls` at a time, but stop before a known
// next-credential anchor. Returns a regex-source fragment for `new RegExp`.
const tempered = (cls: string, min: number): string => `(?:(?!${NEXT_CRED})${cls}){${min},}`;

/** A single high-confidence secret pattern. */
interface SecretPattern {
  /** Stable label reported in `redactions[]` and shown in the `[REDACTED:<kind>]` marker. */
  kind: string;
  /** Global regex matching the secret. */
  regex: RegExp;
  /**
   * When true, capture group 1 is a visible prefix kept in place (e.g. `Bearer `,
   * `api_key=`) and only the secret value is replaced. When false/absent, the whole
   * match is the secret and is replaced entirely.
   */
  keepsPrefix?: boolean;
}

// Ordered specific -> generic so a precise pattern claims a secret before a broad one.
// Each regex targets a well-known, distinctively-shaped credential to keep false
// positives on ordinary prose near zero (over-redaction is a failure, not a safety win).
// Open-ended `{N,}` classes are TEMPERED (see NEXT_CRED) so a glued-on second credential
// keeps its own anchor; fixed-length patterns can't over-run and stay plain literals.
const SECRET_PATTERNS: SecretPattern[] = [
  // PEM / OpenSSH private key blocks (multi-line) — lazy match bounded by the END marker.
  { kind: 'pem-private-key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },

  // Provider API keys with distinctive prefixes (open-ended -> tempered).
  { kind: 'anthropic-key', regex: new RegExp(String.raw`sk-ant-` + tempered('[A-Za-z0-9_-]', 20), 'g') },
  { kind: 'openai-key', regex: new RegExp(String.raw`sk-proj-` + tempered('[A-Za-z0-9_-]', 20), 'g') },
  { kind: 'openai-key', regex: new RegExp(String.raw`sk-` + tempered('[A-Za-z0-9]', 32), 'g') },
  { kind: 'aws-akid', regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { kind: 'github-pat', regex: new RegExp(String.raw`gh[pousr]_` + tempered('[A-Za-z0-9]', 36), 'g') },
  { kind: 'github-pat', regex: new RegExp(String.raw`github_pat_` + tempered('[A-Za-z0-9_]', 22), 'g') },
  { kind: 'gitlab-pat', regex: new RegExp(String.raw`glpat-` + tempered('[A-Za-z0-9_-]', 20), 'g') },
  { kind: 'slack-token', regex: new RegExp(String.raw`xox[baprs]-` + tempered('[A-Za-z0-9-]', 10), 'g') },
  { kind: 'slack-webhook', regex: new RegExp(String.raw`https://hooks\.slack\.com/services/` + tempered('[A-Za-z0-9_/+]', 20), 'g') },
  { kind: 'google-api-key', regex: /AIza[A-Za-z0-9_-]{35}/g },
  { kind: 'stripe-key', regex: new RegExp(String.raw`(?:sk|rk|pk)_(?:live|test)_` + tempered('[A-Za-z0-9]', 16), 'g') },
  { kind: 'sendgrid-key', regex: new RegExp(String.raw`SG\.` + tempered('[A-Za-z0-9_-]', 16) + String.raw`\.` + tempered('[A-Za-z0-9_-]', 16), 'g') },
  { kind: 'npm-token', regex: /npm_[A-Za-z0-9]{36}/g },
  { kind: 'jwt', regex: new RegExp(String.raw`eyJ` + tempered('[A-Za-z0-9_-]', 10) + String.raw`\.` + tempered('[A-Za-z0-9_-]', 10) + String.raw`\.` + tempered('[A-Za-z0-9_-]', 10), 'g') },

  // `Bearer <token>` — keep the `Bearer ` prefix, redact the (tempered) token.
  { kind: 'bearer-token', regex: new RegExp(String.raw`(\bBearer\s+)` + tempered('[A-Za-z0-9._-]', 16), 'g'), keepsPrefix: true },

  // Conservative `key = value` / `key: value` assignment for named secrets — keep the
  // key + separator (useful context) and redact only the (tempered) value. Requires a
  // recognized secret keyword and an 8+ char value so ordinary prose ("the api key is in
  // the vault", "x = y") is not over-redacted.
  {
    kind: 'generic-assignment',
    regex: new RegExp(
      String.raw`(\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*['"]?)` +
        tempered('[A-Za-z0-9_./+=-]', 8) +
        String.raw`['"]?`,
      'gi',
    ),
    keepsPrefix: true,
  },
];

/**
 * Replace high-confidence secrets with visible `[REDACTED:<kind>]` markers.
 * Returns the scrubbed text and the distinct kinds redacted (never the secret values).
 */
export function redactSecrets(text: string): { text: string; redactions: string[] } {
  const kinds = new Set<string>();
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.regex, (...args) => {
      kinds.add(p.kind);
      const prefix = p.keepsPrefix ? String(args[1] ?? '') : '';
      return `${prefix}[REDACTED:${p.kind}]`;
    });
  }
  return { text: out, redactions: [...kinds] };
}

// Zero-width, bidi-control, and BOM codepoints used to hide or reorder text:
//   U+200B–200F (zero-width space/joiners, LRM/RLM)
//   U+202A–202E (bidi embeddings/overrides)
//   U+2066–2069 (bidi isolates)
//   U+FEFF      (zero-width no-break space / BOM)
const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Strip zero-width / bidi / invisible codepoints from text. */
export function stripInvisibleUnicode(text: string): string {
  return text.replace(INVISIBLE_UNICODE, '');
}

/**
 * The only public call site for write paths: strip invisible unicode, then redact
 * secrets. Returns the scrubbed text and the distinct kinds redacted.
 */
export function scrub(text: string): { text: string; redactions: string[] } {
  return redactSecrets(stripInvisibleUnicode(text));
}
