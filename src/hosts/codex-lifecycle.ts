import type { HostTranscriptMessage } from '../lib/host-ingest.js';

interface JsonObject {
  [key: string]: unknown;
}

export interface ParsedCodexRollout {
  messages: HostTranscriptMessage[];
  sessionId?: string;
  cwd?: string;
  isSubagent: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObject)
    .filter(part => ['input_text', 'output_text', 'text'].includes(String(part.type ?? '')))
    .map(part => stringValue(part.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

// Codex injects its own instruction blocks as `response_item` role=user turns
// at session start and again after compaction (the ~20 KB `# AGENTS.md
// instructions for <cwd>` payload, plus the environment/user-instruction
// wrappers). Recall must not store these as verbatim user memory; the typed
// prompt survives as its own user turn (finding F2).
const WRAPPED_INJECTED_USER_TAGS = [
  'recommended_plugins',
  'environment_context',
  'user_instructions',
];

function consumeWrappedInstruction(text: string, offset: number): number | undefined {
  for (const tag of WRAPPED_INJECTED_USER_TAGS) {
    const open = `<${tag}>`;
    if (!text.startsWith(open, offset)) continue;
    const close = `</${tag}>`;
    const end = text.indexOf(close, offset + open.length);
    return end < 0 ? undefined : end + close.length;
  }
  return undefined;
}

function consumeAgentsInstruction(text: string, offset: number): number | undefined {
  if (!text.startsWith('# AGENTS.md instructions for ', offset)) return undefined;
  const headerEnd = text.indexOf('\n', offset);
  if (headerEnd < 0) return text.length;
  let bodyStart = headerEnd + 1;
  while (/\s/.test(text[bodyStart] ?? '')) bodyStart++;
  const open = '<INSTRUCTIONS>';
  if (!text.startsWith(open, bodyStart)) return text.length;
  const close = '</INSTRUCTIONS>';
  const end = text.indexOf(close, bodyStart + open.length);
  return end < 0 ? undefined : end + close.length;
}

function stripInjectedUserInstructions(text: string): string {
  let offset = 0;
  let stripped = false;
  for (;;) {
    while (/\s/.test(text[offset] ?? '')) offset++;
    const next = consumeWrappedInstruction(text, offset) ??
      consumeAgentsInstruction(text, offset);
    if (next === undefined) break;
    offset = next;
    stripped = true;
  }
  return stripped ? text.slice(offset).trimStart() : text;
}

function containsSubagentMarker(value: unknown, depth = 0): boolean {
  if (depth > 5 || !isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (['subagent', 'parent_thread_id', 'parentThreadId'].includes(key)) return true;
    if (containsSubagentMarker(child, depth + 1)) return true;
  }
  return false;
}

/** Parse only Codex rollout response messages, avoiding duplicate event rows. */
export function parseCodexRollout(raw: string): ParsedCodexRollout {
  const messages: HostTranscriptMessage[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let isSubagent = false;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) continue;
      row = parsed;
    } catch {
      continue;
    }

    const payload = isObject(row.payload) ? row.payload : undefined;
    if (row.type === 'session_meta' && payload) {
      sessionId = stringValue(payload.id) ?? stringValue(payload.session_id) ?? sessionId;
      cwd = stringValue(payload.cwd) ?? cwd;
      isSubagent ||= containsSubagentMarker(payload.source) || containsSubagentMarker(payload);
      continue;
    }

    if (row.type !== 'response_item' || !payload || payload.type !== 'message') continue;
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let content = messageText(payload.content);
    if (role === 'user') content = stripInjectedUserInstructions(content);
    if (!content.trim()) continue;
    messages.push({
      role,
      content,
      timestamp: stringValue(row.timestamp),
      nativeId: stringValue(payload.id) ?? stringValue(row.id),
    });
  }

  return { messages, sessionId, cwd, isSubagent };
}
