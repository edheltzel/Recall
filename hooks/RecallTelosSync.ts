#!/usr/bin/env bun
/**
 * RecallTelosSync.ts - Auto-import TELOS files when they change
 *
 * TRIGGER: SessionStart (no matcher — runs every session)
 *
 * Compares max mtime of TELOS directory files against a stored timestamp.
 * If any file is newer, runs a silent import with --update.
 * Designed to complete in < 50ms when no changes detected.
 *
 * SELF-CONTAINED: This hook is copied to ~/.claude/hooks/ and runs
 * independently. It does not import from src/.
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const HOME = process.env.HOME || '/Users/ed';
const TELOS_DIR = join(HOME, '.claude', 'skills', 'PAI', 'USER', 'TELOS');
const MEMORY_DIR = join(HOME, '.claude', 'MEMORY');
const MTIME_FILE = join(MEMORY_DIR, '.telos_last_import');

function getTelosDirMtime(): number {
  if (!existsSync(TELOS_DIR)) return 0;
  const files = readdirSync(TELOS_DIR).filter(f => f.endsWith('.md'));
  let maxMtime = 0;
  for (const file of files) {
    const mtime = statSync(join(TELOS_DIR, file)).mtimeMs;
    if (mtime > maxMtime) maxMtime = mtime;
  }
  return maxMtime;
}

function getLastImportTime(): number {
  try {
    return parseInt(readFileSync(MTIME_FILE, 'utf-8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function findMem(): string | null {
  const candidates = [
    join(HOME, '.bun', 'bin', 'recall'),
    '/usr/local/bin/recall',
    '/opt/homebrew/bin/recall',
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Fallback: which
  try {
    return execFileSync('which', ['recall'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

// Main
const dirMtime = getTelosDirMtime();
const lastImport = getLastImportTime();

if (dirMtime > lastImport) {
  const memPath = findMem();

  if (memPath) {
    try {
      execFileSync(memPath, ['telos', 'import', '--update', '--yes'], {
        timeout: 10_000,
        stdio: 'ignore',
      });
      // Update timestamp
      mkdirSync(MEMORY_DIR, { recursive: true });
      writeFileSync(MTIME_FILE, Date.now().toString());
    } catch {
      // Silent failure — next session will retry
    }
  }
}
