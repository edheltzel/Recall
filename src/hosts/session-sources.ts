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
  adapters: readonly SessionSourceAdapter[] = nativeSessionSources,
): ParsedSession | null {
  for (const adapter of adapters) {
    const session = adapter.discover();
    if (session) return session;
  }
  return null;
}
