#!/usr/bin/env bun
// Claude ambient capture. Shells out to `recall capture`. Does not import src/
// and does not write recall.db. Automatic-capture LoA extraction stays in
// RecallExtract.ts.
//
// Stop, when the transcript has a user turn: one turn_end payload, latest turn.
// No turn boundary, or hook event SessionEnd: one session_end payload.
//
// TranscriptWatcher fallback (no Claude hooks):
//   bun hooks/lib/hosts/claude/ambient-capture.ts [projects-dir]
// Discovers ~/.claude/projects/*/*.jsonl (skips agent-* unless
// RECALL_INCLUDE_SUBAGENTS=1) and emits the same payload shape as Stop,
// one event per turn so a single run covers the file.
// ponytail: one project-dir level, Claude's layout; recurse if a host nests jsonl.

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';

export const CAPTURE_MAX_BYTES = 25 * 1024 * 1024;

export interface CapturePayload {
  contract: 1;
  harness: 'claude';
  event: 'turn_end' | 'session_end';
  text: string;
  session_id?: string;
  cwd?: string;
  project?: string;
}

export interface CaptureHints {
  sessionId?: string;
  cwd?: string;
  hookEvent?: string;
}

interface TurnPart {
  role: string;
  text: string;
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block) || !('text' in block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text);
    }
    return parts.join('\n').trim();
  }
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text.trim();
  }
  return '';
}

function capturePayload(
  event: 'turn_end' | 'session_end',
  text: string,
  sessionId: string | undefined,
  cwd: string | undefined,
): CapturePayload | null {
  if (!text.trim() || Buffer.byteLength(text, 'utf-8') > CAPTURE_MAX_BYTES) return null;
  const body: CapturePayload = { contract: 1, harness: 'claude', event, text };
  if (sessionId) body.session_id = sessionId;
  if (cwd) body.cwd = cwd;
  const project = cwd ? basename(cwd) : '';
  if (project && project !== '/' && project !== '.') body.project = project;
  return body;
}

interface ParsedTranscript {
  sessionId?: string;
  cwd?: string;
  turns: TurnPart[][];
  loose: TurnPart[];
}

function parseTranscript(jsonlPath: string): ParsedTranscript | null {
  let info;
  try {
    info = statSync(jsonlPath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > CAPTURE_MAX_BYTES) return null;

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, 'utf-8');
  } catch {
    return null;
  }

  const turns: TurnPart[][] = [];
  const loose: TurnPart[] = [];
  let current: TurnPart[] | null = null;
  let sessionId: string | undefined;
  let cwd: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: {
      sessionId?: unknown;
      cwd?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId ??= cleanId(entry.sessionId);
    if (!cwd && typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd;
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textFromContent(entry.message?.content);
    if (!text) continue;
    if (role === 'user') {
      if (current && current.length) turns.push(current);
      current = [{ role, text }];
    } else if (current) {
      current.push({ role, text });
    } else {
      loose.push({ role, text });
    }
  }
  if (current && current.length) turns.push(current);
  return { sessionId, cwd, turns, loose };
}


/** One payload per turn. No user turn: a single session_end of leftover text. */
export function payloadsForTranscript(jsonlPath: string, hints?: CaptureHints): CapturePayload[] {
  const parsed = parseTranscript(jsonlPath);
  if (!parsed) return [];
  const sessionId = parsed.sessionId ?? cleanId(hints?.sessionId) ?? cleanId(basename(jsonlPath, '.jsonl'));
  const cwd = hints?.cwd || parsed.cwd;
  if (parsed.turns.length === 0) {
    const only = capturePayload('session_end', parsed.loose.map(part => `${part.role}: ${part.text}`).join('\n\n'), sessionId, cwd);
    return only ? [only] : [];
  }
  const payloads: CapturePayload[] = [];
  for (const turn of parsed.turns) {
    const item = capturePayload('turn_end', turn.map(part => `${part.role}: ${part.text}`).join('\n\n'), sessionId, cwd);
    if (item) payloads.push(item);
  }
  return payloads;
}

/** Payload a Stop / SessionEnd hook sends for this file. */
export function claudeHookPayload(jsonlPath: string, hints?: CaptureHints): CapturePayload | null {
  const turns = payloadsForTranscript(jsonlPath, hints);
  if (turns.length === 0) return null;
  const sessionEnd = (hints?.hookEvent ?? '').replace(/[_-]/g, '').toLowerCase() === 'sessionend';
  if (!sessionEnd) return turns[turns.length - 1];
  if (turns.length === 1 && turns[0].event === 'session_end') return turns[0];
  return capturePayload(
    'session_end',
    turns.map(turn => turn.text).join('\n\n'),
    turns[0].session_id,
    turns[0].cwd,
  );
}

export function discoverClaudeJsonl(projectsDir: string): string[] {
  if (!existsSync(projectsDir)) return [];
  const includeSubagents = process.env.RECALL_INCLUDE_SUBAGENTS === '1';
  const files: string[] = [];
  for (const project of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, project);
    let dirInfo;
    try {
      dirInfo = statSync(projectDir);
    } catch {
      continue;
    }
    if (!dirInfo.isDirectory()) continue;
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue;
      if (!includeSubagents && name.startsWith('agent-')) continue;
      const path = join(projectDir, name);
      try {
        const info = statSync(path);
        if (!info.isFile() || info.size > CAPTURE_MAX_BYTES) continue;
      } catch {
        continue;
      }
      files.push(path);
    }
  }
  files.sort();
  return files;
}

export function discoverClaudePayloads(projectsDir: string, hints?: CaptureHints): CapturePayload[] {
  const payloads: CapturePayload[] = [];
  for (const path of discoverClaudeJsonl(projectsDir)) {
    payloads.push(...payloadsForTranscript(path, hints));
  }
  return payloads;
}

/** Fail-soft. A missing `recall` or a rejected payload must not fail the hook. */
export function runRecallCapture(body: CapturePayload): boolean {
  try {
    const input = JSON.stringify(body);
    if (Buffer.byteLength(input, 'utf-8') > CAPTURE_MAX_BYTES) return false;
    const result = spawnSync('recall', ['capture'], {
      input,
      encoding: 'utf-8',
      timeout: 15_000,
      // bun ignores a PATH change unless env is passed through.
      env: process.env,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const projectsDir = process.argv[2] || join(process.env.HOME || homedir(), '.claude', 'projects');
  let failed = 0;
  for (const item of discoverClaudePayloads(projectsDir)) {
    if (!runRecallCapture(item)) failed++;
  }
  if (failed) process.stderr.write(`Recall claude capture failed for ${failed} payload(s)\n`);
  process.exit(0);
}
