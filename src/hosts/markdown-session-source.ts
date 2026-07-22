import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import type { Message } from '../types/index.js';

export function findLatestMarkdownDrop(dropDir: string): string | null {
  if (!existsSync(dropDir)) return null;
  let latest: string | null = null;
  let latestTime = 0;
  for (const file of readdirSync(dropDir)) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue;
    const full = join(dropDir, file);
    const modified = statSync(full).mtimeMs;
    if (modified > latestTime) {
      latestTime = modified;
      latest = full;
    }
  }
  return latest;
}

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
