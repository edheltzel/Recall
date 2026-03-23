#!/usr/bin/env bun
/**
 * SessionRecall.ts - Load Persistent Memory at Session Start (Recall)
 *
 * PURPOSE:
 * Loads relevant memory context at the start of every Claude Code session.
 * Outputs recent decisions, breadcrumbs, learnings, and active context
 * so Claude has persistent memory from the very first turn.
 *
 * TRIGGER: SessionStart
 *
 * OUTPUT:
 * - Prints memory context to stdout (shown to Claude at session start)
 * - Includes: recent decisions, breadcrumbs, learnings, hot recall summary
 * - Scoped to current project when detectable
 *
 * PERFORMANCE:
 * - Targets <2s execution (direct SQLite reads, no API calls)
 * - Gracefully degrades if DB missing or empty
 */

import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';

// Maximum output size in characters to prevent unbounded output
const MAX_OUTPUT_CHARS = 8000;
// Maximum time for git commands in ms
const GIT_TIMEOUT_MS = 3000;

// Resolve paths at call time so env overrides work (important for tests)
function getDbPath(): string {
  if (process.env.MEM_DB_PATH) return process.env.MEM_DB_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.claude', 'memory.db');
}

function getHotRecallPath(): string {
  if (process.env.HOT_RECALL_PATH) return process.env.HOT_RECALL_PATH;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.claude', 'MEMORY', 'HOT_RECALL.md');
}

// ─── Project Detection ───────────────────────────────────────────────
export function detectProject(): string | undefined {
  const cwd = process.cwd();
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    const match = remote.match(/\/([^/]+?)(\.git)?$/);
    if (match) return match[1];
  } catch {
    // Not a git repo or timeout — fall through
  }
  return basename(cwd);
}

// ─── SQLite Direct Read (no imports from src/) ───────────────────────
export function queryDb(sql: string, params: any[] = []): any[] {
  try {
    const { Database } = require('bun:sqlite');
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    db.exec('PRAGMA journal_mode = WAL');
    const rows = db.prepare(sql).all(...params);
    db.close();
    return rows;
  } catch {
    return [];
  }
}

// ─── Gather Memory Context ───────────────────────────────────────────
export function gatherContext(): string {
  const project = detectProject();
  const sections: string[] = [];
  let hasContent = false;

  // Header
  sections.push('## Recall — Session Memory Context');
  if (project) sections.push(`**Project:** ${project}`);
  sections.push('');

  // Recent decisions (project-scoped first, then global)
  const decisions = project
    ? queryDb(
        `SELECT id, decision, reasoning, project, created_at FROM decisions
         WHERE project = ? AND status = 'active' ORDER BY created_at DESC LIMIT 5`,
        [project]
      )
    : [];
  const globalDecisions = queryDb(
    `SELECT id, decision, reasoning, project, created_at FROM decisions
     WHERE status = 'active' ORDER BY created_at DESC LIMIT ${project ? 3 : 5}`
  );
  // Merge, deduplicate by id
  const seenIds = new Set<number>();
  const allDecisions = [...decisions, ...globalDecisions].filter(d => {
    if (seenIds.has(d.id)) return false;
    seenIds.add(d.id);
    return true;
  }).slice(0, 7);

  if (allDecisions.length > 0) {
    hasContent = true;
    sections.push('### Active Decisions');
    for (const d of allDecisions) {
      const date = d.created_at?.split('T')[0] || '';
      const tag = d.project ? `[${d.project}]` : '';
      sections.push(`- **#${d.id}** ${tag} ${date}: ${d.decision}${d.reasoning ? ` — ${d.reasoning}` : ''}`);
    }
    sections.push('');
  }

  // Recent breadcrumbs (high importance first)
  const breadcrumbs = project
    ? queryDb(
        `SELECT id, content, importance, project, created_at FROM breadcrumbs
         WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
         ORDER BY importance DESC, created_at DESC LIMIT 5`,
        [project]
      )
    : queryDb(
        `SELECT id, content, importance, project, created_at FROM breadcrumbs
         WHERE expires_at IS NULL OR expires_at > datetime('now')
         ORDER BY importance DESC, created_at DESC LIMIT 5`
      );

  if (breadcrumbs.length > 0) {
    hasContent = true;
    sections.push('### Breadcrumbs');
    for (const b of breadcrumbs) {
      const tag = b.project ? `[${b.project}]` : '';
      const imp = b.importance > 5 ? ` (importance: ${b.importance}/10)` : '';
      sections.push(`- **#${b.id}** ${tag}${imp}: ${b.content}`);
    }
    sections.push('');
  }

  // Recent learnings
  const learnings = project
    ? queryDb(
        `SELECT id, problem, solution, project, created_at FROM learnings
         WHERE project = ? ORDER BY created_at DESC LIMIT 3`,
        [project]
      )
    : queryDb(
        `SELECT id, problem, solution, project, created_at FROM learnings
         ORDER BY created_at DESC LIMIT 3`
      );

  if (learnings.length > 0) {
    hasContent = true;
    sections.push('### Recent Learnings');
    for (const l of learnings) {
      const tag = l.project ? `[${l.project}]` : '';
      sections.push(`- **#${l.id}** ${tag}: ${l.problem}${l.solution ? ` → ${l.solution}` : ''}`);
    }
    sections.push('');
  }

  // Hot recall summary (last few lines from HOT_RECALL.md)
  const hotRecallPath = getHotRecallPath();
  if (existsSync(hotRecallPath)) {
    try {
      const hotRecall = readFileSync(hotRecallPath, 'utf-8').trim();
      if (hotRecall.length > 0) {
        // Extract just the most recent session summary (first block)
        const blocks = hotRecall.split(/^---$/m).filter(b => b.trim());
        if (blocks.length > 0) {
          const latest = blocks[blocks.length - 1].trim();
          // Limit to ~500 chars to keep output concise
          const preview = latest.length > 500 ? latest.slice(0, 500) + '...' : latest;
          hasContent = true;
          sections.push('### Last Session Summary');
          sections.push(preview);
          sections.push('');
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // If nothing found, say so briefly
  if (!hasContent) {
    sections.push('No memory entries found yet. Use `memory_add` to record decisions, learnings, and breadcrumbs during this session.');
    sections.push('');
  }

  // Behavioral reminder
  sections.push('---');
  sections.push('**Recall is active.** Before checking git log for context, search memory first: `memory_search` or `memory_hybrid_search`. Record important decisions with `memory_add`.');

  let output = sections.join('\n');

  // Safety: cap output size to prevent unbounded context injection
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Output truncated — use `memory_search` for more detail]';
  }

  return output;
}

// ─── Main (only runs when executed directly, not when imported) ──────
const isDirectExecution = process.argv[1]?.endsWith('SessionRecall.ts');
if (isDirectExecution) {
  try {
    const output = gatherContext();
    console.log(output);
  } catch (err) {
    // Graceful failure — don't block session start
    console.log('## Recall — Memory unavailable this session\nUse `memory_search` to query memory manually.');
  }
}
