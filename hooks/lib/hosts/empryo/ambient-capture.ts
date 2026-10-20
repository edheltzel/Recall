// Empryo ambient capture. Empryo runs the Claude hooks registered in
// ~/.claude/settings.json and hands them its own session log as
// `transcript_path` (<project>/.empryo/sessions/<id>/session.jsonl). That log is
// not Claude JSONL, so RecallExtract routes it here instead of to the Claude
// parser and never falls back to an unrelated Claude transcript.
//
// Setup, supported events, and capture limits: docs/EMPRYO_INTEGRATION.md.

import { readFileSync, statSync } from 'fs';
import { basename, dirname } from 'path';
import {
  CAPTURE_MAX_BYTES,
  capturePayload,
  cleanId,
  isSessionEndHook,
  payloadBytes,
  type CaptureHints,
  type CapturePayload,
} from '../capture-door';

export type EmpryoCapturePayload = CapturePayload<'empryo'>;

const EMPRYO_SESSION_LOG = /[\\/]\.empryo[\\/]sessions[\\/][^\\/]+[\\/]session\.jsonl$/;
const SUPPORTED_LOG_VERSION = 1;
const TURN_SEPARATOR = '\n\n';
const RECENT_TAB_MS = 10 * 60 * 1000;
// The log also holds tool calls, so it can outgrow the capture text cap.
const LOG_MAX_BYTES = 128 * 1024 * 1024;

interface EmpryoLine {
  k?: unknown;
  v?: unknown;
  id?: unknown;
  cwd?: unknown;
  tabId?: unknown;
  turnId?: unknown;
  status?: unknown;
  ts?: unknown;
  ui?: { content?: unknown; hidden?: unknown };
}

interface Turn {
  tabId: string;
  prompt?: string;
  answer?: string;
  completedAt: number;
}

interface CompletedTurn {
  tabId: string;
  completedAt: number;
  text: string;
}

interface ParsedLog {
  sessionId?: string;
  cwd?: string;
  turns: CompletedTurn[];
}

export function isEmpryoTranscript(path: string | undefined): boolean {
  return typeof path === 'string' && EMPRYO_SESSION_LOG.test(path);
}

function contentText(line: EmpryoLine): string {
  return typeof line.ui?.content === 'string' ? line.ui.content.trim() : '';
}

function parseLog(path: string): ParsedLog | null {
  let raw: string;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > LOG_MAX_BYTES) return null;
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let versioned = false;
  const turns = new Map<string, Turn>();

  for (const row of raw.split('\n')) {
    if (!row.trim()) continue;
    let line: EmpryoLine;
    try {
      line = JSON.parse(row);
    } catch {
      continue;
    }
    if (line.k === 'meta') {
      if (line.v !== SUPPORTED_LOG_VERSION) return null;
      versioned = true;
      sessionId = cleanId(line.id);
      if (typeof line.cwd === 'string' && line.cwd) cwd = line.cwd;
      continue;
    }
    if (line.k !== 'user' && line.k !== 'assistant') continue;
    if (typeof line.tabId !== 'string' || typeof line.turnId !== 'string') continue;
    const text = contentText(line);
    if (!text) continue;
    const key = `${line.tabId}\u0000${line.turnId}`;
    const turn = turns.get(key) ?? { tabId: line.tabId, completedAt: Number.POSITIVE_INFINITY };
    if (line.k === 'user') {
      if (line.ui?.hidden === true) continue;
      turn.prompt ??= text;
    } else {
      if (line.status !== 'complete') continue;
      turn.answer = text;
      turn.completedAt = typeof line.ts === 'number' ? line.ts : turns.size;
    }
    turns.set(key, turn);
  }
  if (!versioned) return null;

  const ordered = [...turns.values()]
    .filter((turn): turn is Required<Turn> => Boolean(turn.prompt && turn.answer))
    .sort((a, b) => a.completedAt - b.completedAt)
    .map(turn => ({
      tabId: turn.tabId,
      completedAt: turn.completedAt,
      text: `user: ${turn.prompt}${TURN_SEPARATOR}assistant: ${turn.answer}`,
    }));
  return { sessionId, cwd, turns: ordered };
}

/** Escaped size of `text` inside a JSON string, without its quotes. */
function jsonTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf-8') - 2;
}

/**
 * Every turn when the serialized payload fits the capture cap, else the newest
 * turns that do. The budget is the JSON stdin `recall capture` reads, so escaping
 * and metadata count, not just raw text.
 */
function sessionEndPayload(
  turns: string[],
  sessionId: string | undefined,
  cwd: string | undefined,
): EmpryoCapturePayload | null {
  const probe = capturePayload('empryo', 'session_end', 'x', sessionId, cwd);
  if (!probe) return null;
  let bytes = payloadBytes(probe) - 1;
  const separator = jsonTextBytes(TURN_SEPARATOR);
  const kept: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const next = bytes + jsonTextBytes(turns[i]) + (kept.length ? separator : 0);
    if (next > CAPTURE_MAX_BYTES) break;
    bytes = next;
    kept.unshift(turns[i]);
  }
  return capturePayload('empryo', 'session_end', kept.join(TURN_SEPARATOR), sessionId, cwd);
}

/** Payloads an Empryo Stop / SessionEnd hook sends for this session log. */
export function empryoHookPayloads(path: string, hints?: CaptureHints): EmpryoCapturePayload[] {
  const parsed = parseLog(path);
  if (!parsed || parsed.turns.length === 0) return [];
  const sessionId = parsed.sessionId ?? cleanId(hints?.sessionId) ?? cleanId(basename(dirname(path)));
  const cwd = hints?.cwd || parsed.cwd;
  if (isSessionEndHook(hints?.hookEvent)) {
    const ended = sessionEndPayload(parsed.turns.map(turn => turn.text), sessionId, cwd);
    return ended ? [ended] : [];
  }
  const newest = parsed.turns[parsed.turns.length - 1].completedAt;
  const latestPerTab = new Map<string, CompletedTurn>();
  for (const turn of parsed.turns) {
    if (newest - turn.completedAt <= RECENT_TAB_MS) latestPerTab.set(turn.tabId, turn);
  }
  return [...latestPerTab.values()]
    .sort((a, b) => a.completedAt - b.completedAt)
    .map(turn => capturePayload('empryo', 'turn_end', turn.text, sessionId, cwd))
    .filter((payload): payload is EmpryoCapturePayload => payload !== null);
}
