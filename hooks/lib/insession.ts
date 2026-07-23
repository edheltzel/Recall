// In-session learning loop — decision logic (issue #51 P3).
//
// Self-contained per the Key Conventions: imports only from other hooks/lib
// modules, never from src/. The model call + topic/summary derivation are
// INJECTED via deps (mirroring how RecallExtract builds them) so this logic is
// unit-testable against a temp DB without spawning the real hook or the claude
// CLI. The hook entry (hooks/RecallInSession.ts) is a thin wrapper around these.
//
// Two roles, split so the cheap path stays in-process (fast) and the expensive
// path runs async (non-blocking):
//   - decideInSession()        — parent: increment the counter + evaluate cadence
//   - runInSessionExtraction() — child: lock → slice → runExtractCore → advance
//
// The OFF-by-default master flag is enforced here too (config.enabled), but the
// hook's ~free fast-path lives in RecallInSession.ts main() — it exits before
// this module touches the DB.

import {
  ensureSession,
  incrementTurns,
  incrementTools,
  incrementRuns,
  incrementPrompts,
  recordCorrection,
  advanceOffset,
  resetWindow,
  getSessionProgress,
  type SessionProgressRecord,
} from './session-progress';
import { childAcquireLock, childReleaseLock, parentIsLockHeld } from './extraction-lock';
import { runExtractCore, type ExtractCoreContext } from './extract-core';
import type { DualWriteResult } from './extraction-parsers';
import { detectCorrection } from './correction-detector';
import { scrub } from './write-safety';
import { writeLearningsBatch } from './sqlite-writers';
import type { EventKind } from './events';

export type { EventKind } from './events';

// ─── Config (design §3.5 — env vars, no config file) ────────────────────────

