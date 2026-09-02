import { join } from 'path';
import { getRecallHome } from '../lib/runtime-paths.js';
import { discoverMarkdownDropSession, markdownDropDirName } from './markdown-session-source.js';
import type { SessionSourceAdapter } from './session-source.js';

export const piSessionSource: SessionSourceAdapter = {
  id: 'pi',
  discover() {
    return discoverMarkdownDropSession(
      join(getRecallHome(), 'MEMORY', markdownDropDirName('pi')),
      'pi',
    );
  },
};
