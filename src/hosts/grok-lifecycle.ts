import type { HostTranscriptMessage } from '../lib/host-ingest.js';

export interface ParsedGrokExport {
  messages: HostTranscriptMessage[];
}

function headingRole(
  line: string,
  expectedOrdinal: number
): 'user' | 'assistant' | undefined {
  const heading = line.match(/^## Message (\d+) - (User|Assistant|Grok)$/i);
  if (!heading || Number(heading[1]) !== expectedOrdinal) return undefined;
  return /^user$/i.test(heading[2]) ? 'user' : 'assistant';
}

/** Parse the public `grok export <sessionId>` Markdown surface. */
export function parseGrokExport(markdown: string): ParsedGrokExport {
  const messages: HostTranscriptMessage[] = [];
  let role: 'user' | 'assistant' | undefined;
  let body: string[] = [];
  let expectedOrdinal = 1;

  const flush = () => {
    const content = body.join('\n').trim();
    if (role && content) messages.push({ role, content });
    body = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const nextRole = headingRole(line, expectedOrdinal);
    if (nextRole) {
      flush();
      role = nextRole;
      expectedOrdinal++;
      continue;
    }
    if (role) body.push(line);
  }
  flush();

  return { messages };
}
