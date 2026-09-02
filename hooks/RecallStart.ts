#!/usr/bin/env bun
/**
 * RecallStart.ts — Claude Code SessionStart wrapper
 *
 * Thin host wrapper around the shared L0/L1 assembler in
 * `hooks/lib/session-start-context.ts`. Claude SessionStart accepts
 * markdown on stdout. Other hosts call the same assembler:
 *   - `recall start` (public CLI)
 *   - Codex SessionStart via `recall host-hook` renderContext
 *
 * TRIGGER: Claude Code SessionStart
 */

export {
  MAX_L0_CHARS,
  MAX_L1_CHARS,
  MAX_TOTAL_CHARS,
  MEMORY_UNAVAILABLE,
  resolveSessionStartCwd,
  detectProject,
  queryDb,
  buildL0,
  assembleL1,
  gatherContext,
  renderSessionStart,
} from './lib/session-start-context';

import { gatherContext, MEMORY_UNAVAILABLE } from './lib/session-start-context';

const isDirectExecution = process.argv[1]?.endsWith('RecallStart.ts');
if (isDirectExecution) {
  try {
    console.log(gatherContext());
  } catch {
    console.log(MEMORY_UNAVAILABLE);
  }
}
