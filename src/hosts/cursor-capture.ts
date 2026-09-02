/**
 * Cursor capture wire: on-disk catalog of IDE state.vscdb, CLI JSONL, and
 * optional ~/.cursor/chats/<md5(cwd)>/ blobs.
 *
 * Catalog only. Does not insert transcript bodies into Recall SQLite, does
 * not join `recall host-hook` / host-ingest / LifecycleHost, and does not
 * replace JSONL as the CLI transcript source.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { basename, dirname, join, relative, sep } from 'path';
import { homedir, platform } from 'os';
import { Database } from 'bun:sqlite';

export type CursorStoreKind = 'ide-vscdb' | 'cli-jsonl' | 'chats-blob';
export type CursorCatalogQuality = 'transcript' | 'breadcrumbs';

export interface CursorCatalogTurn {
  role: 'user' | 'assistant';
  timestamp?: string;
  workspace?: string;
  /** Catalog field for parser tests; never written to query/search. */
  text?: string;
}

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
  turns: CursorCatalogTurn[];
}

export interface CursorCatalogOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  ideUserDir?: string;
  cliRoot?: string;
  includeSubagents?: boolean;
}

const COMPOSER_PREFIX = 'composerData:';
const BUBBLE_PREFIX = 'bubbleId::';
const SQLITE_BUSY_MS = 5000;

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

function listStateDatabases(ideUserDir: string): string[] {
  const found: string[] = [];
  const globalDb = join(ideUserDir, 'globalStorage', 'state.vscdb');
  if (existsSync(globalDb)) found.push(globalDb);
  const workspaceRoot = join(ideUserDir, 'workspaceStorage');
  if (!existsSync(workspaceRoot)) return found;
  try {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dbPath = join(workspaceRoot, entry.name, 'state.vscdb');
      if (existsSync(dbPath)) found.push(dbPath);
    }
  } catch {
    return found;
  }
  return found;
}

function catalogVscdb(dbPath: string): CursorCatalogSession[] {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_MS}`);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursorDiskKV'`
    ).get() as { name: string } | undefined;
    if (!tables) return [];

    const composers = db.prepare(`
      SELECT key,
             json_extract(value, '$.composerId') AS composerId,
             json_extract(value, '$.name') AS name,
             json_extract(value, '$.createdAt') AS createdAt,
             json_extract(value, '$.lastUpdatedAt') AS lastUpdatedAt
      FROM cursorDiskKV
      WHERE key LIKE 'composerData:%'
    `).all() as Array<{
      key: string;
      composerId: string | null;
      name: string | null;
      createdAt: number | string | null;
      lastUpdatedAt: number | string | null;
    }>;

    const bubbles = db.prepare(`
      SELECT key,
             json_extract(value, '$.type') AS type,
             json_extract(value, '$.text') AS text,
             json_extract(value, '$.rawText') AS rawText,
             json_extract(value, '$.timestamp') AS timestamp,
             json_extract(value, '$.workspaceProjectDir') AS workspaceProjectDir
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId::%'
    `).all() as Array<{
      key: string;
      type: number | string | null;
      text: string | null;
      rawText: string | null;
      timestamp: number | string | null;
      workspaceProjectDir: string | null;
    }>;

    const turnsByComposer = new Map<string, CursorCatalogTurn[]>();
    const workspaceByComposer = new Map<string, string>();
    for (const bubble of bubbles) {
      const rest = bubble.key.startsWith(BUBBLE_PREFIX)
        ? bubble.key.slice(BUBBLE_PREFIX.length)
        : '';
      const composerId = rest.split(':')[0];
      if (!composerId) continue;
      const text = String(bubble.text ?? bubble.rawText ?? '').trim();
      if (!text) continue;
      const role: CursorCatalogTurn['role'] = Number(bubble.type) === 1 ? 'user' : 'assistant';
      const workspace = bubble.workspaceProjectDir?.trim() || undefined;
      if (workspace && !workspaceByComposer.has(composerId)) {
        workspaceByComposer.set(composerId, workspace);
      }
      const turns = turnsByComposer.get(composerId) ?? [];
      turns.push({
        role,
        timestamp: millisToIso(bubble.timestamp),
        workspace,
        text,
      });
      turnsByComposer.set(composerId, turns);
    }

    return composers.map(composer => {
      const sessionId = String(composer.composerId || composer.key.slice(COMPOSER_PREFIX.length) || composer.key);
      const turns = turnsByComposer.get(sessionId) ?? [];
      const workspace = workspaceByComposer.get(sessionId);
      return {
        store: 'ide-vscdb' as const,
        sessionId,
        workspace,
        project: workspace ? basename(workspace) : composer.name ?? undefined,
        createdAt: millisToIso(composer.createdAt),
        updatedAt: millisToIso(composer.lastUpdatedAt),
        size: fileSize(dbPath),
        messageCount: turns.length,
        sourcePath: dbPath,
        quality: 'transcript' as const,
        turns,
      };
    });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function walkJsonlFiles(root: string, includeSubagents: boolean): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!includeSubagents && entry.name === 'subagents') continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const rel = relative(root, full).split(sep);
      if (!includeSubagents && rel.includes('subagents')) continue;
      found.push(full);
    }
  }
  return found;
}

function jsonlText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('\n')
    .trim();
}

function parseCliJsonl(filePath: string): CursorCatalogSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const turns: CursorCatalogTurn[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: {
      role?: unknown;
      type?: unknown;
      message?: { content?: unknown; role?: unknown };
      content?: unknown;
    };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const roleRaw = String(parsed.role ?? parsed.message?.role ?? parsed.type ?? '').toLowerCase();
    if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;
    const text = jsonlText(parsed.message?.content ?? parsed.content);
    if (!text) continue;
    turns.push({ role: roleRaw, text });
  }
  if (turns.length === 0) return null;
  const encodedProject = basename(dirname(dirname(filePath)));
  const workspace = decodeCursorProjectDir(encodedProject);
  let updatedAt: string | undefined;
  try {
    updatedAt = new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    updatedAt = undefined;
  }
  for (const turn of turns) {
    turn.timestamp = updatedAt;
    turn.workspace = workspace;
  }
  return {
    store: 'cli-jsonl',
    sessionId: basename(filePath, '.jsonl'),
    workspace,
    project: basename(workspace),
    updatedAt,
    size: fileSize(filePath),
    messageCount: turns.length,
    sourcePath: filePath,
    quality: 'transcript',
    turns,
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
          turns: [],
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
  const includeSubagents = options.includeSubagents
    ?? env.RECALL_INCLUDE_SUBAGENTS === '1';
  const cwd = options.cwd ?? process.cwd();

  const sessions: CursorCatalogSession[] = [];
  for (const dbPath of listStateDatabases(ideUserDir)) {
    sessions.push(...catalogVscdb(dbPath));
  }

  const transcriptsRoot = join(cliRoot, 'projects');
  if (existsSync(transcriptsRoot)) {
    try {
      for (const project of readdirSync(transcriptsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const agentRoot = join(transcriptsRoot, project.name, 'agent-transcripts');
        if (!existsSync(agentRoot)) continue;
        for (const file of walkJsonlFiles(agentRoot, includeSubagents)) {
          const parsed = parseCliJsonl(file);
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
