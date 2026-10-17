import { registeredSessionSources } from '../lib/harness-seams.js';
import { claudeSessionSource } from './claude-session-source.js';
import { openCodeSessionSource } from './opencode-session-source.js';
import { piSessionSource } from './pi-session-source.js';
import type { ParsedSession, SessionSourceAdapter } from './session-source.js';

export const nativeSessionSources: readonly SessionSourceAdapter[] = [
  claudeSessionSource,
  openCodeSessionSource,
  piSessionSource,
];

export function discoverCurrentSession(
  adapters: readonly SessionSourceAdapter[] = [...nativeSessionSources, ...registeredSessionSources()],
): ParsedSession | null {
  // Inside omp (which also sets CLAUDECODE=1) every file on disk belongs to another
  // conversation; the omp extension's recall_dump tool supplies the live session instead.
  if (process.env.OMPCODE === '1') return null;
  for (const adapter of adapters) {
    const session = adapter.discover();
    if (session) return session;
  }
  return null;
}
