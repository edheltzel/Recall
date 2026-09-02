/**
 * Shared markdown drop-dir ingest.
 *
 * OpenCode and Pi (and any later drop-dir host) write markdown transcripts
 * into MEMORY/<host>-sessions/. Adding a third drop-dir host means dropping
 * files into a new `*-sessions` directory — not copying RecallExtract.ts or
 * RecallPreCompact.ts. Host parsers stay host-owned.
 *
 * Do not fold this pipe into `src/lib/host-ingest.ts` (that seam is Codex
 * live ingest).
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export const MARKDOWN_DROP_DIR_SUFFIX = '-sessions';

export interface MarkdownDropFile {
  path: string;
  size: number;
  project: string;
  mtime: number;
}

export function markdownDropHostId(dirName: string): string | null {
  if (!dirName.endsWith(MARKDOWN_DROP_DIR_SUFFIX)) return null;
  const host = dirName.slice(0, -MARKDOWN_DROP_DIR_SUFFIX.length);
  return host || null;
}

export function markdownDropDirName(hostId: string): string {
  return `${hostId}${MARKDOWN_DROP_DIR_SUFFIX}`;
}

/** Scan MEMORY/*-sessions directories. Missing MEMORY is an empty list. */
export function listMarkdownDropDirs(memoryDir: string): Array<{ host: string; dir: string }> {
  if (!existsSync(memoryDir)) return [];
  const found: Array<{ host: string; dir: string }> = [];
  try {
    for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const host = markdownDropHostId(entry.name);
      if (!host) continue;
      found.push({ host, dir: join(memoryDir, entry.name) });
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => a.host.localeCompare(b.host));
}

export function findMarkdownDropFiles(dir: string, project: string): MarkdownDropFile[] {
  const sessions: MarkdownDropFile[] = [];
  if (!existsSync(dir)) return sessions;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    for (const file of files) {
      const fullPath = join(dir, file);
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) continue;
        sessions.push({ path: fullPath, size: stat.size, project, mtime: stat.mtimeMs });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    return sessions;
  }
  return sessions;
}

export function findAllMarkdownDropFiles(memoryDir: string): MarkdownDropFile[] {
  return listMarkdownDropDirs(memoryDir).flatMap(({ host, dir }) => findMarkdownDropFiles(dir, host));
}
