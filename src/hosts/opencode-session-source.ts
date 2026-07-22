import { join } from 'path';
import { getRecallHome } from '../lib/runtime-paths.js';
import { findLatestMarkdownDrop, parseMarkdownDrop } from './markdown-session-source.js';
import type { SessionSourceAdapter } from './session-source.js';

export const openCodeSessionSource: SessionSourceAdapter = {
  id: 'opencode',
  discover() {
    const filePath = findLatestMarkdownDrop(join(getRecallHome(), 'MEMORY', 'opencode-sessions'));
    if (!filePath) return null;
    const parsed = parseMarkdownDrop(filePath);
    return parsed && parsed.messages.length > 0 ? {
      source: 'opencode',
      sessionId: parsed.sessionId,
      project: 'opencode',
      messages: parsed.messages.map(message => ({ ...message, project: 'opencode' })),
      filePath,
    } : null;
  },
};