export interface InSessionConfig {
  /** Master flag. OFF (false) unless RECALL_INSESSION_ENABLED === '1'. */
  enabled: boolean;
  /** Fire a run when turns_seen reaches this (default 10). */
  turnCadence: number;
  /** Fire a run when tools_seen reaches this (default 15). */
  toolCadence: number;
  /** Budget — max extraction runs per session (default 20). */
  maxRuns: number;
  /** Floor — turns_seen must reach this before any run, so trivial sessions never fire (default 3). */
  minTurns: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read the in-session config from an env bag (process.env in production). */
export function readInSessionConfig(env: Record<string, string | undefined>): InSessionConfig {
  return {
    enabled: env.RECALL_INSESSION_ENABLED === '1',
    turnCadence: intFromEnv(env.RECALL_INSESSION_TURN_CADENCE, 10),
    toolCadence: intFromEnv(env.RECALL_INSESSION_TOOL_CADENCE, 15),
    maxRuns: intFromEnv(env.RECALL_INSESSION_MAX_RUNS, 20),
    minTurns: intFromEnv(env.RECALL_INSESSION_MIN_TURNS, 3),
  };
}

// ─── #52 corrections config + handler (independent of the in-session loop) ───

/** Minimum prompts between two correction saves (pi-hermes' load-bearing 1-per-3). */
const CORRECTION_MIN_GAP = 3;
/** Importance stamped on a captured correction — elevated, so it surfaces in L1. */
const CORRECTION_IMPORTANCE = 8;
/** Cap on the stored correction text (the correction + its surrounding message). */
const MAX_CORRECTION_CHARS = 2000;

export interface CorrectionsConfig {
  /** Master flag. OFF unless RECALL_CORRECTIONS_ENABLED === '1'. INDEPENDENT of RECALL_INSESSION_ENABLED. */
  enabled: boolean;
  /** Extra strong patterns merged into the detector (RECALL_CORRECTIONS_PATTERNS, comma/newline separated). */
  extraPatterns: string[];
  /** Minimum monotonic-prompt gap between saves (default 3). */
  minGap: number;
}

/** Split a comma/newline-separated env list into trimmed, non-empty pattern sources. */
function parsePatternList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read the corrections config from an env bag. The master flag is deliberately
 * SEPARATE from RECALL_INSESSION_ENABLED so corrections can be captured without
 * turning on the full extraction loop (and vice-versa).
 */
export function readCorrectionsConfig(env: Record<string, string | undefined>): CorrectionsConfig {
  return {
    enabled: env.RECALL_CORRECTIONS_ENABLED === '1',
    extraPatterns: parsePatternList(env.RECALL_CORRECTIONS_PATTERNS),
    minGap: CORRECTION_MIN_GAP,
  };
}

/**
 * Rate-limit predicate (pure). A correction may be saved iff none has been saved
 * yet (last_correction_turn === 0) OR at least `minGap` MONOTONIC prompts have
 * elapsed since the last save. Reads prompts_seen / last_correction_turn — both
 * untouched by resetWindow — so a window reset between corrections can never
 * wrongly re-open the gate (the wrinkle the design §4.2 flags). turns_seen is
 * intentionally NOT consulted here.
 */
export function correctionAllowed(
  p: Pick<SessionProgressRecord, 'prompts_seen' | 'last_correction_turn'>,
  minGap: number = CORRECTION_MIN_GAP
): boolean {
  if (p.last_correction_turn === 0) return true; // no correction saved yet
  return p.prompts_seen - p.last_correction_turn >= minGap;
}

export type CorrectionOutcome =
  | 'disabled'
  | 'not_correction'
  | 'rate_limited'
  | 'saved';

export interface CorrectionHandleResult {
  detected: boolean;
  saved: boolean;
  outcome: CorrectionOutcome;
  matched?: string;
  redactions?: string[];
}

/**
 * Parent-inline correction capture for a UserPromptSubmit (issue #52). Cheap and
 * non-blocking: a pure regex classify + at most one batch insert, NO model call.
 *
 * Flow: ensure the session row → increment the MONOTONIC prompt counter → classify
 * the prompt. On a correction that the rate-limit allows: SCRUB the text FIRST
 * (the verbatim-text path is the genuinely-new exposure #50 guards — the scrub is
 * what makes it safe enough to ship), write a high-confidence learning, and stamp
 * last_correction_turn = prompts_seen.
 *
 * prompts_seen is incremented for EVERY enabled UserPromptSubmit (correction or
 * not) so the gap reflects real elapsed prompts. When disabled this is a no-op
 * that never touches the DB.
 */
export function handleCorrection(
  dbPath: string,
  sessionId: string,
  convPath: string | null,
  promptText: string,
  project: string | null,
  config: CorrectionsConfig
): CorrectionHandleResult {
  if (!config.enabled) return { detected: false, saved: false, outcome: 'disabled' };

  ensureSession(dbPath, sessionId, convPath);
  incrementPrompts(dbPath, sessionId);

  const detection = detectCorrection(promptText, { extraPatterns: config.extraPatterns });
  if (!detection.isCorrection) {
    return { detected: false, saved: false, outcome: 'not_correction' };
  }

  const progress = getSessionProgress(dbPath, sessionId);
  if (!progress || !correctionAllowed(progress, config.minGap)) {
    return { detected: true, saved: false, outcome: 'rate_limited', matched: detection.matched };
  }

  // Scrub BEFORE the cap — secrets pasted into a correction must never persist as
  // cleartext (load-bearing per design §0.1). Scrubbing the FULL prompt first is
  // what makes the cap safe: capping the raw text could truncate a secret that
  // straddles MAX_CORRECTION_CHARS below its pattern's minimum match length, so
  // scrub would miss the fragment and a partial cleartext secret would persist
  // silently. A `[REDACTED:<kind>]` marker is short and self-contained, so capping
  // the already-scrubbed text can never strand a secret. `redactions` reflects the
  // full-prompt scrub.
  const { text: scrubbed, redactions } = scrub(promptText);
  const safeText = scrubbed.length > MAX_CORRECTION_CHARS
    ? scrubbed.slice(0, MAX_CORRECTION_CHARS)
    : scrubbed;

  writeLearningsBatch(dbPath, [
    {
      problem: safeText,
      confidence: 'high',
      importance: CORRECTION_IMPORTANCE,
      category: 'correction',
      sessionId,
      project,
    },
  ]);

  recordCorrection(dbPath, sessionId);
  return { detected: true, saved: true, outcome: 'saved', matched: detection.matched, redactions };
}

// ─── Cadence (design §3.1) ───────────────────────────────────────────────────

type CadenceCounters = Pick<SessionProgressRecord, 'turns_seen' | 'tools_seen' | 'runs_this_session'>;

/**
 * Decide whether a run should fire this window (pure).
 *
 * Fire when (turns_seen >= turnCadence OR tools_seen >= toolCadence), gated by
 * the floor (turns_seen >= minTurns) AND the budget (runs_this_session < maxRuns).
 * The OR lets either a turn-heavy or a tool-heavy window trigger; the floor keeps
 * trivial sessions silent; the budget caps total runs per session.
 */
export function shouldRun(p: CadenceCounters, c: InSessionConfig): boolean {
  const cadenceMet = p.turns_seen >= c.turnCadence || p.tools_seen >= c.toolCadence;
  const floorMet = p.turns_seen >= c.minTurns;
  const underBudget = p.runs_this_session < c.maxRuns;
  return cadenceMet && floorMet && underBudget;
}

// ─── Window slice (design §3.2) ──────────────────────────────────────────────

/** Extract plain text from a JSONL message's content blocks (string / array / object). */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = (block as { text?: string }).text;
        if (t) parts.push(t);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as { text?: string }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

/**
 * Parse a raw JSONL slice into the `[ROLE]: text` transcript format the
 * extraction prompt expects. Mirrors RecallExtract.extractMessages' filters
 * (user/assistant only, drop tool noise, truncate long messages) but operates
 * on a slice string rather than reading the whole file. Kept local per the hook
 * self-containment convention (hooks must not import from src/).
 */
function parseSliceMessages(slice: string): string {
  const messages: string[] = [];
  for (const line of slice.split('\n')) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial / corrupt line — skip
    }
    if (!entry.message?.content) continue;
    const role = entry.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textFromContent(entry.message.content);
    if (!text || text.trim().length < 10) continue;
    if (text.trim().startsWith('[{') || text.trim().startsWith('{"tool_use_id"')) continue;
    const truncated = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
    messages.push(`[${role.toUpperCase()}]: ${truncated}`);
  }
  return messages.join('\n\n');
}

