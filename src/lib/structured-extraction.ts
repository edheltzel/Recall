// Parse Extractor markdown into structured Recall records.
//
// Hooks carry a self-contained mirror of this logic under hooks/lib/ so they can
// keep working even if src/ is broken. Keep format changes in sync there.

import { getDb } from '../db/connection.js';
import { addBreadcrumb, addDecision, addLearning, createLoaEntry } from './memory.js';
import {
  scoreCandidates,
  type JevBatchCandidate,
  type JevBatchResult,
  type JevDecision,
} from '../providers/jev.js';
import { scrub } from './write-safety.js';

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
  /** Disposition counts for scored rows. `skipped` is a missing or blank key. A request error leaves every counter at 0. */
  jev: { kept: number; demoted: number; dropped: number; skipped: number };
  failures: Record<string, string>;
}

interface DecisionItem {
  decision: string;
  confidence: 'high' | 'medium' | 'low';
  importance?: number;
}

interface LearningItem {
  problem: string;
  solution: string;
  importance?: number;
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
    'SELECT MIN(id) AS minId, MAX(id) AS maxId, COUNT(*) AS count FROM published_messages WHERE session_id = ?'
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
    provenance: 'extracted',
  });
}

function scrubText(value: string): string {
  return scrub(value).text;
}

function jevCounts(
  candidates: readonly { id: string }[],
  scored: JevBatchResult,
): StructuredExtractionResult['jev'] {
  if (scored.status === 'skipped') {
    return { kept: 0, demoted: 0, dropped: 0, skipped: candidates.length };
  }
  if (scored.status !== 'scored') {
    return { kept: 0, demoted: 0, dropped: 0, skipped: 0 };
  }
  const counts = { kept: 0, demoted: 0, dropped: 0, skipped: 0 };
  for (const candidate of candidates) {
    // Missing choice counts as keep, matching applyChoices.
    const choice = scored.decisions[candidate.id]?.choice ?? 'keep';
    if (choice === 'drop') counts.dropped += 1;
    else if (choice === 'demote') counts.demoted += 1;
    else counts.kept += 1;
  }
  return counts;
}

function applyChoices<T extends { importance?: number }>(
  items: readonly T[],
  prefix: 'd' | 'l' | 'b',
  decisions: Record<string, JevDecision>,
): T[] {
  const kept: T[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item === undefined) continue;
    const choice = decisions[`${prefix}${index}`]?.choice ?? 'keep';
    if (choice === 'drop') continue;
    kept.push(choice === 'demote' ? { ...item, importance: 3 } : item);
  }
  return kept;
}

async function gateStructuredRows(
  decisions: DecisionItem[],
  learnings: LearningItem[],
  breadcrumbs: string[],
  project: string,
  failures: Record<string, string>,
): Promise<{
  decisions: DecisionItem[];
  learnings: LearningItem[];
  breadcrumbs: { content: string; importance?: number }[];
  jev: StructuredExtractionResult['jev'];
}> {
  const scrubbedProject = scrubText(project);
  const projectField = scrubbedProject ? { project: scrubbedProject } : {};
  const preparedDecisions = decisions.map(item => ({ ...item, decision: scrubText(item.decision) }));
  const preparedLearnings: LearningItem[] = learnings.map(item => ({
    problem: scrubText(item.problem),
    solution: scrubText(item.solution),
  }));
  const preparedBreadcrumbs: { content: string; importance?: number }[] = breadcrumbs.map(content => ({
    content: scrubText(content),
  }));
  const candidates: JevBatchCandidate[] = [
    ...preparedDecisions.map((item, index) => ({
      id: `d${index}`,
      kind: 'decision' as const,
      text: `${item.decision} (confidence: ${item.confidence})`,
      confidence: item.confidence,
      ...projectField,
    })),
    ...preparedLearnings.map((item, index) => ({
      id: `l${index}`,
      kind: 'learning' as const,
      text: item.solution ? `${item.problem}: ${item.solution}` : item.problem,
      ...projectField,
    })),
    ...preparedBreadcrumbs.map((item, index) => ({
      id: `b${index}`,
      kind: 'breadcrumb' as const,
      text: item.content,
      ...projectField,
    })),
  ];

  const scored = await scoreCandidates(candidates);
  const jev = jevCounts(candidates, scored);
  if (scored.status === 'error') failures.jev = scored.error;
  if (scored.status !== 'scored') {
    return {
      decisions: preparedDecisions,
      learnings: preparedLearnings,
      breadcrumbs: preparedBreadcrumbs,
      jev,
    };
  }
  return {
    decisions: applyChoices(preparedDecisions, 'd', scored.decisions),
    learnings: applyChoices(preparedLearnings, 'l', scored.decisions),
    breadcrumbs: applyChoices(preparedBreadcrumbs, 'b', scored.decisions),
    jev,
  };
}

export async function writeStructuredExtraction(
  ctx: StructuredExtractionContext,
): Promise<StructuredExtractionResult> {
  const result: StructuredExtractionResult = {
    sessions: 0,
    decisions: 0,
    learnings: 0,
    breadcrumbs: 0,
    errors: 0,
    loa: 0,
    jev: { kept: 0, demoted: 0, dropped: 0, skipped: 0 },
    failures: {},
  };

  const gated = await gateStructuredRows(
    parseDecisionItems(ctx.extracted),
    parseLearningItems(ctx.extracted),
    parseBreadcrumbItems(ctx.extracted),
    ctx.project,
    result.failures,
  );
  result.jev = gated.jev;
  const project = scrubText(ctx.project);

  try {
    writeExtractionSession(ctx);
    result.sessions = 1;
  } catch (error) {
    result.failures.sessions = error instanceof Error ? error.message : String(error);
  }

  try {
    for (const item of gated.decisions) {
      addDecision({
        session_id: ctx.sessionId,
        category: 'auto-extracted',
        project,
        decision: item.decision,
        status: 'active',
        confidence: item.confidence,
        provenance: 'extracted',
        ...(item.importance === undefined ? {} : { importance: item.importance }),
      });
      result.decisions++;
    }
  } catch (error) {
    result.failures.decisions = error instanceof Error ? error.message : String(error);
  }

  try {
    for (const item of gated.learnings) {
      addLearning({
        session_id: ctx.sessionId,
        category: 'auto-extracted',
        project,
        problem: item.problem,
        solution: item.solution,
        tags: ctx.sessionLabel,
        confidence: 'medium',
        provenance: 'extracted',
        ...(item.importance === undefined ? {} : { importance: item.importance }),
      });
      result.learnings++;
    }
  } catch (error) {
    result.failures.learnings = error instanceof Error ? error.message : String(error);
  }

  try {
    for (const item of gated.breadcrumbs) {
      addBreadcrumb({
        session_id: ctx.sessionId,
        category: 'extracted-idea',
        project,
        content: item.content,
        importance: item.importance ?? 5,
        provenance: 'extracted',
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
