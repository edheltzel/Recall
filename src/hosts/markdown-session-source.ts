import { readFileSync } from 'fs';
import { basename } from 'path';
import type { Message } from '../types/index.js';
import { findLatestMarkdownDrop } from '../../hooks/lib/markdown-drop.js';
import type { ParsedSession } from './session-source.js';

export {
  MARKDOWN_DROP_DIR_SUFFIX,
  findLatestMarkdownDrop,
  listMarkdownDropDirs,
  markdownDropDirName,
  type MarkdownDropFile,
} from '../../hooks/lib/markdown-drop.js';

/** Parse the explicit markdown-drop contract used by OpenCode and Pi adapters. */
export function parseMarkdownDrop(filePath: string): { sessionId: string; messages: Omit<Message, 'id'>[] } | null {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.trim()) return null;

  const sessionId = basename(filePath, '.md');
  const messages: Omit<Message, 'id'>[] = [];
  const rolePattern = /\[(USER|ASSISTANT)(?:\s+[\d:]+)?\]:\s*/gi;
  const parts: Array<{ role: 'user' | 'assistant'; markerIdx: number; startIdx: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = rolePattern.exec(content)) !== null) {
    parts.push({
      role: match[1].toLowerCase() as 'user' | 'assistant',
      markerIdx: match.index,
      startIdx: match.index + match[0].length,
    });
  }
  if (parts.length === 0) {
    const headingPattern = /^##?\s*(User|Assistant|Human)\s*$/gim;
    while ((match = headingPattern.exec(content)) !== null) {
      const rawRole = match[1].toLowerCase();
      parts.push({
        role: (rawRole === 'human' ? 'user' : rawRole) as 'user' | 'assistant',
        markerIdx: match.index,
        startIdx: match.index + match[0].length,
      });
    }
  }
  if (parts.length === 0) return null;

  const now = new Date().toISOString();
  for (let index = 0; index < parts.length; index++) {
    const start = parts[index].startIdx;
    const end = index + 1 < parts.length ? parts[index + 1].markerIdx : content.length;
    const text = content.slice(start, end > start ? end : content.length).trim();
    if (text.length > 10) {
      messages.push({
        session_id: sessionId,
        timestamp: now,
        role: parts[index].role,
        content: text,
      });
    }
  }
  return messages.length > 0 ? { sessionId, messages } : null;
}

/** Discover the latest markdown drop from a host-owned MEMORY/<host>-sessions dir. */
export function discoverMarkdownDropSession(
  dropDir: string,
  source: string,
  project: string = source,
): ParsedSession | null {
  const filePath = findLatestMarkdownDrop(dropDir);
  if (!filePath) return null;
  const parsed = parseMarkdownDrop(filePath);
  return parsed && parsed.messages.length > 0 ? {
    source,
    sessionId: parsed.sessionId,
    project,
    messages: parsed.messages.map(message => ({ ...message, project })),
    filePath,
  } : null;
}
