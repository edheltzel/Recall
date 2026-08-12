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
  let pending = '';
  const append = (content: string) => {
    if (content.trim()) {
      messages.push({ role: 'system', content: pending + content });
      pending = '';
    } else if (messages.length > 0) {
      messages[messages.length - 1].content += content;
    } else {
      pending += content;
    }
  };
  for (const match of markdown.matchAll(delimiter)) {
    const end = (match.index ?? start) + match[0].length;
    append(markdown.slice(start, end));
    start = end;
  }
  append(markdown.slice(start));
  return { messages };
}
