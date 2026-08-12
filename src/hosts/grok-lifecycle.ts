import type { HostTranscriptMessage } from '../lib/host-ingest.js';

export interface ParsedGrokExport {
  messages: HostTranscriptMessage[];
}

/** Parse the public `grok export <sessionId>` Markdown surface. */
export function parseGrokExport(markdown: string): ParsedGrokExport {
  if (!markdown.trim()) return { messages: [] };
  return { messages: [{ role: 'system', content: markdown }] };
}
