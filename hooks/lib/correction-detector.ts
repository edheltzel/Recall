// Correction detector — pure, self-contained, no imports from src/ (Key Conventions).
//
// Detects when a just-submitted user message is a CORRECTION ("no, that's wrong,
// use X", "I told you before", "actually, change it") — the highest-signal,
// most-perishable learning data (issue #52). Ported from pi-hermes-memory's
// two-pass regex filter (chandra447/pi-hermes-memory src/handlers/correction-detector.ts
// + constants.ts):
//
//   1. NEGATIVE patterns SUPPRESS — if any fires, it is NOT a correction, even
//      if a positive pattern also matched (benign "no problem", "actually looks
//      great" must never be captured).
//   2. STRONG patterns fire ALONE (high confidence — "that's wrong", "I told you").
//   3. WEAK leads ("no,", "actually,", "wrong,", "stop,") fire ONLY when a
//      DIRECTIVE word follows the lead — so a bare "actually" never fires, but
//      "actually use the helper" does.
//
// Pure string -> { isCorrection, matched? }. No DB, no I/O, no env reads. The
// caller (hooks/lib/insession.ts handleCorrection) owns the rate-limit, scrub,
// and write; this module only classifies. Extra patterns (from the optional
// RECALL_CORRECTIONS_PATTERNS env list) are passed in as plain strings and merged
// into the STRONG set, keeping this function pure and config-overridable.

/** Result of classifying a single user message. */
export interface CorrectionMatch {
  /** True iff the text is a correction (a strong/weak+directive hit, not suppressed). */
  isCorrection: boolean;
  /** The label of the pattern that fired (for logging/debugging). Absent when none. */
  matched?: string;
}

/** Optional config — extra strong patterns merged in (RECALL_CORRECTIONS_PATTERNS). */
export interface CorrectionDetectorConfig {
  /** Extra patterns (regex sources, matched case-insensitively) that fire ALONE like strong patterns. */
  extraPatterns?: string[];
}

// ── Pass 1: NEGATIVE (suppressors) ───────────────────────────────────────────
// If any of these match, the message is benign affirmation/acknowledgement and
// must NOT be captured — even when a positive pattern also matched. These are
// load-bearing precisely because the directive list below is broad (it includes
// "the/that/this/it"), so "no problem, that works" would otherwise fire.
const NEGATIVE_PATTERNS: RegExp[] = [
  /^no worries/i,
  /^no problem/i,
  /^no thanks/i,
  /^no need/i,
  /^correct[\s!.,]/i, // "correct!", "correct, thanks"
  /^correct$/i, // bare "correct"
  /^that'?s right/i, // affirmation — NOTE: "that's not right" is NOT matched (the "not" breaks it)
  /^that'?s correct/i,
  /^that'?s perfect/i,
  /^perfect/i,
  /^actually.{0,12}(looks? great|perfect|good|correct|right|nice|fine)/i,
  /^stop.{0,5}(there|here|for now)/i,
];

// ── Pass 2: STRONG (fire alone) ──────────────────────────────────────────────
const STRONG_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'dont-do-that', re: /don'?t do that/i },
  { label: 'not-like-that', re: /not like that/i },
  { label: 'i-said', re: /^i said\b/i },
  { label: 'i-told-you', re: /\bi told you\b/i }, // covers "I told you before"
  { label: 'we-discussed', re: /we already discussed/i },
  { label: 'please-dont', re: /^please don'?t/i },
  { label: 'not-what-i', re: /^that'?s not what i/i },
  { label: 'thats-wrong', re: /that'?s wrong/i },
  { label: 'thats-incorrect', re: /that'?s incorrect/i },
  { label: 'thats-not-right', re: /that'?s not (right|correct)/i },
];

// ── Pass 2: WEAK leads (require a directive) ─────────────────────────────────
// Each weak lead anchors at the start and requires a trailing separator, so a
// bare token ("actually") never matches; the lead must be FOLLOWED by a
// directive word for the message to count as a correction.
const WEAK_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'no-lead', re: /^no[,.\s!]/i },
  { label: 'wrong-lead', re: /^wrong[,.\s!]/i },
  { label: 'actually-lead', re: /^actually[,.\s]/i },
  { label: 'stop-lead', re: /^stop[,.\s!]/i },
];

// Directive words: an imperative/pointer that turns a weak lead into a correction.
// Broad on purpose (matches pi-hermes): includes pointers (the/that/this/it) so
// "no, that's the wrong file" fires — the NEGATIVE pass guards the benign cases.
const DIRECTIVE_WORDS = [
  'use', "don't", 'dont', 'do', 'try', 'make', 'run', 'install', 'add', 'remove',
  'delete', 'change', 'fix', 'put', 'set', 'write', 'go', 'stop', 'start',
  'instead', 'the', 'that', 'this', 'it',
];
const DIRECTIVE_RE = new RegExp(`\\b(?:${DIRECTIVE_WORDS.map(escapeRegExp).join('|')})\\b`, 'i');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile the caller-provided extra patterns, skipping any that don't compile. */
function compileExtra(extra: string[] | undefined): { label: string; re: RegExp }[] {
  if (!extra || extra.length === 0) return [];
  const out: { label: string; re: RegExp }[] = [];
  for (const src of extra) {
    if (typeof src !== 'string' || !src.trim()) continue;
    try {
      out.push({ label: `custom:${src}`, re: new RegExp(src, 'i') });
    } catch {
      // Invalid user-supplied regex — skip rather than throw (the hook must never crash a turn).
    }
  }
  return out;
}

/**
 * Classify a user message as a correction or not (pure).
 *
 * Order matters: negatives suppress first, then strong fires alone, then a weak
 * lead fires only when a directive word follows it. Returns the matched pattern
 * label so the caller can log WHY a correction was captured.
 */
export function detectCorrection(text: string, config?: CorrectionDetectorConfig): CorrectionMatch {
  if (typeof text !== 'string') return { isCorrection: false };
  const trimmed = text.trim();
  if (!trimmed) return { isCorrection: false };

  // Pass 1 — suppress benign acknowledgements regardless of any positive match.
  for (const re of NEGATIVE_PATTERNS) {
    if (re.test(trimmed)) return { isCorrection: false };
  }

  // Pass 2a — strong patterns (incl. caller-provided extras) fire alone.
  for (const p of [...STRONG_PATTERNS, ...compileExtra(config?.extraPatterns)]) {
    if (p.re.test(trimmed)) return { isCorrection: true, matched: p.label };
  }

  // Pass 2b — a weak lead fires only when a directive word follows the lead.
  for (const p of WEAK_PATTERNS) {
    const m = p.re.exec(trimmed);
    if (!m) continue;
    const remainder = trimmed.slice(m[0].length);
    if (DIRECTIVE_RE.test(remainder)) return { isCorrection: true, matched: p.label };
  }

  return { isCorrection: false };
}
