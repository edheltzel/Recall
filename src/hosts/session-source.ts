import type { Message } from '../types/index.js';

export type SessionSource = 'claude' | 'opencode' | 'pi' | 'codex' | 'mcp';

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
