// Injection / exfil content-threat detection (#156) — a SEPARATE layer beside
// the secret-redaction scrub() in write-safety.ts. Self-contained, pure, no
// imports from src/ (Key Conventions). Does NOT touch SECRET_PATTERNS / scrub();
// on the scrub paths it runs AFTER scrub on the already-scrubbed text.
//
// DESIGN PRINCIPLE — PRECISION OVER RECALL (#156 is the false-positive minefield):
// a false positive (corrupting/blocking a legit note) is a failure; a missed
// exotic injection is recoverable. Precision is earned STRUCTURALLY:
//   - All 11 injection/exfil regexes are `flag`-tier ONLY. `flag` never mutates
//     or blocks content on any path, so an over-matching regex costs at most a
//     benign annotation in findings[] — never a corrupted or rejected note.
//   - The ONLY tier that mutates text is `redact` (the anchorless high-entropy
//     token, closing the PR #128 residual), and it carries a layered FP-guard
//     chain (see isHighEntropyToken) so git SHAs / UUIDs / base64 / hashes /
//     identifiers are never redacted.
//   - The ONLY action that blocks a write is `redact`-tier on the explicit
//     `memory_add` path (a single fixable error, never a bulk block-storm).
//
// The regexes target distinctively dangerous *shapes* (a shell read verb
// governing a dotfile, curl/wget + a secret-named env interpolation, chat
// control tokens) so ordinary prose that merely mentions ~/.ssh, a .env file,
// or a DB_URL env var does not match. See threat-detect.test.ts for the proof
// corpus (true positives + must-not-block prose/token fixtures).

export type ThreatCategory =
  | 'instruction-override'
  | 'role-hijack'
  | 'env-exfil'
  | 'dotenv-read'
  | 'netrc-read'
  | 'ssh-key-ref'
  | 'high-entropy-token';

/** Intrinsic tier of a pattern. `flag` = annotate only; `redact` = neutralize the span. */
export type ThreatSeverity = 'flag' | 'redact';

/** Action resolved for a finding on a given ingestion path. `block` = reject the write. */
export type ThreatAction = 'flag' | 'redact' | 'block';

/** Ingestion paths with distinct strictness (bulk paths never block). */
export type IngestionPath = 'session' | 'import-legacy' | 'memory_add';

/** A raw detection — never carries the matched text (a high-entropy span IS the secret). */
export interface ThreatFinding {
  category: ThreatCategory;
  severity: ThreatSeverity;
  /** `[start, end)` offsets into the scanned text. */
  span: [number, number];
}

/** A finding with its per-path action resolved. */
export interface ResolvedThreat extends ThreatFinding {
  action: ThreatAction;
}

export interface ThreatScanResult {
  /** Input with `redact`-action spans replaced; unchanged when blocked or only flagged. */
  text: string;
  findings: ResolvedThreat[];
  /** True iff any finding resolved to `block` — the caller must NOT persist `text`. */
  blocked: boolean;
  /** Category + count of the blocking findings; never the value. */
  blockReason?: string;
}

interface InjectionPattern {
  category: ThreatCategory;
  regex: RegExp; // global so matchAll yields every occurrence + index
}

// All flag-tier. A shell read/copy verb must GOVERN the dotfile path (#9-#11) and
// curl/wget must co-occur with a secret-named interpolation or an env/file dump
// (#7-#8), so prose mentions of the same paths/vars do not match. The `[^\n]*`
// segments are single-class with no nested quantifiers → linear, no ReDoS.
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

// ---- Anchorless high-entropy token (redact-tier) — the PR #128 residual ----

/** Bounds for a credential-shaped token: long enough to be a secret, short enough to exclude data blobs. */
const TOKEN_MIN_LEN = 28;
const TOKEN_MAX_LEN = 72;
/**
 * Shannon-entropy floor (bits/char). A backstop behind the structural guards:
 * with >= 3 digits and no long letter-run, a real credential's entropy clears
 * this comfortably (measured TP tokens: 4.52 / 5.00 / 5.17), while low-entropy
 * repetitive strings fall below. Pinned by measured fixtures in the test corpus.
 */
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
 * Is `token` an anchorless high-entropy credential (redact-tier)? Excludes — in
 * order — base64/data-URI shapes (+ / =), out-of-range lengths, pure-hex digests
 * (git SHA / md5 / sha256), UUIDs, non-3-class or digit-sparse strings,
 * word-structured identifiers (long single-case letter run), and finally
 * anything below the entropy floor. The combination is what keeps SHAs / UUIDs /
 * base64 / hashes / identifiers clean while catching a bare pasted credential.
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
 * Pure detection — no policy, no mutation. Returns every injection/exfil match
 * (flag-tier) and every anchorless high-entropy token (redact-tier), sorted by
 * span start. Findings carry no matched text.
 */
export function detectThreats(text: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  for (const p of INJECTION_PATTERNS) {
    for (const m of text.matchAll(p.regex)) {
      const start = m.index ?? 0;
      findings.push({ category: p.category, severity: 'flag', span: [start, start + m[0].length] });
    }
  }
  for (const m of text.matchAll(TOKEN_RUN)) {
    if (isHighEntropyToken(m[0])) {
      const start = m.index ?? 0;
      findings.push({ category: 'high-entropy-token', severity: 'redact', span: [start, start + m[0].length] });
    }
  }
  findings.sort((a, b) => a.span[0] - b.span[0]);
  return findings;
}

/** Per-path policy: bulk paths redact a credential; the explicit memory_add path blocks it. */
function resolveAction(path: IngestionPath, severity: ThreatSeverity): ThreatAction {
  if (severity === 'flag') return 'flag';
  return path === 'memory_add' ? 'block' : 'redact';
}

/**
 * Detect + apply per-path policy. `flag` findings never touch the text. `redact`
 * findings replace their span with a visible `[THREAT-REDACTED:<category>]`
 * marker (applied right-to-left so spans stay valid). If any finding resolves to
 * `block`, the text is returned UNCHANGED and `blocked` is true — the caller must
 * not persist it.
 */
export function scanForThreats(text: string, path: IngestionPath): ThreatScanResult {
  const findings: ResolvedThreat[] = detectThreats(text).map((f) => ({
    ...f,
    action: resolveAction(path, f.severity),
  }));

  const blockCount = findings.filter((f) => f.action === 'block').length;
  if (blockCount > 0) {
    return {
      text, // unchanged — caller rejects the write
      findings,
      blocked: true,
      blockReason: `${blockCount} suspected credential(s) (high-entropy-token) — remove and retry`,
    };
  }

  let out = text;
  // Right-to-left so earlier spans keep their offsets as we splice.
  const redactions = findings
    .filter((f) => f.action === 'redact')
    .sort((a, b) => b.span[0] - a.span[0]);
  for (const f of redactions) {
    out = out.slice(0, f.span[0]) + `[THREAT-REDACTED:${f.category}]` + out.slice(f.span[1]);
  }

  return { text: out, findings, blocked: false };
}
