import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import type { Message } from '../types/index.js';
import { claudePaths } from './claude.js';
import type { ParsedSession, SessionSourceAdapter } from './session-source.js';

export function listClaudeSessionFiles(projectsDir: string = claudePaths(homedir()).projects): string[] {
  if (!existsSync(projectsDir)) return [];
  const files: string[] = [];
  for (const projectDir of readdirSync(projectsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const projectPath = join(projectsDir, projectDir.name);
    for (const file of readdirSync(projectPath, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      files.push(join(projectPath, file.name));
    }
  }
  return files;
}

/** Decode Claude Code's filesystem-safe project-directory convention. */
export function extractClaudeProjectFromPath(path: string): string {
  const parts = path.split('-');
  const projectsIdx = parts.findIndex(part => part.toLowerCase() === 'projects');
  if (projectsIdx !== -1 && projectsIdx < parts.length - 1) {
    return parts.slice(projectsIdx + 1).join('-');
  }
  return parts[parts.length - 1] || path;
}

function findCurrentSessionFile(projectsDir: string): string | null {
  let mostRecentFile: string | null = null;
  let mostRecentTime = 0;
  for (const filePath of listClaudeSessionFiles(projectsDir)) {
    const modified = statSync(filePath).mtimeMs;
    if (modified > mostRecentTime) {
      mostRecentTime = modified;
      mostRecentFile = filePath;
    }
  }
  return mostRecentFile;
}

export function parseClaudeSessionFile(filePath: string): Omit<ParsedSession, 'source' | 'filePath'> | null {
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(line => line.trim());
  if (lines.length === 0) return null;
  const messages: Omit<Message, 'id'>[] = [];
  let sessionId: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        sessionId?: string;
        timestamp?: string;
        message?: { content?: string | Array<{ type?: string; text?: string }> };
      };
      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
      if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
      const content = parsed.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(block => block.type === 'text' && block.text).map(block => block.text).join('\n')
          : '';
      if (!text.trim()) continue;
      messages.push({
        session_id: parsed.sessionId || sessionId || 'unknown',
        timestamp: parsed.timestamp || new Date().toISOString(),
        role: parsed.type,
        content: text,
      });
    } catch {
      // Ignore partial/corrupt transcript lines.
    }
  }
  const project = extractClaudeProjectFromPath(basename(dirname(filePath)));
  for (const message of messages) message.project = project;
  return {
    sessionId: sessionId || basename(filePath, '.jsonl'),
    project,
    messages,
  };
}

export const claudeSessionSource: SessionSourceAdapter = {
  id: 'claude',
  discover() {
    const filePath = findCurrentSessionFile(claudePaths(homedir()).projects);
    if (!filePath) return null;
    const parsed = parseClaudeSessionFile(filePath);
    return parsed && parsed.messages.length > 0
      ? { source: 'claude', filePath, ...parsed }
      : null;
  },
};
