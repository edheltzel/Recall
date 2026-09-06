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
  /** Builtin `SESSION_SOURCES` id, or a registered harness id. */
  source: string;
  sessionId: string;
  project: string;
  messages: Omit<Message, 'id'>[];
  filePath: string;
}

export interface SessionSourceAdapter {
  id: string;
  discover(): ParsedSession | null;
}
