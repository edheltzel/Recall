import { claudeHost } from './claude.js';
import { openCodeHost } from './opencode.js';
import { piHost } from './pi.js';

export type { McpConfigTarget, NativeHostAdapter, NativeHostId } from './types.js';
export { claudeHost, openCodeHost, piHost };

/** Native config adapters with a currently verified JSON ownership contract. */
export const configurableHosts = [claudeHost, openCodeHost, piHost] as const;
