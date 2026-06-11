// Suite C internals — deterministic fixture corpus, ground-truth query set,
// and retrieval metric helpers.
//
// Unlike Suite B (which measures the user's real DB read-only), Suite C builds
// a synthetic corpus in a temporary DB and exercises the REAL write and search
// paths from src/ — initDb() creates the production schema (FTS triggers
// included), records are inserted through src/lib/memory.ts, and queries run
// through search(). Measuring a reimplementation of search would measure a
// strawman; the point is to benchmark the code users actually run.
//
// Everything here is seeded and deterministic: the same (seed, size) pair
// always produces byte-identical record content and the same query set, so
// runs are comparable across machines and over time.

import {
  createSession,
  addDecision,
  addLearning,
  addBreadcrumb,
  addMessagesBatch,
  createLoaEntry,
} from '../../src/lib/memory.js';
import { getDb } from '../../src/db/connection.js';
import type { Message, Provenance } from '../../src/types/index.js';

/** Retrieval cutoff — all metrics are @5 (P@5, R@5, MRR@5). */
export const K = 5;

/** Default seed. 47 = the tracking issue number; any fixed value works. */
export const DEFAULT_SEED = 47;

// ── Seeded PRNG ──────────────────────────────────────────────────────
// mulberry32 — tiny, well-distributed, deterministic across platforms.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Fixture types ────────────────────────────────────────────────────

export type FixtureTable = 'decisions' | 'learnings' | 'breadcrumbs' | 'loa_entries' | 'messages';

export type FixtureRole = 'target' | 'near_duplicate' | 'entity_collision' | 'low_signal';

export interface FixtureRecord {
  /** Stable key — ground-truth queries reference target keys. */
  key: string;
  table: FixtureTable;
  project: string;
  provenance: Provenance;
  /** Primary text (decision / problem / content / LoA title). */
  text: string;
  /** Secondary text (reasoning / solution / LoA fabric_extract). */
  detail?: string;
  importance: number;
  /** Decisions/learnings only — search() orders decisions by confidence before rank. */
  confidence?: 'high' | 'medium' | 'low';
  role: FixtureRole;
}

export type QueryCategory = 'exact_lookup' | 'paraphrase' | 'problem_lookup' | 'ambiguous';

export interface FixtureQuery {
  id: string;
  text: string;
  category: QueryCategory;
  /** Optional project filter passed to search(), mirroring scoped lookups. */
  project?: string;
  /** Keys of target records that are relevant to this query (ground truth). */
  expected: string[];
  /** Ambiguous queries only — labels the collision so failures can be attributed. */
  collision?: { kind: 'name' | 'project' | 'topic'; note: string };
}

export interface FixtureSpec {
  seed: number;
  size: number;
  records: FixtureRecord[];
  queries: FixtureQuery[];
}

export interface SeededRecord {
  key: string;
  table: FixtureTable;
  id: number;
  project: string;
  provenance: Provenance;
}

// ── Ground-truth targets ─────────────────────────────────────────────
// Fixed records present at EVERY corpus size, so every query has answers and
// scores are comparable across sizes. Entity names are invented (ZephyrQueue,
// GlacierStore, HeliosParser, Atlas) so real-world content can't collide.
// Confidence stays 'medium' on decision targets — search() ranks decisions by
// confidence before FTS rank, and inflating our own targets would flatter the
// baseline.

const PROJECT_PHOENIX = 'phoenix-api';
const PROJECT_ATLAS = 'atlas-web';
const PROJECT_NIMBUS = 'nimbus-cli';

