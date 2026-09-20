import type { HostTranscriptMessage } from '../lib/host-ingest.js';

interface JsonObject {
  [key: string]: unknown;
}

export interface ParsedOmpSession {
  messages: HostTranscriptMessage[];
}

const SKIP_ROLES: Record<string, true> = {
  developer: true, system: true, toolResult: true, bashExecution: true,
  pythonExecution: true, fileMention: true, hookMessage: true,
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformedEntry(): never {
  throw new Error('omp lifecycle capture received a malformed session entry');
}

function parseMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) malformedEntry();
  const parts: string[] = [];
  for (const part of content) {
    if (!isObject(part) || typeof part.type !== 'string' || !part.type) malformedEntry();
    if (part.type !== 'text') continue;
    if (typeof part.text !== 'string') malformedEntry();
    if (part.text) parts.push(part.text);
  }
  return parts.join('\n');
}

/** Parse an omp getBranch() array into user/assistant text with native ids. */
export function parseOmpSession(entries: unknown): ParsedOmpSession {
  if (!Array.isArray(entries)) {
    throw new Error('omp lifecycle capture requires an entries array');
  }

  const messages: HostTranscriptMessage[] = [];
  const seenIds = new Set<string>();

  for (const [sourcePosition, entry] of entries.entries()) {
    if (!isObject(entry) || typeof entry.type !== 'string' || !entry.type) {
      malformedEntry();
    }
    const nativeId = typeof entry.id === 'string' && entry.id ? entry.id : undefined;
    if (nativeId) {
      if (seenIds.has(nativeId)) {
        throw new Error('omp lifecycle capture received duplicate native ids');
      }
      seenIds.add(nativeId);
    }
    if (entry.type !== 'message') continue;
    if (!nativeId || !isObject(entry.message) || typeof entry.message.role !== 'string'
      || !entry.message.role) {
      malformedEntry();
    }
    if (Object.hasOwn(SKIP_ROLES, entry.message.role)) continue;
    if (entry.message.role !== 'user' && entry.message.role !== 'assistant') {
      malformedEntry();
    }
    const content = parseMessageText(entry.message.content);
    if (!content.trim()) continue;
    messages.push({
      role: entry.message.role,
      content,
      timestamp: typeof entry.timestamp === 'string' && entry.timestamp
        ? entry.timestamp
        : undefined,
      nativeId,
      sourcePosition,
    });
  }

  return { messages };
}
