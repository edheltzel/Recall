import type { EventKind } from '../../events';

export interface ClaudeHookEventInput {
  hook_event_name?: string;
  prompt?: unknown;
  tool_name?: unknown;
}

/** Normalize Claude Code hook payloads before they reach host-neutral logic. */
export function eventFromClaudeHookInput(input: ClaudeHookEventInput): EventKind | null {
  if (input.hook_event_name === 'UserPromptSubmit') return 'turn';
  if (input.hook_event_name === 'PostToolUse') return 'tool';
  if (typeof input.prompt === 'string') return 'turn';
  if (typeof input.tool_name === 'string') return 'tool';
  return null;
}
