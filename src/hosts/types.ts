export type NativeHostId = 'claude' | 'opencode' | 'pi';

export interface McpConfigTarget {
  host: NativeHostId;
  path: string;
  /** Path from the JSON root to the recall-memory environment object. */
  envPath: string[];
  /** OpenCode permits comments; the other current targets are strict JSON. */
  format: 'json' | 'jsonc';
}

export interface NativeHostAdapter {
  id: NativeHostId;
  displayName: string;
  mcpConfigTargets(home: string): McpConfigTarget[];
}
