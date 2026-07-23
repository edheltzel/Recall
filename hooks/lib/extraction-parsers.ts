// Parse fabric-format extracted markdown into typed records the writers
// can consume. Self-contained — no imports from src/ or from RecallExtract.

import type {
  DecisionInput,
  LearningInput,
  BreadcrumbInput,
  ExtractionErrorInput,
} from './sqlite-writers';
import {
  ensureDbWritable,
  writeBreadcrumbsBatch,
  writeDecisionsBatch,
  writeExtractionErrors,
  writeExtractionSession,
  writeLearningsBatch,
  writeLoaEntryFromExtraction,
} from './sqlite-writers';

export interface DualWriteContext {
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

export interface DualWriteResult {
  sessions: number;
  decisions: number;
  learnings: number;
  breadcrumbs: number;
  errors: number;
  loa: number;
  failures: Record<string, string>;
}

function parseBulletSection(extracted: string, sectionRegex: RegExp): string[] {
  const m = extracted.match(sectionRegex);
  if (!m) return [];
  return m[1]
    .split('\n')
    .filter((l) => l.trim().startsWith('-'))
    .map((l) => l.replace(/^-\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length > 5);
}

export function parseDecisionItems(
  extracted: string,
  ctx: Pick<DualWriteContext, 'sessionId' | 'project'>
): DecisionInput[] {
  const lines = parseBulletSection(
    extracted,
    /(?:##\s*DECISIONS\s*MADE|DECISIONS:)\s*([\s\S]*?)(?=\n##\s|$)/
  );
  return lines.map((line) => {
    const cmatch = line.match(/\(confidence:\s*(HIGH|MEDIUM|LOW)\)/i);
    const confidence = (cmatch ? cmatch[1].toLowerCase() : 'medium') as
      | 'high'
      | 'medium'
      | 'low';
    const decision = line
      .replace(/\s*\(confidence:\s*(?:HIGH|MEDIUM|LOW)\)/i, '')
      .replace(/\|/g, '/');
    return {
      decision,
      confidence,
      sessionId: ctx.sessionId,
      project: ctx.project,
      category: 'auto-extracted',
    };
  });
}

export function parseLearningItems(
  extracted: string,
  ctx: Pick<DualWriteContext, 'sessionId' | 'project' | 'sessionLabel'>
): LearningInput[] {
  // Map "## ERRORS FIXED" bullets (format `error: fix`) into learnings.
  const lines = parseBulletSection(
    extracted,
    /(?:##\s*ERRORS?\s*FIXED|ERRORS_FIXED:)\s*([\s\S]*?)(?=\n##\s|$)/
  );
  const out: LearningInput[] = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out.push({
      problem: line.slice(0, idx).trim(),
      solution: line.slice(idx + 1).trim(),
      sessionId: ctx.sessionId,
      project: ctx.project,
      category: 'auto-extracted',
      tags: ctx.sessionLabel,
    });
  }
  return out;
}

export function parseBreadcrumbItems(
  extracted: string,
  ctx: Pick<DualWriteContext, 'sessionId' | 'project'>
): BreadcrumbInput[] {
  const lines = parseBulletSection(
    extracted,
    /(?:##\s*MAIN\s*IDEAS|MAIN_IDEAS:)\s*([\s\S]*?)(?=\n##\s|$)/
  );
  return lines.map((content) => ({
    content,
    category: 'extracted-idea',
    sessionId: ctx.sessionId,
    project: ctx.project,
  }));
}

export function parseErrorPatternItems(extracted: string): ExtractionErrorInput[] {
  const lines = parseBulletSection(
    extracted,
    /(?:##\s*ERRORS?\s*FIXED|ERRORS_FIXED:)\s*([\s\S]*?)(?=\n##\s|$)/
  );
  const normalize = (s: string) =>
    s.toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
  const out: ExtractionErrorInput[] = [];
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const error = line.slice(0, idx).trim();
    const fix = line.slice(idx + 1).trim();
    out.push({ errorKey: normalize(error), error, fix });
  }
  return out;
}

/**
 * Dual-write extracted content into SQLite. Every section is wrapped in its
 * own try/catch — a failure on one writer must not block the others, and the
 * whole function must not throw.
 */
export function dualWriteToSqlite(
  dbPath: string,
  ctx: DualWriteContext
): DualWriteResult {
  const result: DualWriteResult = {
    sessions: 0,
    decisions: 0,
    learnings: 0,
    breadcrumbs: 0,
    errors: 0,
    loa: 0,
    failures: {},
  };

  if (!ensureDbWritable(dbPath)) {
    result.failures._db = 'not writable or locked';
    return result;
  }

  try {
    writeExtractionSession(dbPath, {
      sessionId: ctx.sessionId,
      project: ctx.project,
      timestamp: ctx.timestamp,
      summary: ctx.summary,
      topics: ctx.topics,
      conversationPath: ctx.conversationPath,
    });
    result.sessions = 1;
  } catch (e: any) {
    result.failures.sessions = e?.message || String(e);
  }

  try {
    result.decisions = writeDecisionsBatch(dbPath, parseDecisionItems(ctx.extracted, ctx));
  } catch (e: any) {
    result.failures.decisions = e?.message || String(e);
  }

  try {
    result.learnings = writeLearningsBatch(dbPath, parseLearningItems(ctx.extracted, ctx));
  } catch (e: any) {
    result.failures.learnings = e?.message || String(e);
  }

  try {
    result.breadcrumbs = writeBreadcrumbsBatch(
      dbPath,
      parseBreadcrumbItems(ctx.extracted, ctx)
    );
  } catch (e: any) {
    result.failures.breadcrumbs = e?.message || String(e);
  }

  try {
    result.errors = writeExtractionErrors(dbPath, parseErrorPatternItems(ctx.extracted));
  } catch (e: any) {
    result.failures.errors = e?.message || String(e);
  }

  try {
    const loaId = writeLoaEntryFromExtraction(dbPath, {
      title: `${ctx.sessionLabel} — ${ctx.timestamp}`,
      description: ctx.summary,
      fabricExtract: ctx.extracted,
      sessionId: ctx.sessionId,
      project: ctx.project,
      tags: ctx.topics.join(','),
      messageCount: ctx.messageCount ?? null,
    });
    result.loa = loaId ? 1 : 0;
  } catch (e: any) {
    result.failures.loa = e?.message || String(e);
  }

  return result;
}
