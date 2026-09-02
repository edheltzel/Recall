// Public `recall start` — shared L0/L1 session-start inject renderer.
//
// Hosts call this CLI (or the assembler it wraps) instead of forking
// RecallStart.ts. Capture / catalog / import are out of scope here.

import {
  MEMORY_UNAVAILABLE,
  renderSessionStart,
  type SessionStartFormat,
} from '../../hooks/lib/session-start-context.js';

export type { SessionStartFormat };

export interface StartOptions {
  format?: SessionStartFormat;
}

export function runStart(options: StartOptions = {}): void {
  const format = options.format === 'cursor' ? 'cursor' : 'markdown';
  try {
    process.stdout.write(renderSessionStart(format));
    if (format === 'markdown') process.stdout.write('\n');
  } catch {
    if (format === 'cursor') {
      process.stdout.write(JSON.stringify({ additional_context: MEMORY_UNAVAILABLE }));
    } else {
      process.stdout.write(MEMORY_UNAVAILABLE + '\n');
    }
  }
}
