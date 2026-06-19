// Integration tests for MCP tool workflows
//
// The MCP server (src/mcp-server.ts) cannot be imported directly because it has
// module-level side effects (DB existence check, initDb, server start). Instead,
// these tests exercise the underlying functions that each MCP tool delegates to,
// verifying the full data-access workflow end-to-end.
//
// MCP tool → underlying function(s) mapping:
//   memory_search  → search()
//   memory_add     → addDecision() | addLearning() | addBreadcrumb()
//   memory_recall  → recentLoaEntries() | recentDecisions() | recentBreadcrumbs()
//   memory_stats   → getStats()
//   loa_show       → getLoaEntry()

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb, teardownTestDb } from './helpers/setup';
import {
  search,
  addDecision,
  addLearning,
  addBreadcrumb,
  recentLoaEntries,
  recentDecisions,
  recentBreadcrumbs,
  getStats,
  getLoaEntry,
  getDecision,
  getLearning,
  getBreadcrumb,
  createLoaEntry,
  createSession,
  addMessage,
  vectorRowContentProvenance,
} from '../src/lib/memory';
import {
  shouldFallbackToHybrid,
  buildHybridFallbackOutcome,
  formatHybridResults,
  type HybridSearchResult,
} from '../src/lib/search-fallback';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a unique ISO timestamp string so repeated inserts don't collide. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Creates a throw-away session and returns its session_id string. */
function makeSession(suffix: string = ''): string {
  const sessionId = `test-session-${Date.now()}${suffix}`;
  createSession({
    session_id: sessionId,
    started_at: nowIso(),
    project: 'test-project',
  });
  return sessionId;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// ---------------------------------------------------------------------------
// memory_search workflow
// ---------------------------------------------------------------------------

describe('memory_search workflow', () => {
  test('search("kubernetes") returns a decision that contains the word', () => {
    const sessionId = makeSession('-search-1');

    addDecision({
      session_id: sessionId,
      decision: 'Use kubernetes for container orchestration in production',
      reasoning: 'Needed multi-node scheduling and self-healing capabilities',
      status: 'active',
      project: 'test-project',
    });

    const results = search('kubernetes');

    expect(results.length).toBeGreaterThan(0);

    const match = results.find(
      (r) => r.table === 'decisions' && r.content.toLowerCase().includes('kubernetes'),
    );
    expect(match).toBeDefined();
    expect(match!.table).toBe('decisions');
  });

  test('search with a non-existent term returns an empty array', () => {
    const results = search('zzznomatchxxx99999');
    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// memory_add workflow
// ---------------------------------------------------------------------------

describe('memory_add workflow', () => {
  test('addDecision creates a record retrievable by getDecision', () => {
    const sessionId = makeSession('-add-decision');

    const id = addDecision({
      session_id: sessionId,
      category: 'architecture',
      project: 'test-project',
      decision: 'Adopt hexagonal architecture for the core domain',
      reasoning: 'Improves testability and decouples infrastructure concerns',
      alternatives: 'Layered architecture, Clean architecture',
      status: 'active',
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    // Simulate what the MCP tool does after addDecision — retrieve and inspect
    const record = getDecision(id);

    expect(record).toBeDefined();
    expect(record!.id).toBe(id);
    expect(record!.decision).toBe('Adopt hexagonal architecture for the core domain');
    expect(record!.category).toBe('architecture');
    expect(record!.reasoning).toBe('Improves testability and decouples infrastructure concerns');
    expect(record!.alternatives).toBe('Layered architecture, Clean architecture');
    expect(record!.status).toBe('active');
    expect(record!.project).toBe('test-project');
  });

  test('addLearning creates a record with problem and solution', () => {
    const sessionId = makeSession('-add-learning');

    const id = addLearning({
      session_id: sessionId,
      category: 'debugging',
      project: 'test-project',
      problem: 'SQLite WAL mode causes lock contention under high concurrency',
      solution: 'Switch to journal_mode=DELETE for single-writer workloads',
      prevention: 'Benchmark concurrency requirements before choosing WAL mode',
      tags: 'sqlite,performance,locking',
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const record = getLearning(id);

    expect(record).toBeDefined();
    expect(record!.id).toBe(id);
    expect(record!.problem).toBe('SQLite WAL mode causes lock contention under high concurrency');
    expect(record!.solution).toBe('Switch to journal_mode=DELETE for single-writer workloads');
    expect(record!.prevention).toBe('Benchmark concurrency requirements before choosing WAL mode');
    expect(record!.tags).toBe('sqlite,performance,locking');
    expect(record!.category).toBe('debugging');
  });

  test('addBreadcrumb creates a record with content and importance', () => {
    const sessionId = makeSession('-add-breadcrumb');

    const id = addBreadcrumb({
      session_id: sessionId,
      content: 'Refactoring the embeddings pipeline — do not merge feature/embed-v2 yet',
      category: 'in-progress',
      project: 'test-project',
      importance: 8,
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const record = getBreadcrumb(id);

    expect(record).toBeDefined();
    expect(record!.id).toBe(id);
    expect(record!.content).toBe(
      'Refactoring the embeddings pipeline — do not merge feature/embed-v2 yet',
    );
    expect(record!.category).toBe('in-progress');
    expect(record!.importance).toBe(8);
    expect(record!.project).toBe('test-project');
  });
});

// ---------------------------------------------------------------------------
// memory_recall workflow
// ---------------------------------------------------------------------------

describe('memory_recall workflow', () => {
  test('recentDecisions returns decisions that were added', () => {
    const sessionId = makeSession('-recall-decisions');

    addDecision({
      session_id: sessionId,
      decision: 'Store embeddings in pgvector rather than a flat file',
      status: 'active',
      project: 'recall-test-project',
    });

    addDecision({
      session_id: sessionId,
      decision: 'Use Bun as the primary runtime for all CLI tooling',
      status: 'active',
      project: 'recall-test-project',
    });

    const decisions = recentDecisions(10, 'recall-test-project');

    expect(decisions.length).toBeGreaterThanOrEqual(2);

    const texts = decisions.map((d) => d.decision);
    expect(texts).toContain('Store embeddings in pgvector rather than a flat file');
    expect(texts).toContain('Use Bun as the primary runtime for all CLI tooling');
  });

  test('recentBreadcrumbs returns breadcrumbs that were added', () => {
    const sessionId = makeSession('-recall-breadcrumbs');

    addBreadcrumb({
      session_id: sessionId,
      content: 'Migration script is halfway done — resume from step 4',
      importance: 7,
      project: 'recall-crumbs-project',
    });

    addBreadcrumb({
      session_id: sessionId,
      content: 'Auth tokens expire in 15 minutes; refresh logic not yet wired up',
      importance: 9,
      project: 'recall-crumbs-project',
    });

    const breadcrumbs = recentBreadcrumbs(10, 'recall-crumbs-project');

    expect(breadcrumbs.length).toBeGreaterThanOrEqual(2);

    const contents = breadcrumbs.map((b) => b.content);
    expect(contents).toContain('Migration script is halfway done — resume from step 4');
    expect(contents).toContain('Auth tokens expire in 15 minutes; refresh logic not yet wired up');
  });

  test('recentLoaEntries returns LOA entries that were added', () => {
    const sessionId = makeSession('-recall-loa');

    createLoaEntry({
      title: 'Session summary: API redesign',
      fabric_extract: 'Discussed REST vs GraphQL tradeoffs and settled on REST for v1.',
      session_id: sessionId,
      project: 'recall-loa-project',
    });

    const entries = recentLoaEntries(10, 'recall-loa-project');

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].title).toBe('Session summary: API redesign');
    expect(entries[0].project).toBe('recall-loa-project');
  });
});

// ---------------------------------------------------------------------------
// memory_stats workflow
// ---------------------------------------------------------------------------

describe('memory_stats workflow', () => {
  test('getStats reflects counts after adding records', () => {
    // Capture baseline counts before adding anything in this sub-test
    const before = getStats();

    const sessionId = makeSession('-stats');

    addDecision({
      session_id: sessionId,
      decision: 'Enable strict TypeScript checks project-wide',
      status: 'active',
    });

    addLearning({
      session_id: sessionId,
      problem: 'Missing return type annotations caused subtle runtime errors',
      solution: 'Enable noImplicitReturns and strictNullChecks in tsconfig',
    });

    addBreadcrumb({
      session_id: sessionId,
      content: 'Type-check pass is still in progress',
      importance: 5,
    });

    createLoaEntry({
      title: 'TypeScript strict mode adoption',
      fabric_extract: 'Enabled strict mode; found 47 type errors that needed fixing.',
      session_id: sessionId,
    });

    const after = getStats();

    expect(after.decisions).toBe(before.decisions + 1);
    expect(after.learnings).toBe(before.learnings + 1);
    expect(after.breadcrumbs).toBe(before.breadcrumbs + 1);
    expect(after.loa_entries).toBe(before.loa_entries + 1);
    // DB file must have a positive size once records are written
    expect(after.db_size_bytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loa_show workflow
// ---------------------------------------------------------------------------

describe('loa_show workflow', () => {
  test('createLoaEntry then getLoaEntry returns the full entry including fabric_extract', () => {
    const sessionId = makeSession('-loa-show');
    const fabricText =
      'The team evaluated three caching strategies. Redis was chosen for its pub/sub ' +
      'support and TTL semantics. Memcached was ruled out due to lack of persistence. ' +
      'In-process caching was dismissed because of its inability to share state across pods.';

    const id = createLoaEntry({
      title: 'Caching strategy decision',
      description: 'Comparison of Redis, Memcached, and in-process caching',
      fabric_extract: fabricText,
      session_id: sessionId,
      project: 'loa-show-project',
      tags: 'caching,redis,architecture',
      message_count: 32,
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    // Simulate what loa_show does: call getLoaEntry with the id
    const entry = getLoaEntry(id);

    expect(entry).toBeDefined();
    expect(entry!.id).toBe(id);
    expect(entry!.title).toBe('Caching strategy decision');
    expect(entry!.description).toBe('Comparison of Redis, Memcached, and in-process caching');
    expect(entry!.fabric_extract).toBe(fabricText);
    expect(entry!.session_id).toBe(sessionId);
    expect(entry!.project).toBe('loa-show-project');
    expect(entry!.tags).toBe('caching,redis,architecture');
    expect(entry!.message_count).toBe(32);
    expect(entry!.created_at).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// hybrid vector-branch provenance (issue #67)
//
// memory_hybrid_search → hybridSearch() in mcp-server.ts resolves content +
// provenance for vector-only matches via vectorRowContentProvenance(). The
// learnings case used to be missing, so a vector-only learnings match
// reported its provenance as unknown. mcp-server.ts cannot be imported (it
// starts a server on load), so we test the delegate the vec-branch calls.
// ---------------------------------------------------------------------------

describe('hybrid vector-branch provenance (issue #67)', () => {
  test('vectorRowContentProvenance reports a learnings match real provenance, not unknown', () => {
    const sessionId = makeSession('-vec-learning');
    const id = addLearning({
      session_id: sessionId,
      problem: 'Vector-only learnings matches dropped their provenance in hybrid search',
      solution: 'Add the learnings branch to the hybrid vec-branch row fetch',
      provenance: 'user_authored',
      project: 'test-project',
    });

    const { content, provenance } = vectorRowContentProvenance('learnings', id);

    // The bug: this came back null ("unknown") because learnings had no branch.
    expect(provenance).toBe('user_authored');
    expect(content).toContain('Vector-only learnings matches dropped their provenance');
  });

  test('vectorRowContentProvenance still resolves the other embedded tables', () => {
    const sessionId = makeSession('-vec-decision');
    const id = addDecision({
      session_id: sessionId,
      decision: 'Centralize the hybrid vec-branch row fetch in one helper',
      provenance: 'extracted',
      status: 'active',
      project: 'test-project',
    });

    const dec = vectorRowContentProvenance('decisions', id);
    expect(dec.provenance).toBe('extracted');
    expect(dec.content).toBe('Centralize the hybrid vec-branch row fetch in one helper');

    // Issue #91: the loa_entries and messages branches were a proven code-move
    // in #90 but unguarded — a regression would silently report their
    // provenance as unknown. Pin both: title+extract content for loa, truncated
    // content for messages, each carrying its real provenance.
    const loaId = createLoaEntry({
      title: 'Hybrid vec-branch provenance',
      fabric_extract: 'Resolved content and provenance for vector-only LoA matches.',
      provenance: 'user_authored',
      session_id: sessionId,
      project: 'test-project',
    });
    const loa = vectorRowContentProvenance('loa_entries', loaId);
    expect(loa.provenance).toBe('user_authored');
    expect(loa.content).toContain('Hybrid vec-branch provenance');
    expect(loa.content).toContain('Resolved content and provenance for vector-only LoA matches.');

    const msgId = addMessage({
      session_id: sessionId,
      timestamp: nowIso(),
      role: 'assistant',
      content: 'Vector-only message matches must keep their real provenance.',
      provenance: 'verbatim',
      project: 'test-project',
    });
    const msg = vectorRowContentProvenance('messages', msgId);
    expect(msg.provenance).toBe('verbatim');
    expect(msg.content).toContain('Vector-only message matches must keep their real provenance.');

    // Issue #119: breadcrumbs is now a covered table (the FTS side can fuse a
    // breadcrumb into the hybrid result set), carrying its real provenance.
    const crumbId = addBreadcrumb({
      session_id: sessionId,
      content: 'Vector-fused breadcrumb keeps its real provenance.',
      provenance: 'user_authored',
      importance: 5,
      project: 'test-project',
    });
    const crumb = vectorRowContentProvenance('breadcrumbs', crumbId);
    expect(crumb.provenance).toBe('user_authored');
    expect(crumb.content).toContain('Vector-fused breadcrumb keeps its real provenance.');

    // An unrecognized table falls through to empty content, null provenance.
    const unknown = vectorRowContentProvenance('not_a_table', id);
    expect(unknown.content).toBe('');
    expect(unknown.provenance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// memory_search → hybrid/semantic fallback (issue #39)
//
// On a GLOBAL zero-keyword-hit query, the memory_search handler retries via
// hybridSearch and surfaces semantic matches; a table-filtered query respects
// the narrowing and returns the honest empty result. mcp-server.ts cannot be
// imported (it starts a server on load), so we test the delegates the handler
// calls — shouldFallbackToHybrid (the decision) and buildHybridFallbackOutcome
// (the labeled response + the single honest metrics line).
// ---------------------------------------------------------------------------

describe('memory_search hybrid fallback (issue #39)', () => {
  const sample: HybridSearchResult = {
    table: 'decisions',
    id: 42,
    content: 'We standardized on bun over npm for all Recall tooling',
    score: 0.83,
    source: 'vec',
    provenance: 'user_authored',
  };

  test('a global zero-result query falls back; keyword hits and table filters do not', () => {
    // Global (no table) + zero keyword hits → fall back to hybrid/semantic.
    expect(shouldFallbackToHybrid(0, undefined)).toBe(true);

    // A hard `table` filter narrows scope on purpose → no fallback.
    expect(shouldFallbackToHybrid(0, 'decisions')).toBe(false);

    // Keyword hits exist → no fallback regardless of table.
    expect(shouldFallbackToHybrid(3, undefined)).toBe(false);
  });

  test('a global query with no verbatim match surfaces hybrid hits with a clear label', () => {
    const outcome = buildHybridFallbackOutcome('which package manager', [sample]);

    expect(outcome.text).toContain('No exact keyword hits for "which package manager"; showing semantic matches:');
    // Reuses the memory_hybrid_search display shape: score% [TAG] [table#id] | provenance.
    expect(outcome.text).toContain('83.0% [VEC] [decisions#42] | provenance: user_authored');
    expect(outcome.text).toContain('We standardized on bun over npm');

    // Metrics: one honest log line, attributed to the fallback path.
    expect(outcome.logTool).toBe('memory_search:hybrid-fallback');
    expect(outcome.logCount).toBe(1);
  });

  test('when hybrid also returns nothing (e.g. embeddings unavailable) the result is honestly empty', () => {
    const outcome = buildHybridFallbackOutcome('which package manager', []);

    // Do NOT claim semantic matches that don't exist.
    expect(outcome.text).toBe('No results found for: "which package manager"');
    expect(outcome.text).not.toContain('semantic matches');
    expect(outcome.logTool).toBe('memory_search:hybrid-fallback');
    expect(outcome.logCount).toBe(0);
  });

  test('formatHybridResults matches the memory_hybrid_search display shape', () => {
    const formatted = formatHybridResults([
      sample,
      { ...sample, id: 7, source: 'both', provenance: null, content: 'x'.repeat(250) },
    ]);

    expect(formatted).toContain('83.0% [VEC] [decisions#42] | provenance: user_authored');
    // NULL provenance reports as "unknown", never guessed (ADR-0001).
    expect(formatted).toContain('[FTS+VEC] [decisions#7] | provenance: unknown');
    // Long content is truncated to a 200-char preview with an ellipsis.
    expect(formatted).toContain('x'.repeat(200) + '...');
    // Result blocks are separated by the shared divider.
    expect(formatted).toContain('\n\n---\n\n');
  });
});
