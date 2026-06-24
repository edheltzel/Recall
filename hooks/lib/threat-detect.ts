// Injection / exfil content-threat detection (#156) — a SEPARATE layer beside
// the secret-redaction scrub() in write-safety.ts. Self-contained, pure, no
// imports from src/ (Key Conventions). Does NOT touch SECRET_PATTERNS / scrub();
// on the scrub paths it runs AFTER scrub over the already-scrubbed text.
//
// DETECT-AND-SURFACE ONLY — NEVER MUTATES, NEVER BLOCKS (Ed's ruling, #156):
// this layer is a pure detector. detectThreats() returns findings (category +
// span); callers SURFACE them (a returned findings array and/or a non-fatal
// warning log) but every persisted record stays byte-identical on every path.
// There is no redact tier and no block tier — nothing this layer produces can
// corrupt or reject content, so precision is total: a false positive is, at
// worst, a spurious flag.
//
// WHY no entropy-based redaction (the RedTeam ruling): you cannot distinguish a
// random SECRET from a random PUBLIC identifier by entropy + shape alone —
// base64url tokens (incl. the universal JWT header `eyJhbGciOi…`), base58 IDs
// (IPFS CIDs / addresses), and long nanoids all look exactly like anonymous
// secrets. Redacting/blocking on that signal silently corrupts public,
// non-secret content, so the entropy tier is FLAG-ONLY: anonymous high-entropy
// tokens are surfaced, never altered.
//
// ACCEPTED TRADEOFF: anchored, known-prefix secrets (sk-ant-…, Bearer …,
// key=…) remain handled by scrub() on the scrub paths (unchanged). Anonymous
// high-entropy secrets are only FLAGGED here, not redacted — by design.
//
// The regexes target distinctively dangerous *shapes* (a shell read verb
// governing a dotfile, curl/wget + a secret-named env interpolation, chat
// control tokens) so ordinary prose that merely mentions ~/.ssh, a .env file,
// or a DB_URL env var does not match. See threat-detect.test.ts for the proof
// corpus.

export type ThreatCategory =
  | 'instruction-override'
  | 'role-hijack'
  | 'env-exfil'
  | 'dotenv-read'
  | 'netrc-read'
  | 'ssh-key-ref'
  | 'high-entropy-token';

/**
 * A single detection. Carries NO matched text (a high-entropy span IS the
 * secret) — only its category and `[start, end)` offsets. Every finding is a
 * flag: surfacing it never mutates or blocks the scanned content.
 */
export interface ThreatFinding {
  category: ThreatCategory;
  span: [number, number];
}

interface InjectionPattern {
  category: ThreatCategory;
  regex: RegExp; // global so matchAll yields every occurrence + index
}

// A shell read/copy verb must GOVERN the dotfile path (#9-#11) and curl/wget
// must co-occur with a secret-named interpolation or an env/file dump (#7-#8),
// so prose mentions of the same paths/vars do not match. The `[^\n]*` segments
// are single-class with no nested quantifiers → linear, no ReDoS.
const INJECTION_PATTERNS: InjectionPattern[] = [
  // instruction-override
  { category: 'instruction-override', regex: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|preceding|earlier)\s+(?:instructions?|prompts?|context|messages?)\b/gi },
  { category: 'instruction-override', regex: /\bdisregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?)\b/gi },
  { category: 'instruction-override', regex: /\b(?:forget|ignore)\s+(?:everything|all)\s+(?:above|before|prior|you\s+were\s+told)\b/gi },

  // role-hijack / system-prompt override
  { category: 'role-hijack', regex: /<\|?(?:im_start|im_end|system|endoftext)\|?>/gi },
  { category: 'role-hijack', regex: /\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as)\s+(?:a\s+|an\s+|the\s+)?(?:DAN|admin|root|system|developer\s+mode|unrestricted)\b/gi },
  { category: 'role-hijack', regex: /^\s*system\s*:\s*you\s+(?:are|must|will|should)\b/gim },

  // env-exfil — network tool + secret-named interpolation / env-or-file dump
  { category: 'env-exfil', regex: /\b(?:curl|wget)\b[^\n]*\$\{?(?:[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z_]*)\}?/gi },
  { category: 'env-exfil', regex: /\b(?:curl|wget)\b[^\n]*(?:-d|--data(?:-binary|-raw)?|--post-data|-F|--form|-T|--upload-file)[^\n]*\$\(?\s*(?:env|printenv|cat)\b/gi },

  // sensitive-file reads — a shell read/copy verb must govern the path
  { category: 'dotenv-read', regex: /\b(?:cat|less|more|head|tail|cp|mv|scp|rsync|source|curl|wget)\s+(?:-\S+\s+)*(?:[~.]?\/?[\w./-]*\/)?\.env(?:\.\w+)?\b/gi },
  { category: 'netrc-read', regex: /\b(?:cat|less|more|head|tail|cp|mv|scp|rsync|source)\s+(?:-\S+\s+)*~?\/?[\w./-]*\.netrc\b/gi },
  { category: 'ssh-key-ref', regex: /\b(?:cat|less|more|head|tail|cp|mv|scp|rsync|curl|wget)\s+(?:-\S+\s+)*~?\/?(?:[\w./-]*\/)?\.ssh\/(?:id_[a-z0-9]+|authorized_keys|id_[a-z0-9]+\.pub)?\b/gi },
];