const TARGETS: FixtureRecord[] = [
  {
    key: 't_zephyr_backoff',
    table: 'decisions',
    project: PROJECT_PHOENIX,
    provenance: 'user_authored',
    text: 'Use exponential backoff with jitter for ZephyrQueue retry handling',
    detail: 'Fixed-interval retries hammered the broker during outages; jitter spreads the reconnect storm.',
    importance: 7,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_glacier_compaction',
    table: 'decisions',
    project: PROJECT_NIMBUS,
    provenance: 'extracted',
    text: 'Schedule GlacierStore compaction nightly at 03:00 UTC',
    detail: 'Daytime compaction competed with interactive workloads for disk I/O.',
    importance: 6,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_wal_journaling',
    table: 'decisions',
    project: PROJECT_PHOENIX,
    provenance: 'user_authored',
    text: 'Adopt SQLite WAL journal mode for the persistence layer',
    detail: 'Allows concurrent readers while a single writer appends; the rollback journal blocked readers during writes.',
    importance: 7,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_atlas_phoenix',
    table: 'decisions',
    project: PROJECT_PHOENIX,
    provenance: 'extracted',
    text: 'Deploy Atlas gateway to the edge POPs before regional rollout',
    detail: 'Atlas at the edge cuts p95 latency for auth handshakes.',
    importance: 6,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_atlas_web',
    table: 'decisions',
    project: PROJECT_ATLAS,
    provenance: 'user_authored',
    text: 'Rename the Atlas design tokens package to atlas-tokens',
    detail: 'The old package name collided with the Atlas gateway component.',
    importance: 5,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_sqlite_busy',
    table: 'learnings',
    project: PROJECT_PHOENIX,
    provenance: 'extracted',
    text: 'SQLITE_BUSY errors under concurrent WAL writers in bun:sqlite',
    detail: 'Serialize writes through a single connection; WAL allows many readers but only one writer.',
    importance: 7,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_orphan_worktree',
    table: 'learnings',
    project: PROJECT_NIMBUS,
    provenance: 'extracted',
    text: 'Orphaned git worktree branches accumulate after subagent merges',
    detail: 'Delete the per-agent branch right after merging; lowercase -d refuses unmerged deletes.',
    importance: 6,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_timeout_ingest',
    table: 'learnings',
    project: PROJECT_PHOENIX,
    provenance: 'derived',
    text: 'Ingest pipeline timeout when the embedding service is cold',
    detail: 'Warm the embedding service at startup and fail open to keyword search.',
    importance: 6,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_timeout_ui',
    table: 'learnings',
    project: PROJECT_ATLAS,
    provenance: 'extracted',
    text: 'Modal dismiss timeout races the navigation transition',
    detail: 'Await the transition promise before starting the dismiss timer.',
    importance: 5,
    confidence: 'medium',
    role: 'target',
  },
  {
    key: 't_helios_tokenizer',
    table: 'loa_entries',
    project: PROJECT_PHOENIX,
    provenance: 'verbatim',
    text: 'HeliosParser streaming tokenizer design',
    detail:
      'HeliosParser tokenizes input incrementally so multi-megabyte payloads never buffer fully in memory. The lookahead window is bounded at 4KB and backpressure propagates to the source stream.',
    importance: 8,
    role: 'target',
  },
  {
    key: 't_loa_retro',
    table: 'loa_entries',
    project: PROJECT_ATLAS,
    provenance: 'extracted',
    text: 'Q2 atlas-web performance retro',
    detail:
      'Bundle splitting halved initial load time. The Atlas tokens rename unblocked the design system release train.',
    importance: 8,
    role: 'target',
  },
  {
    key: 't_breadcrumb_release',
    table: 'breadcrumbs',
    project: PROJECT_NIMBUS,
    provenance: 'verbatim',
    text: 'Release 0.9.3 tagged; GlacierStore migration gate passed on staging',
    importance: 6,
    role: 'target',
  },
];

// ── Ground-truth query set ───────────────────────────────────────────
// Four categories per the issue spec. Query texts avoid FTS5 syntax
// characters (quotes, colons, parens) — they go into MATCH verbatim, exactly
// as search() receives them from callers.

