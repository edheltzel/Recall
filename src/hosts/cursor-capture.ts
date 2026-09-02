/**
 * Cursor capture wire: on-disk catalog of IDE state.vscdb, CLI JSONL, and
 * optional ~/.cursor/chats/<md5(cwd)>/ blobs.
 *
 * Catalog only. Does not insert transcript bodies into Recall SQLite, does
 * not join `recall host-hook` / host-ingest / LifecycleHost, and does not
 * replace JSONL as the CLI transcript source.
 *
 * IDE reads are composerData prefix; messageCount is headers.length.
 * Workspace stays on the session row. They do not LIKE-scan bubbleId rows,
 * look up per-bubble rows, or copy transcript text onto the catalog.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir, platform } from 'os';
import { Database, constants } from 'bun:sqlite';

export type CursorStoreKind = 'ide-vscdb' | 'cli-jsonl' | 'chats-blob';
export type CursorCatalogQuality = 'transcript' | 'breadcrumbs';

/** Production catalog metadata. No transcript body. */
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
  /** Cap on workspaceStorage state.vscdb opens. globalStorage is always included. */
  maxWorkspaceDbs?: number;
}

const COMPOSER_PREFIX = 'composerData:';
const SQLITE_BUSY_MS = 5000;
export const MAX_WORKSPACE_STATE_DBS = 8;

export function cursorIdeUserDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  osPlatform: NodeJS.Platform = platform(),
): string {
  const override = env.RECALL_CURSOR_ROOT?.trim();
  if (override) return override;
  if (osPlatform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User');
  }
  if (env.XDG_CONFIG_HOME?.trim()) {
    return join(env.XDG_CONFIG_HOME, 'Cursor', 'User');
  }
  return join(home, '.config', 'Cursor', 'User');
}

export function cursorCliRoot(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.CURSOR_CONFIG_DIR?.trim()
    || env.RECALL_CURSOR_CLI_ROOT?.trim()
    || join(home, '.cursor');
}

export function decodeCursorProjectDir(encoded: string): string {
  if (!encoded) return encoded;
  if (encoded.startsWith('/')) return encoded;
  return `/${encoded.replace(/-/g, '/')}`;
}

export function cursorChatsDir(cliRoot: string, cwd: string): string {
  const digest = createHash('md5').update(cwd).digest('hex');
  return join(cliRoot, 'chats', digest);
}

/**
 * Walk up from a JSONL path until the directory named `agent-transcripts`,
 * then return its parent basename (`projects/<encoded>`). Nested
 * `agent-transcripts/<session>/<session>.jsonl` layouts stay attributed to
 * the encoded project, not `agent-transcripts`.
 */
export function encodedProjectFromTranscriptPath(filePath: string): string | undefined {
  let current = dirname(filePath);
  while (current && current !== dirname(current)) {
    if (basename(current) === 'agent-transcripts') {
      const encoded = basename(dirname(current));
      return encoded || undefined;
    }
    current = dirname(current);
  }
  return undefined;
}

function millisToIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const date = new Date(asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function sqliteUri(dbPath: string): string {
  const absolute = dbPath.startsWith('/') ? dbPath : join(process.cwd(), dbPath);
  const encoded = absolute.split('/').map(encodeURIComponent).join('/');
  return `file://${encoded}?mode=ro&immutable=1`;
}

function openCursorKv(dbPath: string): Database {
  const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
  let db: Database;
  try {
    db = new Database(sqliteUri(dbPath), flags);
  } catch {
    db = new Database(dbPath, { readonly: true });
  }
  db.exec('PRAGMA query_only = ON');
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_MS}`);
  return db;
}

function listStateDatabases(
  ideUserDir: string,
  maxWorkspaceDbs: number = MAX_WORKSPACE_STATE_DBS,
): string[] {
  const found: string[] = [];
  const globalDb = join(ideUserDir, 'globalStorage', 'state.vscdb');
  if (existsSync(globalDb)) found.push(globalDb);

  const workspaceRoot = join(ideUserDir, 'workspaceStorage');
  if (!existsSync(workspaceRoot) || maxWorkspaceDbs <= 0) return found;

  const workspaces: Array<{ path: string; mtime: number }> = [];
  try {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dbPath = join(workspaceRoot, entry.name, 'state.vscdb');
      try {
        if (!existsSync(dbPath)) continue;
        workspaces.push({ path: dbPath, mtime: statSync(dbPath).mtimeMs });
      } catch {
        continue;
      }
    }
  } catch {
    return found;
  }

  workspaces.sort((a, b) => b.mtime - a.mtime);
  for (const workspace of workspaces.slice(0, maxWorkspaceDbs)) {
    found.push(workspace.path);
  }
  return found;
}

interface ComposerHeader {
  bubbleId: string;
  type?: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function bubbleHeadersFromComposer(headersJson: unknown, bubblesJson: unknown): ComposerHeader[] {
  const headers: ComposerHeader[] = [];
  const seen = new Set<string>();
  const push = (bubbleId: string, type?: number) => {
    if (!bubbleId || seen.has(bubbleId)) return;
    seen.add(bubbleId);
    headers.push({ bubbleId, type });
  };

  const raw = parseJson(headersJson);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        push(item);
        continue;
      }
      const rec = asObject(item);
      const id = rec && (rec.bubbleId ?? rec.id);
      if (rec && typeof id === 'string') {
        push(id, typeof rec.type === 'number' ? rec.type : undefined);
      }
    }
  }

  if (headers.length === 0) {
    const bubbles = parseJson(bubblesJson);
    if (Array.isArray(bubbles)) {
      for (const item of bubbles) {
        if (typeof item === 'string') push(item);
        else {
          const rec = asObject(item);
          const id = rec && (rec.bubbleId ?? rec.id);
          if (typeof id === 'string') push(id);
        }
      }
    }
  }
  return headers;
}

function catalogVscdb(dbPath: string): CursorCatalogSession[] {
  let db: Database | null = null;
  try {
    db = openCursorKv(dbPath);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursorDiskKV'`
    ).get() as { name: string } | undefined;
    if (!tables) return [];

    const composers = db.prepare(`
      SELECT key,
             json_extract(value, '$.composerId') AS composerId,
             json_extract(value, '$.name') AS name,
             json_extract(value, '$.createdAt') AS createdAt,
             json_extract(value, '$.lastUpdatedAt') AS lastUpdatedAt,
             json_extract(value, '$.workspaceProjectDir') AS workspaceProjectDir,
             json_extract(value, '$.fullConversationHeadersOnly') AS headers,
             json_extract(value, '$.conversationHeaders') AS conversationHeaders,
             json_extract(value, '$.bubbles') AS bubbles
      FROM cursorDiskKV
      WHERE key GLOB 'composerData:*'
    `).all() as Array<{
      key: string;
      composerId: string | null;
      name: string | null;
      createdAt: number | string | null;
      lastUpdatedAt: number | string | null;
      workspaceProjectDir: string | null;
      headers: unknown;
      conversationHeaders: unknown;
      bubbles: unknown;
    }>;

    return composers.map(composer => {
      const sessionId = String(composer.composerId || composer.key.slice(COMPOSER_PREFIX.length) || composer.key);
      const headers = bubbleHeadersFromComposer(
        composer.headers ?? composer.conversationHeaders,
        composer.bubbles,
      );
      const workspace = composer.workspaceProjectDir?.trim() || undefined;
      return {
        store: 'ide-vscdb' as const,
        sessionId,
        workspace,
        project: workspace ? basename(workspace) : composer.name ?? undefined,
        createdAt: millisToIso(composer.createdAt),
        updatedAt: millisToIso(composer.lastUpdatedAt),
        // Composer rows are not the container DB; JSONL keeps per-file size.
        size: 0,
        messageCount: headers.length,
        sourcePath: dbPath,
        quality: 'transcript' as const,
      };
    });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function parseCliJsonl(filePath: string): CursorCatalogSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let messageCount = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { role?: unknown; type?: unknown; message?: { role?: unknown } };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const roleRaw = String(parsed.role ?? parsed.message?.role ?? parsed.type ?? '').toLowerCase();
    if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;
    messageCount++;
  }
  if (messageCount === 0) return null;
  const encodedProject = encodedProjectFromTranscriptPath(filePath);
  const workspace = encodedProject ? decodeCursorProjectDir(encodedProject) : undefined;
  let updatedAt: string | undefined;
  try {
    updatedAt = new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    updatedAt = undefined;
  }
  return {
    store: 'cli-jsonl',
    sessionId: basename(filePath, '.jsonl'),
    workspace,
    project: workspace ? basename(workspace) : undefined,
    updatedAt,
    size: fileSize(filePath),
    messageCount,
    sourcePath: filePath,
    quality: 'transcript',
  };
}

function catalogChatsBlobs(chatsDir: string): CursorCatalogSession[] {
  if (!existsSync(chatsDir)) return [];
  const sessions: CursorCatalogSession[] = [];
  try {
    for (const entry of readdirSync(chatsDir, { withFileTypes: true })) {
      const full = join(chatsDir, entry.name);
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        sessions.push({
          store: 'chats-blob',
          sessionId: `chats-blob:${entry.name}`,
          size: stat.size,
          messageCount: 0,
          sourcePath: full,
          quality: 'breadcrumbs',
          updatedAt: new Date(stat.mtimeMs).toISOString(),
        });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return sessions;
}

/**
 * Catalog Cursor on-disk stores. Missing chats dir is a skip, not an error.
 * Present chats blobs are breadcrumbs-quality and are never claimed as an
 * ordered transcript. JSONL remains the CLI transcript source.
 */
export function catalogCursorSessions(options: CursorCatalogOptions = {}): CursorCatalogSession[] {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const ideUserDir = options.ideUserDir ?? cursorIdeUserDir(home, env);
  const cliRoot = options.cliRoot ?? cursorCliRoot(home, env);
  const cwd = options.cwd ?? process.cwd();
  const maxWorkspaceDbs = options.maxWorkspaceDbs ?? MAX_WORKSPACE_STATE_DBS;

  const sessions: CursorCatalogSession[] = [];
  for (const dbPath of listStateDatabases(ideUserDir, maxWorkspaceDbs)) {
    sessions.push(...catalogVscdb(dbPath));
  }

  const transcriptsRoot = join(cliRoot, 'projects');
  if (existsSync(transcriptsRoot)) {
    try {
      for (const project of readdirSync(transcriptsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const agentRoot = join(transcriptsRoot, project.name, 'agent-transcripts');
        if (!existsSync(agentRoot)) continue;
        for (const rel of new Bun.Glob('**/*.jsonl').scanSync({ cwd: agentRoot, onlyFiles: true })) {
          if (rel.split(/[/\\]/).includes('subagents')) continue;
          const parsed = parseCliJsonl(join(agentRoot, rel));
          if (parsed) sessions.push(parsed);
        }
      }
    } catch {
      // Fail-soft: a missing or unreadable CLI root is not an error.
    }
  }

  sessions.push(...catalogChatsBlobs(cursorChatsDir(cliRoot, cwd)));
  return sessions;
}
