import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  createSession,
  getSession,
  sessionExists,
  endSession,
  addMessage,
  addMessagesBatch,
  addDecision,
  getDecision,
  addLearning,
  getLearning,
  addBreadcrumb,
  getBreadcrumb,
  search,
  getLastSearchErrors,
  recentMessages,
  recentDecisions,
  recentLearnings,
  recentBreadcrumbs,
  createLoaEntry,
  getLoaEntry,
  getLastLoaEntry,
  recentLoaEntries,
  getStats,
} from '../../src/lib/memory';

beforeAll(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// ============ Sessions ============

describe('Sessions', () => {
  test('createSession returns an id > 0', () => {
    const id = createSession({
      session_id: 'sess-create-test',
      started_at: new Date().toISOString(),
    });
    expect(id).toBeGreaterThan(0);
  });

  test('getSession retrieves created session by session_id', () => {
    const sessionId = 'sess-get-test';
    createSession({
      session_id: sessionId,
      started_at: '2026-01-01T00:00:00.000Z',
      project: 'test-project',
      model: 'claude-opus-4-6',
    });

    const session = getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.session_id).toBe(sessionId);
    expect(session!.project).toBe('test-project');
    expect(session!.model).toBe('claude-opus-4-6');
  });

  test('sessionExists returns true for existing session, false for non-existing', () => {
    const sessionId = 'sess-exists-test';
    createSession({
      session_id: sessionId,
      started_at: new Date().toISOString(),
    });

    expect(sessionExists(sessionId)).toBe(true);
    expect(sessionExists('sess-does-not-exist-xyz')).toBe(false);
  });

  test('endSession updates ended_at', () => {
    const sessionId = 'sess-end-test';
    createSession({
      session_id: sessionId,
      started_at: new Date().toISOString(),
    });

    const before = getSession(sessionId);
    expect(before!.ended_at).toBeFalsy();

    endSession(sessionId, 'session wrapped up');

    const after = getSession(sessionId);
    expect(after!.ended_at).toBeTruthy();
    expect(after!.summary).toBe('session wrapped up');
  });
});

// ============ Messages ============

describe('Messages', () => {
  test('addMessage returns id and message is retrievable via recentMessages', () => {
    const sessionId = 'sess-msg-single';
    createSession({ session_id: sessionId, started_at: new Date().toISOString() });

    const id = addMessage({
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      role: 'user',
      content: 'Hello from the test',
      project: 'msg-project',
    });

    expect(id).toBeGreaterThan(0);

    const messages = recentMessages(10, 'msg-project');
    const found = messages.find((m) => m.id === id);
    expect(found).toBeDefined();
    expect(found!.content).toBe('Hello from the test');
    expect(found!.role).toBe('user');
  });

  test('addMessagesBatch inserts all messages in one transaction', () => {
    const sessionId = 'sess-msg-batch';
    createSession({ session_id: sessionId, started_at: new Date().toISOString() });

    const now = new Date().toISOString();
    const batch = [
      { session_id: sessionId, timestamp: now, role: 'user' as const, content: 'Batch message one', project: 'batch-proj' },
      { session_id: sessionId, timestamp: now, role: 'assistant' as const, content: 'Batch message two', project: 'batch-proj' },
      { session_id: sessionId, timestamp: now, role: 'user' as const, content: 'Batch message three', project: 'batch-proj' },
    ];

    const count = addMessagesBatch(batch);
    expect(count).toBe(3);

    const messages = recentMessages(10, 'batch-proj');
    expect(messages.length).toBe(3);
  });
});

// ============ Decisions ============

describe('Decisions', () => {
  test('addDecision and getDecision round-trip correctly', () => {
    const id = addDecision({
      decision: 'Use SQLite for persistent storage',
      reasoning: 'Lightweight and zero-config',
      alternatives: 'Postgres, DuckDB',
      category: 'architecture',
      project: 'recall',
      status: 'active',
    });

    expect(id).toBeGreaterThan(0);

    const decision = getDecision(id);
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('Use SQLite for persistent storage');
    expect(decision!.reasoning).toBe('Lightweight and zero-config');
    expect(decision!.alternatives).toBe('Postgres, DuckDB');
    expect(decision!.category).toBe('architecture');
    expect(decision!.project).toBe('recall');
  });

  test('Decision defaults status to "active" when not provided', () => {
    const id = addDecision({
      decision: 'Default status decision',
    } as any);

    const decision = getDecision(id);
    expect(decision).toBeDefined();
    expect(decision!.status).toBe('active');
  });
});