const QUERIES: FixtureQuery[] = [
  // Exact project/name lookups — entity name + topic terms, sometimes scoped.
  {
    id: 'q_exact_zephyr',
    text: 'ZephyrQueue retry backoff',
    category: 'exact_lookup',
    project: PROJECT_PHOENIX,
    expected: ['t_zephyr_backoff'],
  },
  {
    id: 'q_exact_glacier',
    text: 'GlacierStore compaction',
    category: 'exact_lookup',
    project: PROJECT_NIMBUS,
    expected: ['t_glacier_compaction'],
  },
  {
    id: 'q_exact_helios',
    text: 'HeliosParser tokenizer',
    category: 'exact_lookup',
    expected: ['t_helios_tokenizer'],
  },
  {
    id: 'q_exact_release',
    text: 'GlacierStore migration gate',
    category: 'exact_lookup',
    project: PROJECT_NIMBUS,
    expected: ['t_breadcrumb_release'],
  },
  // Paraphrased decision lookups — reworded intent. FTS5 MATCH is implicit
  // AND with no stemming, so some of these are EXPECTED to miss on keyword
  // search. That gap is part of the baseline this suite records.
  {
    id: 'q_para_wal',
    text: 'journal mode concurrent readers',
    category: 'paraphrase',
    expected: ['t_wal_journaling'],
  },
  {
    id: 'q_para_retry',
    text: 'spread reconnect attempts after broker outages',
    category: 'paraphrase',
    expected: ['t_zephyr_backoff'],
  },
  {
    id: 'q_para_compact',
    text: 'when to run storage compaction',
    category: 'paraphrase',
    expected: ['t_glacier_compaction'],
  },
  // Learning/problem lookups — phrased the way an agent reports a failure.
  {
    id: 'q_prob_busy',
    text: 'SQLITE_BUSY concurrent writers',
    category: 'problem_lookup',
    expected: ['t_sqlite_busy'],
  },
  {
    id: 'q_prob_worktree',
    text: 'orphaned worktree branches',
    category: 'problem_lookup',
    expected: ['t_orphan_worktree'],
  },
  {
    id: 'q_prob_cold',
    text: 'embedding service cold timeout',
    category: 'problem_lookup',
    expected: ['t_timeout_ingest'],
  },
  // Noisy ambiguous queries — labeled collisions so failures can be
  // attributed to entity/name ambiguity vs generic ranking noise.
  {
    id: 'q_amb_atlas_name',
    text: 'Atlas',
    category: 'ambiguous',
    expected: ['t_atlas_phoenix', 't_atlas_web', 't_loa_retro'],
    collision: {
      kind: 'name',
      note: 'Atlas is both a gateway (phoenix-api) and a design-tokens package (atlas-web); the atlas-web PROJECT name also matches the term because project is an indexed FTS column, and collision noise mentions Atlas in unrelated content.',
    },
  },
  {
    id: 'q_amb_atlas_scoped',
    text: 'Atlas gateway edge',
    category: 'ambiguous',
    project: PROJECT_PHOENIX,
    expected: ['t_atlas_phoenix'],
    collision: {
      kind: 'name',
      note: 'Same Atlas name collision, disambiguated by a project filter plus topic terms.',
    },
  },
  {
    id: 'q_amb_timeout',
    text: 'timeout',
    category: 'ambiguous',
    expected: ['t_timeout_ingest', 't_timeout_ui'],
    collision: {
      kind: 'topic',
      note: 'Two unrelated timeout learnings (ingest pipeline vs UI modal) plus collision noise mentioning timeouts.',
    },
  },
  {
    id: 'q_amb_timeout_scoped',
    text: 'timeout',
    category: 'ambiguous',
    project: PROJECT_ATLAS,
    expected: ['t_timeout_ui'],
    collision: {
      kind: 'project',
      note: 'Same bare term as q_amb_timeout; the project filter is the only disambiguator.',
    },
  },
];

// ── Noise generation ─────────────────────────────────────────────────
// Three noise roles:
//   near_duplicate   — deterministic variants of target text. They compete
//                      directly with targets in ranking but are NOT labeled
//                      relevant: surfacing the variant instead of the record
//                      the query asks about is a precision failure.
//   entity_collision — target entity names embedded in unrelated content.
//   low_signal       — generic filler an extraction pipeline accumulates.

const NOISE_PROJECTS = [PROJECT_PHOENIX, PROJECT_ATLAS, PROJECT_NIMBUS, 'quartz-docs', 'ember-infra'];

const ENTITY_NAMES = ['Atlas', 'ZephyrQueue', 'GlacierStore', 'HeliosParser', 'timeout', 'compaction'];

const COLLISION_TEMPLATES = [
  'Filed a ticket about ENTITY color contrast on the marketing splash page',
  'Renamed the ENTITY spreadsheet tab in the quarterly planning doc',
  'Standup note - ENTITY demo moved to Thursday',
  'Asked design for new ENTITY stickers for the offsite',
  'The ENTITY conference talk recording is up on the wiki',
];

const LOW_SIGNAL_SUBJECTS = [
  'build pipeline', 'cache layer', 'release notes', 'standup notes',
  'dependency bump', 'flaky test', 'lint warning', 'onboarding doc',
  'dashboard widget', 'feature flag', 'log rotation', 'pager schedule',
];