export interface TranscriptSlice {
  /** Parsed `[ROLE]: text` messages from ONLY the bytes after lastOffset. */
  text: string;
  /** The new cursor: the full content length (advanced after a successful run). */
  newOffset: number;
}

/**
 * Slice the transcript to ONLY the window since lastOffset, and report the new
 * cursor. Offsets are measured in the same unit as `fullContent.length` (UTF-16
 * code units) so the slice and the cursor never drift apart. This is the v1
 * dedup: because last_offset only ever advances, windows never overlap and a
 * turn is never extracted twice within a session (the normalized-text backstop
 * is deliberately out of scope for v1).
 */
export function sliceTranscript(fullContent: string, lastOffset: number): TranscriptSlice {
  const newOffset = fullContent.length;
  if (lastOffset >= newOffset) return { text: '', newOffset };
  return { text: parseSliceMessages(fullContent.slice(lastOffset)), newOffset };
}

// ─── Parent: cheap increment + cadence decision ──────────────────────────────

export interface DecideResult {
  /** True iff a run should be spawned (cadence met, floor + budget OK). */
  run: boolean;
  /** The post-increment progress row (null when disabled — no DB touch). */
  progress: SessionProgressRecord | null;
}

/**
 * Parent path: ensure the session row, increment the right counter for this
 * event, then evaluate the cadence. Cheap (a few SQLite ops) so it runs inline
 * on every fire. When disabled this is a no-op that touches NO DB state — the
 * OFF-by-default guarantee at the logic layer (the hook's fast-path exits even
 * earlier, before this is called).
 *
 * When the cadence is met it RE-ARMS the window in the parent (resetWindow)
 * before returning run=true, and refuses to fire into a held lock
 * (parentIsLockHeld). This bounds spawns to ≤1 per cadence window. The counters
 * are reset ONLY by the child otherwise, so without the parent re-arm a held
 * lock (Stop hook TTL up to 600s) or a mid-extraction child would leave the
 * window armed and EVERY subsequent fire would spawn another doomed detached
 * child (the H1 spawn storm). The cursor (last_offset) is untouched by a window
 * reset, so the slice waits intact for the next window — no data loss.
 */
export function decideInSession(
  dbPath: string,
  sessionId: string,
  convPath: string,
  event: EventKind,
  config: InSessionConfig
): DecideResult {
  if (!config.enabled) return { run: false, progress: null };

  ensureSession(dbPath, sessionId, convPath);
  if (event === 'turn') incrementTurns(dbPath, sessionId);
  else incrementTools(dbPath, sessionId);

  const progress = getSessionProgress(dbPath, sessionId);
  if (!progress || !shouldRun(progress, config)) return { run: false, progress };

  // Cadence met — re-arm NOW so the next fire must rebuild a full cadence before
  // spawning again, regardless of whether the spawned child wins, loses
  // (lock_busy), or is still mid-extraction.
  resetWindow(dbPath, sessionId);

  // Don't spawn into a held lock: a child spawned while the Stop hook (or a live
  // child) holds the per-conversation lock would only lose the race. Skip the
  // spawn this round — the window is already re-armed, and the slice is picked
  // up by a later window once the lock clears (cursor unchanged).
  if (parentIsLockHeld(dbPath, convPath)) return { run: false, progress };

  return { run: true, progress };
}

