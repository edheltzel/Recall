// Public `recall start` — shared L0/L1 session-start inject renderer.
//
// Hosts call this CLI (or the assembler it wraps) instead of forking
// RecallStart.ts. Capture / catalog / import are out of scope here.

import {
  MEMORY_UNAVAILABLE,
  gatherContext,
  renderSessionStart,
  type SessionStartFormat,
} from '../../hooks/lib/session-start-context.js';
import { getRegisteredStartFormat } from '../lib/harness-seams.js';

export type { SessionStartFormat };
export { MEMORY_UNAVAILABLE, gatherContext, renderSessionStart, wrapCursorSessionStart } from '../../hooks/lib/session-start-context.js';

export interface StartOptions {
  /** Built-in `markdown` | `cursor`, or a format registered via `registerStartFormat`. */
  format?: string;
}

export function runStart(options: StartOptions = {}): void {
  const requested = options.format ?? 'markdown';
  const registered = getRegisteredStartFormat(requested);
  const format: SessionStartFormat = requested === 'cursor' ? 'cursor' : 'markdown';
  try {
    if (registered) {
      process.stdout.write(registered(gatherContext()));
      return;
    }
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