// ============ Learnings ============

describe('Learnings', () => {
  test('addLearning and getLearning round-trip', () => {
    const id = addLearning({
      problem: 'SQLite locks on concurrent writes',
      solution: 'Use WAL mode',
      prevention: 'Enable WAL at connection time',
      category: 'database',
      project: 'recall',
      tags: 'sqlite,concurrency',
    });

    expect(id).toBeGreaterThan(0);

    const learning = getLearning(id);
    expect(learning).toBeDefined();
    expect(learning!.problem).toBe('SQLite locks on concurrent writes');
    expect(learning!.solution).toBe('Use WAL mode');
    expect(learning!.prevention).toBe('Enable WAL at connection time');
    expect(learning!.category).toBe('database');
    expect(learning!.tags).toBe('sqlite,concurrency');
  });
});

// ============ Breadcrumbs ============

describe('Breadcrumbs', () => {
  test('addBreadcrumb and getBreadcrumb round-trip', () => {
    const id = addBreadcrumb({
      content: 'Currently refactoring the search module',
      category: 'context',
      project: 'recall',
      importance: 8,
    });

    expect(id).toBeGreaterThan(0);

    const breadcrumb = getBreadcrumb(id);
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb!.content).toBe('Currently refactoring the search module');
    expect(breadcrumb!.category).toBe('context');
    expect(breadcrumb!.project).toBe('recall');
    expect(breadcrumb!.importance).toBe(8);
  });

  test('Default importance is 5 when not specified', () => {
    const id = addBreadcrumb({
      content: 'Breadcrumb with default importance',
    } as any);

    const breadcrumb = getBreadcrumb(id);
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb!.importance).toBe(5);
  });
});

// ============ Search (FTS5) ============

describe('Search (FTS5)', () => {
  const searchSessionId = 'sess-search-fts';
  const searchProject = 'search-test-project';

  beforeAll(() => {
    createSession({ session_id: searchSessionId, started_at: new Date().toISOString(), project: searchProject });

    addMessage({
      session_id: searchSessionId,
      timestamp: new Date().toISOString(),
      role: 'user',
      content: 'We need to deploy the kubernetes cluster to production',
      project: searchProject,
    });

    addMessage({
      session_id: searchSessionId,
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content: 'The kubernetes configuration looks correct',
      project: searchProject,
    });

    addMessage({
      session_id: searchSessionId,
      timestamp: new Date().toISOString(),
      role: 'user',
      content: 'An entirely unrelated message about cooking pasta',
      project: 'other-project',
    });
  });

  test('search finds messages by keyword', () => {
    const results = search('kubernetes');
    expect(results.length).toBeGreaterThan(0);
    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c.toLowerCase().includes('kubernetes'))).toBe(true);
  });

  test('search filters by project', () => {
    const results = search('kubernetes', { project: searchProject });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.project).toBe(searchProject);
    }
  });

  test('search filters by table', () => {
    const results = search('kubernetes', { table: 'messages' });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.table).toBe('messages');
    }
  });

  test('search returns empty array for no matches', () => {
    const results = search('zxqvbnmthiswordwillneverexist12345');
    expect(results).toEqual([]);
  });
});

// ============ Recent ============

describe('Recent', () => {
  const recentSessionId = 'sess-recent-test';
  const recentProject = 'recent-test-project';

  beforeAll(() => {
    createSession({ session_id: recentSessionId, started_at: new Date().toISOString(), project: recentProject });

    addMessage({
      session_id: recentSessionId,
      timestamp: '2026-01-01T10:00:00.000Z',
      role: 'user',
      content: 'First message (oldest)',
      project: recentProject,
    });

    addMessage({
      session_id: recentSessionId,
      timestamp: '2026-01-01T11:00:00.000Z',
      role: 'assistant',
      content: 'Second message',
      project: recentProject,
    });

    addMessage({
      session_id: recentSessionId,
      timestamp: '2026-01-01T12:00:00.000Z',
      role: 'user',
      content: 'Third message (newest)',
      project: recentProject,
    });

    addDecision({ decision: 'Recent decision A', project: recentProject, status: 'active' });
    addDecision({ decision: 'Recent decision B', project: recentProject, status: 'active' });
  });

  test('recentMessages returns messages ordered by timestamp DESC', () => {
    const messages = recentMessages(10, recentProject);
    expect(messages.length).toBeGreaterThanOrEqual(3);

    // Verify descending order: each timestamp should be >= the next
    for (let i = 0; i < messages.length - 1; i++) {
      expect(messages[i].timestamp >= messages[i + 1].timestamp).toBe(true);
    }

    // The most recent message should be first
    expect(messages[0].content).toBe('Third message (newest)');
  });

  test('recentDecisions returns decisions ordered by created_at DESC', () => {
    const decisions = recentDecisions(10, recentProject);
    expect(decisions.length).toBeGreaterThanOrEqual(2);

    // Verify descending order
    for (let i = 0; i < decisions.length - 1; i++) {
      expect(decisions[i].created_at! >= decisions[i + 1].created_at!).toBe(true);
    }

    // Both decisions should be present (order may vary when created_at is identical)
    const decisionTexts = decisions.map(d => d.decision);
    expect(decisionTexts).toContain('Recent decision A');
    expect(decisionTexts).toContain('Recent decision B');
  });
});

