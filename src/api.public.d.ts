/**
 * Public types for `recall-memory/api`. Copied to dist/api.d.ts by the build.
 * Keep in sync with src/api.ts and src/lib/harness-seams.ts.
 */

export type HarnessSeam = 'start' | 'drop' | 'capture' | 'inject';
export const HARNESS_SEAMS: readonly HarnessSeam[];

export type BuiltinStartFormat = 'markdown' | 'cursor';
export const BUILTIN_START_FORMATS: readonly BuiltinStartFormat[];
export type SessionStartFormat = BuiltinStartFormat;
export type StartFormatWrapper = (context: string) => string;

export interface StartOptions {
  format?: string;
}

export const MEMORY_UNAVAILABLE: string;
export const MARKDOWN_DROP_DIR_SUFFIX: '-sessions';
export const CURSOR_SESSION_START_COMMAND: 'recall start --format cursor';
export const CURSOR_MCP_COMMAND: 'recall-mcp';
export const CURSOR_MCP_SERVER_NAME: 'recall-memory';

export const SESSION_SOURCES: readonly [
  'claude',
  'opencode',
  'pi',
  'codex',
  'grok',
  'jcode',
  'cursor',
  'mcp',
];
export type SessionSource = (typeof SESSION_SOURCES)[number];

export interface Message {
  id?: number;
  session_id: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  project?: string;
  importance?: number;
}

export interface ParsedSession {
  source: string;
  sessionId: string;
  project: string;
  messages: Omit<Message, 'id'>[];
  filePath: string;
}

export interface SessionSourceAdapter {
  id: string;
  discover(): ParsedSession | null;
}

export interface MarkdownDropFile {
  path: string;
  size: number;
  project: string;
  mtime: number;
}

export type CursorStoreKind = 'ide-vscdb' | 'cli-jsonl' | 'chats-blob';
export type CursorCatalogQuality = 'transcript' | 'breadcrumbs';

export interface CursorCatalogSession {
  store: CursorStoreKind;
  sessionId: string;
  workspace?: string;
  project?: string;
  createdAt?: string;
  updatedAt?: string;
  size: number;
  messageCount: number;
  sourcePath: string;
  quality: CursorCatalogQuality;
}

export interface CursorCatalogOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  ideUserDir?: string;
  cliRoot?: string;
  maxWorkspaceDbs?: number;
}

export function registerStartFormat(id: string, wrap: StartFormatWrapper): () => void;
export function getRegisteredStartFormat(id: string): StartFormatWrapper | undefined;
export function listStartFormats(): string[];
export function registerSessionSource(adapter: SessionSourceAdapter): () => void;
export function registeredSessionSources(): readonly SessionSourceAdapter[];
export function describeHarnessSeams(): {
  readonly seams: readonly HarnessSeam[];
  readonly start: {
    readonly cli: 'recall start';
    readonly formats: string[];
    readonly assembler: 'hooks/lib/session-start-context.ts';
  };
  readonly drop: {
    readonly dir: 'MEMORY/<host>-sessions/';
    readonly parser: 'parseMarkdownDrop';
    readonly note: string;
  };
  readonly capture: {
    readonly cursor: 'catalogCursorSessions';
    readonly dump: 'discoverCurrentSession';
    readonly hostHook: string;
  };
  readonly inject: {
    readonly cursorCommand: 'recall start --format cursor';
    readonly cursorWrapper: '{ additional_context }';
    readonly note: string;
  };
  readonly mcp: { readonly server: 'recall-memory'; readonly bin: 'recall-mcp' };
  readonly skills: { readonly canonical: 'agent-skills/' };
  readonly nonGoals: readonly string[];
};

export function runStart(options?: StartOptions): void;
export function gatherContext(): string;
export function renderSessionStart(format?: SessionStartFormat): string;
export function wrapCursorSessionStart(context: string): string;

export function parseMarkdownDrop(filePath: string): { sessionId: string; messages: Omit<Message, 'id'>[] } | null;
export function discoverMarkdownDropSession(dropDir: string, source: string, project?: string): ParsedSession | null;
export function findLatestMarkdownDrop(dropDir: string): string | null;
export function listMarkdownDropDirs(memoryDir: string): Array<{ host: string; dir: string }>;
export function markdownDropDirName(hostId: string): string;

export function catalogCursorSessions(options?: CursorCatalogOptions): CursorCatalogSession[];
export function mergeCursorHooksJson(existing: unknown): {
  version: number;
  hooks: Record<string, unknown[]>;
};
export function cursorMcpSnippet(): Record<string, unknown>;

export function discoverCurrentSession(adapters?: readonly SessionSourceAdapter[]): ParsedSession | null;
export const nativeSessionSources: readonly SessionSourceAdapter[];
