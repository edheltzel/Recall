// Parse Fabric/Haiku extract_wisdom markdown into structured Recall records.
//
// Hooks carry a self-contained mirror of this logic under hooks/lib/ so they can
// keep working even if src/ is broken. Keep format changes in sync there.

import { getDb } from '../db/connection.js';
import { addBreadcrumb, addDecision, addLearning, createLoaEntry } from './memory.js';

export interface StructuredExtractionContext {
  sessionId: string;
  sessionLabel: string;
  project: string;
  timestamp: string;
  conversationPath: string;
  topics: string[];
  summary: string;
  extracted: string;
  messageCount?: number | null;
}

export interface StructuredExtractionResult {
  sessions: number;
  decisions: number;
  learnings: number;
  breadcrumbs: number;
  errors: number;
  loa: number;
  failures: Record<string, string>;
}

interface DecisionItem {
  decision: string;
  confidence: 'high' | 'medium' | 'low';
}

interface LearningItem {
  problem: string;
  solution: string;
}

interface ErrorPatternItem {
  errorKey: string;
  error: string;
  fix: string;
}

function parseBulletSection(extracted: string, sectionRegex: RegExp): string[] {
  const match = extracted.match(sectionRegex);
  if (!match) return [];
  return match[1]
    .split('\n')
    .filter(line => line.trim().startsWith('-'))
    .map(line => line.replace(/^-\s*/, '').replace(/\*\*/g, '').trim())
    .filter(line => line.length > 5);
}

export function parseDecisionItems(extracted: string): DecisionItem[] {
  const lines = parseBulletSection(
    extracted,
    /(?:##\s*DECISIONS\s*MADE|DECISIONS:)\s*([\s\S]*?)(?=\n##\s|$)/
  );

  return lines.map(line => {
    const confidenceMatch = line.match(/\(confidence:\s*(HIGH|MEDIUM|LOW)\)/i);
    const confidence = (confidenceMatch ? confidenceMatch[1].toLowerCase() : 'medium') as DecisionItem['confidence'];
    return {
      decision: line
        .replace(/\s*\(confidence:\s*(?:HIGH|MEDIUM|LOW)\)/i, '')
        .replace(/\|/g, '/'),
      confidence,
    };
  });
}

export function parseLearningItems(extracted: string): LearningItem[] {
  const lines = parseBulletSection(
    extracted,
    /(?:##\s*ERRORS?\s*FIXED|ERRORS_FIXED:)\s*([\s\S]*?)(?=\n##\s|$)/
  );

  const items: LearningItem[] = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    items.push({
      problem: line.slice(0, idx).trim(),
      solution: line.slice(idx + 1).trim(),
    });
  }
  return items;
}

export function parseBreadcrumbItems(extracted: string): string[] {
  return parseBulletSection(
    extracted,
    /(?:##\s*MAIN\s*IDEAS|MAIN_IDEAS:)\s*([\s\S]*?)(?=\n##\s|$)/
  );
}

export function parseErrorPatternItems(extracted: string): ErrorPatternItem[] {
  const normalize = (value: string) => value.toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
  return parseLearningItems(extracted).map(item => ({
    errorKey: normalize(item.problem),
    error: item.problem,
    fix: item.solution,
  }));
}

function writeExtractionSession(ctx: StructuredExtractionContext): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO extraction_sessions
       (session_id, project, branch, timestamp, summary, topics, conversation_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ctx.sessionId,
    ctx.project,
    null,
    ctx.timestamp,
    ctx.summary,
    JSON.stringify(ctx.topics),
    ctx.conversationPath
  );
}

function writeExtractionErrors(items: ErrorPatternItem[]): number {
  if (items.length === 0) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO extraction_errors (error_key, error, fix, context, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(error_key) DO UPDATE SET
       fix = COALESCE(excluded.fix, fix),
       context = COALESCE(excluded.context, context),
       last_seen = excluded.last_seen`
  );

  const insertMany = db.transaction((batch: ErrorPatternItem[]) => {
    let count = 0;
    for (const item of batch) {
      stmt.run(item.errorKey, item.error, item.fix, null, now, now);
      count++;
    }
    return count;
  });

  return insertMany(items);
}

function writeLoa(ctx: StructuredExtractionContext): number {
  const db = getDb();
  const range = db.prepare(
    'SELECT MIN(id) AS minId, MAX(id) AS maxId, COUNT(*) AS count FROM messages WHERE session_id = ?'
  ).get(ctx.sessionId) as { minId: number | null; maxId: number | null; count: number };

  return createLoaEntry({
    title: `${ctx.sessionLabel} — ${ctx.timestamp}`,
    description: ctx.summary,
    fabric_extract: ctx.extracted,
    message_range_start: range.minId ?? undefined,
    message_range_end: range.maxId ?? undefined,
    session_id: ctx.sessionId,
    project: ctx.project,
    tags: ctx.topics.join(','),
    message_count: ctx.messageCount ?? range.count,
  });
}

export function writeStructuredExtraction(ctx: StructuredExtractionContext): StructuredExtractionResult {
  const result: StructuredExtractionResult = {
    sessions: 0,
    decisions: 0,
    learnings: 0,
    breadcrumbs: 0,
    errors: 0,
    loa: 0,
    failures: {},
  };

  try {
    writeExtractionSession(ctx);
    result.sessions = 1;
  } catch (error) {
    result.failures.sessions = error instanceof Error ? error.message : String(error);
  }

  try {
    for (const item of parseDecisionItems(ctx.extracted)) {
      addDecision({
        session_id: ctx.sessionId,
        category: 'auto-extracted',
        project: ctx.project,
        decision: item.decision,
        status: 'active',
        confidence: item.confidence,
      });
      result.decisions++;
    }
  } catch (error) {
    result.failures.decisions = error instanceof Error ? error.message : String(error);
  }

  try {
    for (const item of parseLearningItems(ctx.extracted)) {
      addLearning({
        session_id: ctx.sessionId,
        category: 'auto-extracted',
        project: ctx.project,
        problem: item.problem,
        solution: item.solution,
        tags: ctx.sessionLabel,
        confidence: 'medium',
      });
      result.learnings++;
    }
  } catch (error) {
    result.failures.learnings = error instanceof Error ? error.message : String(error);
  }

  try {
    for (const content of parseBreadcrumbItems(ctx.extracted)) {
      addBreadcrumb({
        session_id: ctx.sessionId,
        category: 'extracted-idea',
        project: ctx.project,
        content,
        importance: 5,
      });
      result.breadcrumbs++;
    }
  } catch (error) {
    result.failures.breadcrumbs = error instanceof Error ? error.message : String(error);
  }

  try {
    result.errors = writeExtractionErrors(parseErrorPatternItems(ctx.extracted));
  } catch (error) {
    result.failures.errors = error instanceof Error ? error.message : String(error);
  }

  try {
    result.loa = writeLoa(ctx) > 0 ? 1 : 0;
  } catch (error) {
    result.failures.loa = error instanceof Error ? error.message : String(error);
  }

  return result;
}
