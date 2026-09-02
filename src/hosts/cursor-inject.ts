/**
 * Cursor inject wire: sessionStart `{ additional_context }` via hooks.json
 * + MCP + a user rule. Calls the shared `recall start` assembler.
 *
 * Must not use Codex `hookSpecificOutput.additionalContext`.
 * Must not auto-install onto the user's machine; merge is a library used by
 * snippets/tests. Cursor never joins `recall host-hook`.
 */

export const CURSOR_SESSION_START_COMMAND = 'recall start --format cursor';
export const CURSOR_MCP_COMMAND = 'recall-mcp';
export const CURSOR_MCP_SERVER_NAME = 'recall-memory';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function commandOf(entry: unknown): string {
  if (!isObject(entry)) return '';
  return typeof entry.command === 'string' ? entry.command : '';
}

function isRecallSessionStart(entry: unknown): boolean {
  return commandOf(entry).includes('recall start');
}

/**
 * Idempotent merge of a Recall sessionStart hook into a Cursor hooks.json
 * document. Preserves unrelated hooks and does not duplicate Recall's entry.
 */
export function mergeCursorHooksJson(existing: unknown): {
  version: number;
  hooks: Record<string, unknown[]>;
} {
  const base = isObject(existing) ? { ...existing } : {};
  const hooks = isObject(base.hooks) ? { ...base.hooks } : {};
  const current = Array.isArray(hooks.sessionStart) ? [...hooks.sessionStart] : [];
  if (!current.some(isRecallSessionStart)) {
    current.push({ command: CURSOR_SESSION_START_COMMAND });
  }
  return {
    ...base,
    version: typeof base.version === 'number' ? base.version : 1,
    hooks: {
      ...hooks,
      sessionStart: current,
    },
  };
}

export function cursorMcpSnippet(): Record<string, unknown> {
  return {
    mcpServers: {
      [CURSOR_MCP_SERVER_NAME]: {
        command: CURSOR_MCP_COMMAND,
        args: [],
      },
    },
  };
}