// ---- Anonymous high-entropy token — surfaced as a flag (never mutated) ----
// The structural guards below are noise-reduction (don't flag every git SHA or
// identifier), NOT corruption-prevention: since a high-entropy finding only
// flags, a missed exclusion costs at most a spurious flag, never a redaction.

/** Bounds for a credential-shaped token: long enough to be a secret, short enough to exclude data blobs. */
const TOKEN_MIN_LEN = 28;
const TOKEN_MAX_LEN = 72;
/** Shannon-entropy floor (bits/char) — backstop behind the structural guards. */
const TOKEN_ENTROPY_MIN = 4.0;
/** A single-case letter run this long marks a word chunk (identifier), not a random token. */
const MAX_LETTER_RUN = 5;
/** Real long credentials are digit-rich; camelCase identifiers are digit-sparse. */
const MIN_DIGITS = 3;

// Broad token run — INCLUDES + / = so base64 / data-URI shapes are recognized
// (in order to be excluded), not split into innocent-looking sub-tokens.
const TOKEN_RUN = /[A-Za-z0-9_+/=-]+/g;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PURE_HEX_RE = /^[0-9a-fA-F]+$/;

/** Shannon entropy in bits/char over the distinct-character distribution. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  let h = 0;
  for (const k in counts) {
    const p = counts[k] / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Length of the longest run of consecutive same-case ASCII letters (digits/symbols break runs). */
export function longestLetterRun(s: string): number {
  let max = 0;
  let cur = 0;
  let prev: 'u' | 'l' | null = null;
  for (const ch of s) {
    const cls = ch >= 'a' && ch <= 'z' ? 'l' : ch >= 'A' && ch <= 'Z' ? 'u' : null;
    if (cls && cls === prev) cur++;
    else if (cls) { cur = 1; prev = cls; }
    else { cur = 0; prev = null; }
    if (cur > max) max = cur;
  }
  return max;
}

/**
 * Does `token` look like an anonymous high-entropy credential worth FLAGGING?
 * Excludes obvious non-credentials to keep flag noise down: base64/data-URI
 * shapes (+ / =), out-of-range lengths, pure-hex digests (git SHA / md5 /
 * sha256), UUIDs, non-3-class or digit-sparse strings, and word-structured
 * identifiers (long single-case letter run), then a Shannon floor. This is a
 * signal filter, not a safety boundary — a high-entropy finding only flags.
 */
export function isHighEntropyToken(token: string): boolean {
  if (/[+/=]/.test(token)) return false;                 // base64 / data-URI
  if (token.length < TOKEN_MIN_LEN || token.length > TOKEN_MAX_LEN) return false;
  if (PURE_HEX_RE.test(token)) return false;             // git SHA / md5 / sha256
  if (UUID_RE.test(token)) return false;
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const digitCount = (token.match(/[0-9]/g) ?? []).length;
  if (!hasLower || !hasUpper || digitCount < MIN_DIGITS) return false; // 3-class + digit-rich
  if (longestLetterRun(token) >= MAX_LETTER_RUN) return false;         // identifier word-chunk
  if (shannonEntropy(token) < TOKEN_ENTROPY_MIN) return false;
  return true;
}

/**
 * Pure detection — no policy, no mutation, no blocking. Returns every
 * injection/exfil match and every anonymous high-entropy token as a flag
 * finding (category + span), sorted by span start. Callers surface findings;
 * the scanned text is NEVER altered by this layer.
 */
export function detectThreats(text: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  for (const p of INJECTION_PATTERNS) {
    for (const m of text.matchAll(p.regex)) {
      const start = m.index ?? 0;
      findings.push({ category: p.category, span: [start, start + m[0].length] });
    }
  }
  for (const m of text.matchAll(TOKEN_RUN)) {
    if (isHighEntropyToken(m[0])) {
      const start = m.index ?? 0;
      findings.push({ category: 'high-entropy-token', span: [start, start + m[0].length] });
    }
  }
  findings.sort((a, b) => a.span[0] - b.span[0]);
  return findings;
}

/** Compact, value-free summary of findings for a non-fatal surface log (e.g. "2 flag(s): env-exfil, high-entropy-token"). */
export function summarizeThreats(findings: ThreatFinding[]): string {
  const categories = [...new Set(findings.map((f) => f.category))].join(', ');
  return `${findings.length} flag(s): ${categories}`;
}
