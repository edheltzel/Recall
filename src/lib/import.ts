// Claude Code session import orchestration.
// Native path discovery and transcript parsing live in the Claude host adapter.

import { basename } from 'path';
import { createSession, sessionExists, addMessagesBatch } from './memory.js';
import { listClaudeSessionFiles, parseClaudeSessionFile } from '../hosts/claude-session-source.js';

interface ImportResult {
  sessionsImported: number;
  sessionsSkipped: number;
  messagesImported: number;
  errors: string[];
}

export function findSessionFiles(): string[] {
  return listClaudeSessionFiles();
}

export function importAllSessions(options?: { dryRun?: boolean; verbose?: boolean }): ImportResult {
  const result: ImportResult = {
    sessionsImported: 0,
    sessionsSkipped: 0,
    messagesImported: 0,
    errors: [],
  };
  const files = findSessionFiles();
  if (options?.verbose) console.log(`Found ${files.length} session files`);

  for (const file of files) {
    try {
      const parsed = parseClaudeSessionFile(file);
      if (!parsed || parsed.messages.length === 0) {
        result.sessionsSkipped++;
        continue;
      }
      if (sessionExists(parsed.sessionId)) {
        if (options?.verbose) console.log(`Skipping existing session: ${parsed.sessionId}`);
        result.sessionsSkipped++;
        continue;
      }
      if (options?.dryRun) {
        console.log(`[DRY RUN] Would import session ${parsed.sessionId} (${parsed.messages.length} messages)`);
        result.sessionsImported++;
        result.messagesImported += parsed.messages.length;
        continue;
      }

      const timestamps = parsed.messages.map(message => message.timestamp).sort();
      createSession({
        session_id: parsed.sessionId,
        started_at: timestamps[0],
        ended_at: timestamps[timestamps.length - 1],
        project: parsed.project,
        summary: `Imported from ${basename(file)}`,
        source: 'claude',
      });
      const count = addMessagesBatch(parsed.messages.map(message => ({
        ...message,
        provenance: 'verbatim' as const,
      })));
      result.sessionsImported++;
      result.messagesImported += count;
      if (options?.verbose) console.log(`Imported session ${parsed.sessionId}: ${count} messages`);
    } catch (error) {
      result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export function previewImport(): { total: number; existing: number; new: number; files: string[] } {
  const files = findSessionFiles();
  let existing = 0;
  let newSessions = 0;
  for (const file of files) {
    const parsed = parseClaudeSessionFile(file);
    if (!parsed) continue;
    if (sessionExists(parsed.sessionId)) existing++;
    else newSessions++;
  }
  return { total: files.length, existing, new: newSessions, files };
}