/**
 * Derive the session id the parent keys progress on: prefer the hook-provided
 * session_id, else fall back to the transcript filename (basename minus
 * `.jsonl`). Lives here in the testable layer because the hook entry
 * (hooks/RecallInSession.ts) self-executes on import and can't be unit-imported.
 */
export function sessionIdFromArgs(sessionId: string | undefined, convPath: string): string {
  if (sessionId) return sessionId;
  return (convPath.split('/').pop() || 'unknown').replace('.jsonl', '');
}

// ─── Child: lock → slice → extract → advance ─────────────────────────────────

export interface ExtractionDeps {
  /** PID of the running process (for the per-conversation lock). */
  pid: number;
  /** Read the full transcript file, or null if missing/unreadable. */
  readTranscript: (convPath: string) => string | null;
  /** Run the extraction model over the slice (injected — runExtractionCascade in prod). */
  extract: (input: string) => Promise<string | null>;
  /** Derive topics + summary from the extracted markdown (injected). */
  deriveMeta: (extracted: string) => { topics: string[]; summary: string };
  /** Date stamp for the dual-write context (e.g. '2026-06-20'). */
  timestamp: string;
}

export type ExtractionOutcome =
  | 'extracted'
  | 'lock_busy'
  | 'no_transcript'
  | 'empty_slice'
  | 'extraction_failed'
  | 'quality_failed'
  | 'persistence_failed';

export interface ExtractionResult {
  ran: boolean;
  outcome: ExtractionOutcome;
  newOffset?: number;
  redactions?: string[];
  dualWrite?: DualWriteResult;
}

export interface ExtractionParams {
  sessionId: string;
  convPath: string;
  sessionLabel: string;
  project: string;
}

/**
 * Child path: cooperate with the Stop hook's per-conversation lock, then extract
 * ONLY the incremental window and advance the cursor on success.
 *
 * Lock cooperation: childAcquireLock issues an INSERT OR IGNORE on the same
 * extraction_locks row the Stop hook's semaphore uses (PK = conversation_path).
 * If the Stop hook (or another in-session run) already holds it, the insert
 * fails → we lose gracefully and skip this round, so an in-session run never
 * races the Stop-hook run over the same conversation (design §3.4).
 *
 * On a successful extraction the cursor advances (advanceOffset), the run is
 * counted toward the budget (incrementRuns), and the per-window counters reset
 * (resetWindow). On extraction/quality failure the cursor is NOT advanced (the
 * slice is retried in a later window — no data loss), but the window IS reset so
 * the model isn't re-hit on every subsequent fire.
 */
export async function runInSessionExtraction(
  dbPath: string,
  params: ExtractionParams,
  deps: ExtractionDeps
): Promise<ExtractionResult> {
  if (!childAcquireLock(dbPath, params.convPath, deps.pid)) {
    return { ran: false, outcome: 'lock_busy' };
  }
  try {
    const full = deps.readTranscript(params.convPath);
    if (full == null) return { ran: false, outcome: 'no_transcript' };

    const progress = getSessionProgress(dbPath, params.sessionId);
    const lastOffset = progress?.last_offset ?? 0;
    const { text, newOffset } = sliceTranscript(full, lastOffset);

    if (!text.trim()) {
      // No new conversational content in the window — advance past the bytes we
      // saw and reset so cadence doesn't immediately refire on stale counters.
      advanceOffset(dbPath, params.sessionId, newOffset);
      resetWindow(dbPath, params.sessionId);
      return { ran: false, outcome: 'empty_slice', newOffset };
    }

    const ctx: ExtractCoreContext = {
      sessionId: params.sessionId,
      sessionLabel: params.sessionLabel,
      project: params.project,
      timestamp: deps.timestamp,
      conversationPath: params.convPath,
    };

    const core = await runExtractCore(dbPath, text, ctx, {
      extract: deps.extract,
      deriveMeta: deps.deriveMeta,
    });

    if (core.outcome === 'extracted') {
      advanceOffset(dbPath, params.sessionId, newOffset);
      incrementRuns(dbPath, params.sessionId);
      resetWindow(dbPath, params.sessionId);
      return {
        ran: true,
        outcome: 'extracted',
        newOffset,
        redactions: core.redactions,
        dualWrite: core.dualWrite,
      };
    }

    // extraction_failed | quality_failed | persistence_failed — consume the window but keep the cursor
    // so the same slice (plus new content) is retried next time. No data loss.
    resetWindow(dbPath, params.sessionId);
    return { ran: false, outcome: core.outcome, dualWrite: core.dualWrite };
  } finally {
    childReleaseLock(dbPath, params.convPath, deps.pid);
  }
}
