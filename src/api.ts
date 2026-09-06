/**
 * Public library surface for harness authors (`recall-memory/api`).
 *
 * Re-exports existing start / drop / capture / inject seams plus in-process
 * register hooks. Import this module; do not fork `src/` or add a Cursor
 * marketplace plugin.
 */

export {
  BUILTIN_START_FORMATS,
  HARNESS_SEAMS,
  describeHarnessSeams,
  getRegisteredStartFormat,
  listStartFormats,
  registerSessionSource,
  registerStartFormat,
  registeredSessionSources,
  type BuiltinStartFormat,
  type HarnessSeam,
  type StartFormatWrapper,
} from './lib/harness-seams.js';

export {
  MEMORY_UNAVAILABLE,
  gatherContext,
  renderSessionStart,
  runStart,
  wrapCursorSessionStart,
  type SessionStartFormat,
  type StartOptions,
} from './commands/start.js';

export {
  MARKDOWN_DROP_DIR_SUFFIX,
  discoverMarkdownDropSession,
  findLatestMarkdownDrop,
  listMarkdownDropDirs,
  markdownDropDirName,
  parseMarkdownDrop,
  type MarkdownDropFile,
} from './hosts/markdown-session-source.js';

export {
  catalogCursorSessions,
  type CursorCatalogOptions,
  type CursorCatalogSession,
} from './hosts/cursor-capture.js';
export {
  CURSOR_MCP_COMMAND,
  CURSOR_MCP_SERVER_NAME,
  CURSOR_SESSION_START_COMMAND,
  cursorMcpSnippet,
  mergeCursorHooksJson,
} from './hosts/cursor-inject.js';

export {
  discoverCurrentSession,
  nativeSessionSources,
} from './hosts/session-sources.js';
export {
  SESSION_SOURCES,
  type ParsedSession,
  type SessionSource,
  type SessionSourceAdapter,
} from './hosts/session-source.js';
