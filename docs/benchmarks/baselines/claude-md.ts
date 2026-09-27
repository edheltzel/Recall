// CLAUDE.md baseline — measures the size of the static memory layer that
// every Claude Code user has by default. This is the realistic comparison
// point for Recall (not "no memory at all"). See the plan's Phase 2 framing.
//
// We do not interpret the content — only its size. CLAUDE.md is hand-written;
// fairness across users is bounded by their authoring discipline.

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ClaudeMdSnapshot {
  globalChars: number;
  globalPath: string | null;
  projectChars: number;
  projectPath: string | null;
  totalChars: number;
}

/**
 * Read the global ~/.claude/CLAUDE.md and a project-local CLAUDE.md (if
 * present in the cwd or one parent up). Returns char counts without
 * inspecting content. Missing files contribute zero, not an error.
 */
export function snapshotClaudeMd(cwd: string = process.cwd()): ClaudeMdSnapshot {
  const globalPath = join(homedir(), '.claude', 'CLAUDE.md');
  const projectPath = findProjectClaudeMd(cwd);

  const globalChars = readChars(globalPath);
  const projectChars = projectPath ? readChars(projectPath) : 0;

  return {
    globalChars,
    globalPath: existsSync(globalPath) ? globalPath : null,
    projectChars,
    projectPath: projectPath && existsSync(projectPath) ? projectPath : null,
    totalChars: globalChars + projectChars,
  };
}

function readChars(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    const stat = statSync(path);
    if (!stat.isFile()) return 0;
    return readFileSync(path, 'utf-8').length;
  } catch {
    return 0;
  }
}

function findProjectClaudeMd(cwd: string): string | null {
  const candidates = [
    join(cwd, 'CLAUDE.md'),
    join(cwd, '..', 'CLAUDE.md'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
