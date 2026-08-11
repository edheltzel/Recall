import type { HostTranscriptMessage } from '../lib/host-ingest.js';

export interface ParsedGrokExport {
  messages: HostTranscriptMessage[];
}

function headingRole(line: string): 'user' | 'assistant' | undefined {
  const heading =
    line.match(/^#{1,6}\s*(?:message\s+\d+\s*[-:]\s*)?(user|human|assistant|grok)\s*$/i)?.[1] ??
    line.match(/^\*\*(user|human|assistant|grok)\s*:\*\*\s*$/i)?.[1];
  if (!heading) return undefined;
  return /^(user|human)$/i.test(heading) ? 'user' : 'assistant';
}

/** Parse the public `grok export <sessionId>` Markdown surface. */
export function parseGrokExport(markdown: string): ParsedGrokExport {
  const messages: HostTranscriptMessage[] = [];
  let role: 'user' | 'assistant' | undefined;
  let body: string[] = [];

  const flush = () => {
    const content = body.join('\n').trim();
    if (role && content) messages.push({ role, content });
    body = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const nextRole = headingRole(line);
    if (nextRole) {
      flush();
      role = nextRole;
      continue;
    }
    if (role) body.push(line);
  }
  flush();

  return { messages };
}
