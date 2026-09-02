import { join } from 'path';
import { getRecallHome } from '../lib/runtime-paths.js';
import { discoverMarkdownDropSession, markdownDropDirName } from './markdown-session-source.js';
import type { SessionSourceAdapter } from './session-source.js';

export const openCodeSessionSource: SessionSourceAdapter = {
  id: 'opencode',
  discover() {
    return discoverMarkdownDropSession(
      join(getRecallHome(), 'MEMORY', markdownDropDirName('opencode')),
      'opencode',
    );
  },
};