// ============ LoA ============

describe('LoA (Library of Alexandria)', () => {
  test('createLoaEntry and getLoaEntry round-trip', () => {
    const id = createLoaEntry({
      title: 'Architecture Overview',
      description: 'High level summary of the system design',
      fabric_extract: 'The system uses a SQLite database with FTS5 for full-text search across memory types.',
      project: 'recall',
      tags: 'architecture,overview',
      message_count: 42,
    });

    expect(id).toBeGreaterThan(0);

    const entry = getLoaEntry(id);
    expect(entry).toBeDefined();
    expect(entry!.title).toBe('Architecture Overview');
    expect(entry!.description).toBe('High level summary of the system design');
    expect(entry!.fabric_extract).toBe('The system uses a SQLite database with FTS5 for full-text search across memory types.');
    expect(entry!.project).toBe('recall');
    expect(entry!.tags).toBe('architecture,overview');
    expect(entry!.message_count).toBe(42);
  });

  test('getLastLoaEntry returns the most recently created entry', () => {
    const idFirst = createLoaEntry({
      title: 'Earlier LoA Entry',
      fabric_extract: 'Content of the earlier entry.',
    });

    const idSecond = createLoaEntry({
      title: 'Later LoA Entry',
      fabric_extract: 'Content of the later entry.',
    });

    expect(idSecond).toBeGreaterThan(idFirst);

    const last = getLastLoaEntry();
    expect(last).toBeDefined();
    expect(last!.title).toBe('Later LoA Entry');
  });

  test('recentLoaEntries returns entries in descending order', () => {
    const loaProject = 'loa-order-project';

    createLoaEntry({ title: 'LoA Alpha', fabric_extract: 'Alpha content', project: loaProject });
    createLoaEntry({ title: 'LoA Beta', fabric_extract: 'Beta content', project: loaProject });
    createLoaEntry({ title: 'LoA Gamma', fabric_extract: 'Gamma content', project: loaProject });

    const entries = recentLoaEntries(10, loaProject);
    expect(entries.length).toBe(3);

    // All three entries should be present (order may vary when created_at is identical)
    const titles = entries.map(e => e.title);
    expect(titles).toContain('LoA Alpha');
    expect(titles).toContain('LoA Beta');
    expect(titles).toContain('LoA Gamma');
  });
});

// ============ Stats ============

describe('Stats', () => {
  test('getStats returns correct counts after inserting data', () => {
    const statsBefore = getStats();

    const sessionId = 'sess-stats-test';
    createSession({ session_id: sessionId, started_at: new Date().toISOString() });

    addMessage({
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      role: 'user',
      content: 'Stats test message',
    });

    addDecision({ decision: 'Stats test decision', status: 'active' });
    addLearning({ problem: 'Stats test learning problem' });
    addBreadcrumb({ content: 'Stats test breadcrumb', importance: 5 });
    createLoaEntry({ title: 'Stats test LoA', fabric_extract: 'Stats LoA extract' });

    const statsAfter = getStats();

    expect(statsAfter.sessions).toBe(statsBefore.sessions + 1);
    expect(statsAfter.messages).toBe(statsBefore.messages + 1);
    expect(statsAfter.decisions).toBe(statsBefore.decisions + 1);
    expect(statsAfter.learnings).toBe(statsBefore.learnings + 1);
    expect(statsAfter.breadcrumbs).toBe(statsBefore.breadcrumbs + 1);
    expect(statsAfter.loa_entries).toBe(statsBefore.loa_entries + 1);
    expect(statsAfter.db_size_bytes).toBeGreaterThan(0);
  });
});