const LOW_SIGNAL_VERBS = ['Investigated', 'Reviewed', 'Skimmed', 'Touched', 'Noted', 'Parked'];

const LOW_SIGNAL_OUTCOMES = [
  'no conclusion', 'follow-up later', 'seems fine', 'needs owner', 'low priority', 'waiting on infra',
];

const NEAR_DUP_SUFFIXES = [
  'revisited after incident review',
  'as discussed in the planning sync',
  'pending final sign-off',
  'copied from the old tracker',
  'second occurrence this quarter',
];

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length)];
}

function pickWeighted<T extends string>(rng: () => number, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  let roll = rng();
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

const NOISE_TABLE_WEIGHTS: Record<FixtureTable, number> = {
  messages: 0.4,
  breadcrumbs: 0.25,
  decisions: 0.15,
  learnings: 0.15,
  loa_entries: 0.05,
};

const NOISE_ROLE_WEIGHTS: Record<Exclude<FixtureRole, 'target'>, number> = {
  low_signal: 0.7,
  entity_collision: 0.2,
  near_duplicate: 0.1,
};

const NOISE_PROVENANCE_WEIGHTS: Record<Provenance, number> = {
  extracted: 0.6,
  derived: 0.2,
  verbatim: 0.1,
  user_authored: 0.1,
};

function makeNoiseRecord(rng: () => number, index: number): FixtureRecord {
  const table = pickWeighted(rng, NOISE_TABLE_WEIGHTS);
  const role = pickWeighted(rng, NOISE_ROLE_WEIGHTS);
  const provenance = pickWeighted(rng, NOISE_PROVENANCE_WEIGHTS);
  const project = pick(rng, NOISE_PROJECTS);
  const importance = 2 + Math.floor(rng() * 6); // 2..7

  let text: string;
  let detail: string | undefined;

  if (role === 'near_duplicate') {
    const target = TARGETS[Math.floor(rng() * TARGETS.length)];
    text = `${target.text} - ${pick(rng, NEAR_DUP_SUFFIXES)}`;
    detail = target.detail;
  } else if (role === 'entity_collision') {
    const entity = pick(rng, ENTITY_NAMES);
    text = `${pick(rng, COLLISION_TEMPLATES).replace('ENTITY', entity)} (n${index})`;
  } else {
    text = `${pick(rng, LOW_SIGNAL_VERBS)} ${pick(rng, LOW_SIGNAL_SUBJECTS)} drift; ${pick(rng, LOW_SIGNAL_OUTCOMES)} (n${index})`;
  }

  const record: FixtureRecord = {
    key: `noise_${index}`,
    table,
    project,
    provenance,
    text,
    detail,
    importance,
    role,
  };

  if (table === 'decisions' || table === 'learnings') {
    const roll = rng();
    record.confidence = roll < 0.15 ? 'high' : roll < 0.85 ? 'medium' : 'low';
  }

  return record;
}

/**
 * Build the full deterministic fixture spec for one corpus size.
 *
 * Targets are constant across sizes; noise fills the remainder. Records are
 * shuffled (seeded Fisher-Yates) so target rows scatter through the ID space
 * instead of clustering at the start.
 */
export function generateFixtureSpec(seed: number, size: number): FixtureSpec {
  if (size < TARGETS.length + QUERIES.length) {
    throw new Error(`Suite C corpus size must be at least ${TARGETS.length + QUERIES.length}, got ${size}`);
  }
  const rng = mulberry32(seed);

  const records: FixtureRecord[] = [...TARGETS];
  const noiseCount = size - TARGETS.length;
  for (let i = 0; i < noiseCount; i++) {
    records.push(makeNoiseRecord(rng, i));
  }

  // Seeded Fisher-Yates shuffle.
  for (let i = records.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [records[i], records[j]] = [records[j], records[i]];
  }

  return { seed, size, records, queries: QUERIES };
}

// ── Seeding ──────────────────────────────────────────────────────────

const FIXTURE_SESSION_ID = 'suite-c-fixture';
const SEED_EPOCH_MS = Date.UTC(2026, 0, 1); // fixed epoch — deterministic timestamps

/**
 * Insert a fixture spec into the CURRENT database (RECALL_DB_PATH must already
 * point at an initDb()-initialized fixture DB). Uses the real write paths so
 * FTS triggers populate exactly as they do in production.
 *
 * Returns target key → seeded row reference for ground-truth resolution.
 */
export function seedFixture(spec: FixtureSpec): Map<string, SeededRecord> {
  const db = getDb();
  const targets = new Map<string, SeededRecord>();

  createSession({
    session_id: FIXTURE_SESSION_ID,
    started_at: new Date(SEED_EPOCH_MS).toISOString(),
    project: PROJECT_PHOENIX,
    source: 'suite-c-benchmark',
  });

  const messages: Array<Omit<Message, 'id'>> = [];
  const structured = spec.records.filter((r) => {
    if (r.table !== 'messages') return true;
    messages.push({
      session_id: FIXTURE_SESSION_ID,
      timestamp: new Date(SEED_EPOCH_MS + messages.length * 60_000).toISOString(),
      role: messages.length % 2 === 0 ? 'user' : 'assistant',
      content: r.text,
      project: r.project,
      importance: r.importance,
      provenance: r.provenance,
    });
    return false;
  });

  // Structured tables in one transaction — 100k single inserts without one
  // would pay a COMMIT per row and take minutes.
  const insertStructured = db.transaction(() => {
    for (const r of structured) {
      let id: number;
      switch (r.table) {
        case 'decisions':
          id = addDecision({
            decision: r.text,
            reasoning: r.detail,
            project: r.project,
            status: 'active',
            confidence: r.confidence ?? 'medium',
            importance: r.importance,
            provenance: r.provenance,
          });
          break;
        case 'learnings':
          id = addLearning({
            problem: r.text,
            solution: r.detail,
            project: r.project,
            confidence: r.confidence ?? 'medium',
            importance: r.importance,
            provenance: r.provenance,
          });
          break;
        case 'breadcrumbs':
          id = addBreadcrumb({
            content: r.text,
            project: r.project,
            importance: r.importance,
            provenance: r.provenance,
          });
          break;
        case 'loa_entries':
          id = createLoaEntry({
            title: r.text,
            description: r.detail ? r.detail.slice(0, 120) : undefined,
            fabric_extract: r.detail ?? r.text,
            project: r.project,
            importance: r.importance,
            provenance: r.provenance,
          });
          break;
        default:
          continue;
      }
      if (r.role === 'target') {
        targets.set(r.key, { key: r.key, table: r.table, id, project: r.project, provenance: r.provenance });
      }
    }
  });
  insertStructured();

  if (messages.length > 0) {
    addMessagesBatch(messages); // manages its own transaction
  }

  return targets;
}

// ── Metrics ──────────────────────────────────────────────────────────
// Pure functions over (retrieved, relevant) so they are trivially testable.
// Relevance keys are `${table}#${id}` — the same identity search() returns.

export interface RetrievedRef {
  table: string;
  id: number;
}

export function refKey(table: string, id: number): string {
  return `${table}#${id}`;
}

/**
 * search() reports loa_entries rows under the logical table name 'loa'
 * (see SEARCH_TABLES in src/lib/memory.ts). Ground-truth records carry the
 * physical table name — map it before comparing identities.
 */
export function searchTableName(table: FixtureTable): string {
  return table === 'loa_entries' ? 'loa' : table;
}

/** Fraction of the top-k that is relevant. Standard P@k: divisor is k. */
export function precisionAtK(retrieved: RetrievedRef[], relevant: Set<string>, k: number): number {
  if (k <= 0) return 0;
  const hits = retrieved.slice(0, k).filter((r) => relevant.has(refKey(r.table, r.id))).length;
  return hits / k;
}

/** Fraction of all relevant records that appear in the top-k. */
export function recallAtK(retrieved: RetrievedRef[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = retrieved.slice(0, k);
  let hits = 0;
  for (const key of relevant) {
    if (top.some((r) => refKey(r.table, r.id) === key)) hits++;
  }
  return hits / relevant.size;
}

/** 1/rank of the first relevant result within the top-k; 0 if none. */
export function reciprocalRank(retrieved: RetrievedRef[], relevant: Set<string>, k: number): number {
  const top = retrieved.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    if (relevant.has(refKey(top[i].table, top[i].id))) return 1 / (i + 1);
  }
  return 0;
}

/** Nearest-rank percentile (p in 0..100) over an unsorted sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
