import type { Message } from '../types/index.js';

export const SESSION_SOURCES = [
  'claude',
  'opencode',
  'pi',
  'codex',
  'grok',
  'jcode',
  'cursor',
  'mcp',
] as const;

export type SessionSource = typeof SESSION_SOURCES[number];

export interface ParsedSession {
  source: SessionSource;
  sessionId: string;
  project: string;
  messages: Omit<Message, 'id'>[];
  filePath: string;
}

export interface SessionSourceAdapter {
  id: SessionSource;
  discover(): ParsedSession | null;
}
