import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { findClaudeCli } from '../hosts/claude.js';
import type { TextGenerationProvider } from './text-generation.js';

export const claudeCliTextGenerationProvider: TextGenerationProvider = {
  id: 'claude-cli',
  generate(prompt) {
    const executable = findClaudeCli(homedir());
    if (!executable) return null;
    try {
      return execFileSync(executable, ['-p', '--model', 'claude-haiku-4-5-20251001'], {
        input: prompt,
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, CLAUDECODE: '' },
      }).trim() || null;
    } catch {
      return null;
    }
  },
};
