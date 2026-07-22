// Pure helper: select the JSONL file representing the PREVIOUS session for a
// given cwd. Used by RecallClearExtract.ts to find the just-cleared conversation's
// transcript so it can be extracted before RecallBatchExtract cron picks it up.
//
// Self-contained — no imports from src/. No filesystem side effects beyond
// readdir + stat.

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { encodeProjectDir } from './hosts/claude/path-encoding';

/**
 * Default mtime-guard: a JSONL whose mtime is within this many seconds of
 * "now" is treated as "the in-progress session's file that just appeared"
 * and is NOT returned as the previous session. We fall through to the
 * next-most-recent file instead.
 */
export const DEFAULT_MTIME_GUARD_SECONDS = 5;

export interface JsonlCandidate {
  name: string;
  path: string;
  mtimeMs: number;
}

/**
 * Pick the JSONL representing the previous (just-cleared) session.
 *
 * Algorithm:
 *   1. Resolve projects/<encoded-cwd>/ directory.
 *   2. Read directory; filter to `*.jsonl` files, skip `agent-*.jsonl`
 *      (Claude Code sub-agent transcripts).
 *   3. Sort by mtime descending.
 *   4. If the most-recent file's mtime is within `mtimeGuardSeconds` of now,
 *      it is the in-progress session — return the second-most-recent.
 *   5. Otherwise, return the second-most-recent (the "previous" session) if
 *      it exists, falling back to the most-recent (best-effort single-file
 *      case where there is no prior session).
 *
 * @param projectsDir      Typically `~/.claude/projects`
 * @param cwd              The session's working directory
 * @param mtimeGuardSeconds  Threshold for "this looks like the new session";
 *                          default 5s
 * @param nowMs            Override for "now" — for deterministic tests.
 * @returns absolute path to the previous JSONL, or null
 */
export function pickPreviousJsonl(
  projectsDir: string,
  cwd: string,
  mtimeGuardSeconds: number = DEFAULT_MTIME_GUARD_SECONDS,
  nowMs: number = Date.now()
): string | null {
  const projectDir = join(projectsDir, encodeProjectDir(cwd));
  if (!existsSync(projectDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return null;
  }

  const candidates: JsonlCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    if (name.startsWith('agent-')) continue;
    const path = join(projectDir, name);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      candidates.push({ name, path, mtimeMs });
    } catch {
      // skip stat errors
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 1) {
    // Only one JSONL — assume it's the previous session (best-effort).
    return candidates[0].path;
  }

  const guardMs = mtimeGuardSeconds * 1000;
  const mostRecentAgeMs = nowMs - candidates[0].mtimeMs;

  if (mostRecentAgeMs < guardMs) {
    // Most-recent file is suspiciously fresh — likely the new in-progress
    // session. Return the next one.
    return candidates[1].path;
  }

  // Most-recent file is older than the guard — there is no in-progress
  // session yet (this `clear` event preceded new-session JSONL creation),
  // so the "previous" we want IS the most-recent.
  return candidates[0].path;
}
