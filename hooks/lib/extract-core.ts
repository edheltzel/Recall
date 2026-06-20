// Shared extract-core — the single `text → extract → quality-gate → scrub →
// dualWriteToSqlite` pipeline. Both the end-of-session `Stop` hook
// (RecallExtract.ts → extractAndAppend / extractAndAppendMarkdown) and the
// future in-session hook (#51 P3, RecallInSession.ts) call this with a text
// argument — the whole transcript for the Stop path, a slice for P3.
//
// Self-contained per the Key Conventions: imports only from other hooks/lib
// modules, never from src/ and never from RecallExtract.ts (which self-executes
// on import). The extraction-model call and topic/summary derivation live in
// RecallExtract.ts, so they are INJECTED via `deps` — this is also the seam the
// tests use to feed a representative extracted-text fixture as the model output
// without shelling out to the real `claude` CLI.
//
// SECURITY GUARD (#51 P2, Ed's ruling): every text field that gets persisted to
// SQLite passes through `scrub()` (secret redaction + invisible-unicode strip)
// before it reaches a writer — the extracted body, the summary, AND the topics.
// No persisted text field may bypass the guard. The RAW (un-scrubbed) values are
// returned to the caller so the legacy markdown side-effects stay unchanged; the
// scrub applies only to the SQLite write path.

import { evaluateQuality, type QualityResult } from './extraction-quality';
import { scrub } from './write-safety';
import {
  dualWriteToSqlite,
  type DualWriteContext,
  type DualWriteResult,
} from './extraction-parsers';

/** Why a core run did not produce a SQLite write. */
export type ExtractOutcome = 'extracted' | 'extraction_failed' | 'quality_failed';

/** Injected RecallExtract-resident behavior the lib core can't import directly. */
export interface ExtractCoreDeps {
  /** Run the extraction model over raw text; returns extracted markdown or null. */
  extract: (input: string) => Promise<string | null>;
  /** Derive topics + summary from the extracted markdown (reuses existing helpers). */
  deriveMeta: (extracted: string) => { topics: string[]; summary: string };
}

/** Context fields that do NOT depend on the extracted text (caller supplies up-front). */
export type ExtractCoreContext = Omit<
  DualWriteContext,
  'extracted' | 'topics' | 'summary'
>;

export interface ExtractCoreResult {
  outcome: ExtractOutcome;
  /** Set on every outcome except 'extraction_failed'. */
  quality?: QualityResult;
  /** RAW (un-scrubbed) extracted markdown — for the caller's markdown side-effects. */
  extracted?: string;
  /** RAW (un-scrubbed) topics — for the caller's markdown side-effects. */
  topics?: string[];
  /** RAW (un-scrubbed) summary — for the caller's markdown side-effects. */
  summary?: string;
  /** Distinct secret kinds redacted across all persisted fields (never the values). */
  redactions?: string[];
  /** Present only when outcome === 'extracted'. */
  dualWrite?: DualWriteResult;
}

/**
 * Run the shared pipeline: extract → quality-gate → scrub → dual-write.
 *
 * Returns early (no SQLite write) when the model produces nothing
 * ('extraction_failed') or the quality gate rejects the output
 * ('quality_failed'); the caller decides how to log / mark those. On success the
 * SQLite dual-write has already happened (with scrubbed text) and `dualWrite`
 * carries the per-table counts; `extracted`/`topics`/`summary` are the RAW values
 * for the caller's legacy markdown side-effects.
 */
export async function runExtractCore(
  dbPath: string,
  input: string,
  ctx: ExtractCoreContext,
  deps: ExtractCoreDeps,
): Promise<ExtractCoreResult> {
  const extracted = await deps.extract(input);
  if (!extracted) return { outcome: 'extraction_failed' };

  const quality = evaluateQuality(extracted);
  if (!quality.pass) return { outcome: 'quality_failed', quality };

  const { topics, summary } = deps.deriveMeta(extracted);

  // Scrub EVERY persisted text field before it reaches a writer. dualWriteToSqlite
  // persists: ctx.extracted (parsed into decisions/learnings/breadcrumbs/errors +
  // LoA fabric_extract), ctx.summary (extraction_sessions.summary + LoA
  // description), and ctx.topics (extraction_sessions.topics + LoA tags). None may
  // bypass the guard — a secret in the one-sentence summary must be redacted too.
  const scrubbedExtracted = scrub(extracted);
  const scrubbedSummary = scrub(summary);
  const scrubbedTopics = topics.map((t) => scrub(t));
  const redactions = [
    ...new Set([
      ...scrubbedExtracted.redactions,
      ...scrubbedSummary.redactions,
      ...scrubbedTopics.flatMap((r) => r.redactions),
    ]),
  ];

  const dualWrite = dualWriteToSqlite(dbPath, {
    ...ctx,
    extracted: scrubbedExtracted.text,
    summary: scrubbedSummary.text,
    topics: scrubbedTopics.map((r) => r.text),
  });

  return {
    outcome: 'extracted',
    quality,
    extracted,
    topics,
    summary,
    redactions,
    dualWrite,
  };
}
