import type { HostTranscriptMessage } from '../lib/host-ingest.js';

export interface ParsedGrokExport {
  messages: HostTranscriptMessage[];
}

/** Parse the public `grok export <sessionId>` Markdown surface. */
export function parseGrokExport(markdown: string): ParsedGrokExport {
  if (!markdown.trim()) return { messages: [] };
  const messages: HostTranscriptMessage[] = [];
  const delimiter = /\r?\n[ \t]*\r?\n/g;
  let start = 0;
  for (const match of markdown.matchAll(delimiter)) {
    const delimiterStart = match.index ?? start;
    if (delimiterStart > start) {
      messages.push({ role: 'system', content: markdown.slice(start, delimiterStart) });
    }
    messages.push({ role: 'system', content: match[0] });
    const end = delimiterStart + match[0].length;
    start = end;
  }
  if (start < markdown.length) {
    messages.push({ role: 'system', content: markdown.slice(start) });
  }
  return { messages };
}
