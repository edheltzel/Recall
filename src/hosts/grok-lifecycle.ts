import type { HostTranscriptMessage } from '../lib/host-ingest.js';

export interface ParsedGrokExport {
  messages: HostTranscriptMessage[];
}

function canonicalFrameIdentity(content: string): string {
  return content
    .replace(/^(?:[ \t]*\r?\n)+[ \t]*/, '')
    .replace(/[ \t]*(?:\r?\n[ \t]*)+$/, '');
}

/** Parse the public `grok export <sessionId>` Markdown surface. */
export function parseGrokExport(
  markdown: string,
  options: { sourceOffset?: number } = {}
): ParsedGrokExport {
  const messages: HostTranscriptMessage[] = [];
  const delimiter = /\r?\n[ \t]*\r?\n/g;
  const sourceOffset = options.sourceOffset ?? 0;
  let contentStart = 0;
  let pendingStart: number | undefined;
  let positionIndex = 0;
  let positionBytes = sourceOffset;

  const sourcePosition = (index: number): number => {
    positionBytes += Buffer.byteLength(markdown.slice(positionIndex, index));
    positionIndex = index;
    return positionBytes;
  };

  const append = (start: number, end: number): boolean => {
    if (end <= start) return false;
    const content = markdown.slice(start, end);
    if (!content.trim()) return false;
    messages.push({
      role: 'system',
      content,
      identityContent: canonicalFrameIdentity(content),
      sourcePosition: sourcePosition(start),
    });
    return true;
  };

  for (const match of markdown.matchAll(delimiter)) {
    const delimiterStart = match.index ?? contentStart;
    const appended = append(pendingStart ?? contentStart, delimiterStart);
    if (pendingStart === undefined || appended) pendingStart = delimiterStart;
    contentStart = delimiterStart + match[0].length;
  }

  if (markdown.slice(contentStart).trim()) {
    append(pendingStart ?? contentStart, markdown.length);
  } else if (messages.length > 0 && (pendingStart !== undefined || contentStart < markdown.length)) {
    const last = messages[messages.length - 1];
    const trailingStart = pendingStart ?? contentStart;
    last.content += markdown.slice(trailingStart);
    last.identityContent = canonicalFrameIdentity(last.content);
  } else {
    append(0, markdown.length);
  }

  return { messages };
}
