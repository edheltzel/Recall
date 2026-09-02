import { join } from 'path';
import { getRecallHome } from '../lib/runtime-paths.js';
import { markdownDropDirName } from '../../hooks/lib/markdown-drop.js';
import { discoverMarkdownDropSession } from './markdown-session-source.js';
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
