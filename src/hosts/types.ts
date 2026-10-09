export type NativeHostId = 'claude' | 'opencode' | 'pi';

export interface McpConfigTarget {
  host: NativeHostId;
  path: string;
  /** Path from the JSON root to the recall-memory environment object. */
  envPath: string[];
}

export interface NativeHostAdapter {
  id: NativeHostId;
  displayName: string;
  mcpConfigTargets(home: string): McpConfigTarget[];
}
