// Multi-format conversation import for Claude.ai, ChatGPT, and Slack JSON exports.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, extname, join, relative } from 'path';
import { addMessagesBatch, createSession, sessionExists } from './memory.js';
import { formatMessagesForExtraction, generateBasicSummary, runFabricExtract } from './extraction.js';
import { writeStructuredExtraction, type StructuredExtractionResult } from './structured-extraction.js';
import type { Message } from '../types/index.js';

export type ConversationFormat = 'auto' | 'claude-ai' | 'chatgpt' | 'slack';
export type ImportedConversationSource = 'claude-ai' | 'chatgpt' | 'slack';

type MessageInput = Omit<Message, 'id'>;
type JsonObject = Record<string, unknown>;

export interface ParsedConversationSession {
  sessionId: string;
  source: ImportedConversationSource;
  title: string;
  project: string;
  startedAt: string;
  endedAt: string;
  filePath: string;
  messages: MessageInput[];
}

export interface ConversationImportOptions {
  format?: ConversationFormat;
  noExtract?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  project?: string;
}

export interface ConversationImportDependencies {
  extractor?: (conversationText: string, session: ParsedConversationSession) => string | Promise<string>;
}

export interface ConversationImportResult {
  sessionsFound: number;
  sessionsImported: number;
  sessionsSkipped: number;
  messagesImported: number;
  extractedSessions: number;
  extractionFallbacks: number;
  structuredWrites: {
    decisions: number;
    learnings: number;
    breadcrumbs: number;
    errors: number;
    loa: number;
  };
  errors: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function sanitizeId(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9:._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'unknown').slice(0, 180);
}

function timestampFrom(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }

  return fallback;
}

function roleFrom(value: unknown): Message['role'] | null {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (['human', 'user', 'customer'].includes(raw)) return 'user';
  if (['assistant', 'ai', 'model', 'bot'].includes(raw)) return 'assistant';
  if (raw === 'system') return 'system';
  return null;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join('\n');
  }
  if (!isObject(value)) return '';

  const direct = firstString(value.text, value.value, value.result);
  if (direct) return direct;

  if ('parts' in value) return textFromUnknown(value.parts);
  if ('content' in value) return textFromUnknown(value.content);
  if ('blocks' in value) return textFromUnknown(value.blocks);

  return '';
}

function normalizeSession(input: {
  sessionId: string;
  source: ImportedConversationSource;
  title?: string;
  project: string;
  filePath: string;
  messages: MessageInput[];
}): ParsedConversationSession | null {
  const messages = input.messages
    .filter(m => m.content.trim())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (messages.length === 0) return null;

  const sessionId = sanitizeId(input.sessionId);
  for (const message of messages) {
    message.session_id = sessionId;
    message.project = input.project;
  }

  return {
    sessionId,
    source: input.source,
    title: input.title?.trim() || sessionId,
    project: input.project,
    startedAt: messages[0].timestamp,
    endedAt: messages[messages.length - 1].timestamp,
    filePath: input.filePath,
    messages,
  };
}

function collectJsonFiles(inputPath: string): string[] {
  if (!existsSync(inputPath)) {
    throw new Error(`Path does not exist: ${inputPath}`);
  }

  const stat = statSync(inputPath);
  if (stat.isFile()) {
    return extname(inputPath).toLowerCase() === '.json' ? [inputPath] : [];
  }

  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(full);
    }
  };
  walk(inputPath);
  return files.sort();
}

function loadJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function looksLikeChatGptConversation(value: unknown): boolean {
  return isObject(value) && isObject(value.mapping);
}

function looksLikeClaudeAiConversation(value: unknown): boolean {
  if (!isObject(value)) return false;
  const messages = value.chat_messages ?? value.messages;
  return Array.isArray(messages) && messages.some(m => isObject(m) && ('sender' in m || 'role' in m));
}

function looksLikeSlackMessages(value: unknown): boolean {
  const messages = Array.isArray(value) ? value : isObject(value) ? asArray(value.messages) : [];
  return messages.some(m => isObject(m) && ('ts' in m) && ('text' in m || 'blocks' in m || 'attachments' in m));
}

export function detectConversationFormat(data: unknown): ImportedConversationSource | null {
  const conversations = Array.isArray(data)
    ? data
    : isObject(data) && Array.isArray(data.conversations)
      ? data.conversations
      : [data];

  if (conversations.some(looksLikeChatGptConversation)) return 'chatgpt';
  if (conversations.some(looksLikeClaudeAiConversation)) return 'claude-ai';
  if (looksLikeSlackMessages(data)) return 'slack';
  return null;
}

function getConversationArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (isObject(data) && Array.isArray(data.conversations)) return data.conversations;
  return [data];
}

export function parseClaudeAiConversations(data: unknown, filePath: string, project?: string): ParsedConversationSession[] {
  const sessions: ParsedConversationSession[] = [];
  const conversations = getConversationArray(data).filter(looksLikeClaudeAiConversation) as JsonObject[];
  const fallbackNow = new Date().toISOString();

  conversations.forEach((conversation, index) => {
    const rawMessages = asArray(conversation.chat_messages ?? conversation.messages);
    const rawId = firstString(conversation.uuid, conversation.id, conversation.conversation_id) || `${basename(filePath, '.json')}-${index + 1}`;
    const title = firstString(conversation.name, conversation.title) || 'Claude.ai conversation';
    const sessionProject = project || 'claude-ai';

    const messages: MessageInput[] = [];
    rawMessages.forEach((message, messageIndex) => {
      if (!isObject(message)) return;
      const role = roleFrom(message.sender ?? message.role ?? (isObject(message.author) ? message.author.role : undefined));
      if (!role) return;
      const content = textFromUnknown(message.text ?? message.content ?? message.message);
      if (!content.trim()) return;
      messages.push({
        session_id: '',
        timestamp: timestampFrom(message.created_at ?? message.updated_at ?? message.timestamp, fallbackNow),
        role,
        content,
        project: sessionProject,
        importance: messageIndex === 0 ? 5 : undefined,
      });
    });

    const normalized = normalizeSession({
      sessionId: `claude-ai:${rawId}`,
      source: 'claude-ai',
      title,
      project: sessionProject,
      filePath,
      messages,
    });
    if (normalized) sessions.push(normalized);
  });

  return sessions;
}

function orderedChatGptNodes(conversation: JsonObject): JsonObject[] {
  const mapping = isObject(conversation.mapping) ? conversation.mapping : {};
  const current = firstString(conversation.current_node);

  if (current) {
    const chain: JsonObject[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = current;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = mapping[cursor];
      if (!isObject(node)) break;
      chain.push(node);
      cursor = firstString(node.parent);
    }
    return chain.reverse().filter(node => isObject(node.message));
  }

  return Object.values(mapping)
    .filter(isObject)
    .filter(node => isObject(node.message))
    .sort((a, b) => {
      const am = a.message as JsonObject;
      const bm = b.message as JsonObject;
      const at = typeof am.create_time === 'number' ? am.create_time : 0;
      const bt = typeof bm.create_time === 'number' ? bm.create_time : 0;
      return at - bt;
    });
}

export function parseChatGptConversations(data: unknown, filePath: string, project?: string): ParsedConversationSession[] {
  const sessions: ParsedConversationSession[] = [];
  const conversations = getConversationArray(data).filter(looksLikeChatGptConversation) as JsonObject[];
  const fallbackNow = new Date().toISOString();

  conversations.forEach((conversation, index) => {
    const rawId = firstString(conversation.id, conversation.conversation_id) || `${basename(filePath, '.json')}-${index + 1}`;
    const title = firstString(conversation.title) || 'ChatGPT conversation';
    const sessionProject = project || 'chatgpt';
    const messages: MessageInput[] = [];

    for (const node of orderedChatGptNodes(conversation)) {
      const message = node.message as JsonObject;
      const metadata = isObject(message.metadata) ? message.metadata : {};
      if (metadata.is_visually_hidden_from_conversation === true) continue;

      const author = isObject(message.author) ? message.author : {};
      const role = roleFrom(author.role);
      if (!role) continue;

      const content = textFromUnknown(message.content);
      if (!content.trim()) continue;

      messages.push({
        session_id: '',
        timestamp: timestampFrom(message.create_time ?? message.update_time, fallbackNow),
        role,
        content,
        project: sessionProject,
      });
    }

    const normalized = normalizeSession({
      sessionId: `chatgpt:${rawId}`,
      source: 'chatgpt',
      title,
      project: sessionProject,
      filePath,
      messages,
    });
    if (normalized) sessions.push(normalized);
  });

  return sessions;
}

function slackChannelFromPath(filePath: string, rootPath?: string): string {
  if (rootPath) {
    const rootStat = statSync(rootPath);
    if (rootStat.isDirectory()) {
      const rel = relative(rootPath, filePath);
      const first = rel.split(/[\\/]/)[0];
      if (first && first !== basename(filePath)) return first;
    } else if (rootStat.isFile()) {
      return basename(filePath, '.json');
    }
  }
  return basename(dirname(filePath)) || basename(filePath, '.json');
}

function slackSender(message: JsonObject): string {
  const profile = isObject(message.user_profile) ? message.user_profile : {};
  const botProfile = isObject(message.bot_profile) ? message.bot_profile : {};
  return firstString(
    profile.real_name,
    profile.display_name,
    profile.name,
    message.username,
    botProfile.name,
    message.user,
    message.bot_id
  ) || 'unknown';
}

function slackText(message: JsonObject): string {
  const direct = textFromUnknown(message.text);
  if (direct.trim()) return direct;

  const attachments = asArray(message.attachments)
    .map(a => isObject(a) ? textFromUnknown(a.pretext ?? a.title ?? a.text ?? a.fallback) : '')
    .filter(Boolean)
    .join('\n');
  if (attachments.trim()) return attachments;

  return textFromUnknown(message.blocks);
}

export function parseSlackConversations(data: unknown, filePath: string, project?: string, rootPath?: string): ParsedConversationSession[] {
  if (!looksLikeSlackMessages(data)) return [];
  const rawMessages = Array.isArray(data) ? data : isObject(data) ? asArray(data.messages) : [];
  const channel = slackChannelFromPath(filePath, rootPath);
  const dateLabel = basename(filePath, '.json');
  const sessionProject = project || `slack:${channel}`;
  const messages: MessageInput[] = [];

  for (const raw of rawMessages) {
    if (!isObject(raw)) continue;
    if (firstString(raw.subtype) === 'message_deleted') continue;
    const text = slackText(raw);
    if (!text.trim()) continue;

    const sender = slackSender(raw);
    const isBot = Boolean(raw.bot_id) || firstString(raw.subtype) === 'bot_message';
    messages.push({
      session_id: '',
      timestamp: timestampFrom(raw.ts ?? raw.thread_ts, new Date().toISOString()),
      role: isBot ? 'assistant' : 'user',
      content: `[${sender}] ${text}`,
      project: sessionProject,
    });
  }

  const normalized = normalizeSession({
    sessionId: `slack:${channel}:${dateLabel}`,
    source: 'slack',
    title: `Slack #${channel} ${dateLabel}`,
    project: sessionProject,
    filePath,
    messages,
  });

  return normalized ? [normalized] : [];
}

export function loadConversationSessions(inputPath: string, options: ConversationImportOptions = {}): ParsedConversationSession[] {
  const format = options.format || 'auto';
  const files = collectJsonFiles(inputPath);
  const sessions: ParsedConversationSession[] = [];

  for (const file of files) {
    let data: unknown;
    try {
      data = loadJson(file);
    } catch {
      continue;
    }

    const detected = format === 'auto' ? detectConversationFormat(data) : format;
    if (!detected) continue;

    switch (detected) {
      case 'claude-ai':
        sessions.push(...parseClaudeAiConversations(data, file, options.project));
        break;
      case 'chatgpt':
        sessions.push(...parseChatGptConversations(data, file, options.project));
        break;
      case 'slack':
        sessions.push(...parseSlackConversations(data, file, options.project, inputPath));
        break;
    }
  }

  return sessions;
}

function extractOneSentence(extracted: string): string {
  const match = extracted.match(/##\s*ONE\s+SENTENCE\s+SUMMARY\s*([\s\S]*?)(?=\n##\s|$)/i);
  return match?.[1]?.trim().split('\n').find(Boolean)?.replace(/^[-*]\s*/, '').trim() || 'Imported conversation';
}

function extractTopics(extracted: string): string[] {
  const sections = [
    /##\s*TOPICS\s*([\s\S]*?)(?=\n##\s|$)/i,
    /##\s*MAIN\s+IDEAS\s*([\s\S]*?)(?=\n##\s|$)/i,
  ];
  const topics: string[] = [];
  for (const section of sections) {
    const match = extracted.match(section);
    if (!match) continue;
    for (const line of match[1].split('\n')) {
      const topic = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').split(':')[0].trim();
      if (topic && topic.length <= 80) topics.push(topic);
    }
  }
  return [...new Set(topics)].slice(0, 8);
}

async function runStructuredExtraction(
  session: ParsedConversationSession,
  extractor: NonNullable<ConversationImportDependencies['extractor']>
): Promise<{ result: StructuredExtractionResult; fallback: boolean }> {
  const transcript = formatMessagesForExtraction(session.messages);
  let extracted: string;
  let fallback = false;

  try {
    extracted = await extractor(transcript, session);
  } catch {
    extracted = generateBasicSummary(session.messages);
    fallback = true;
  }

  const result = writeStructuredExtraction({
    sessionId: session.sessionId,
    sessionLabel: session.title,
    project: session.project,
    timestamp: session.endedAt,
    conversationPath: session.filePath,
    topics: extractTopics(extracted),
    summary: extractOneSentence(extracted),
    extracted,
    messageCount: session.messages.length,
  });

  return { result, fallback };
}

export async function importConversations(
  inputPath: string,
  options: ConversationImportOptions = {},
  dependencies: ConversationImportDependencies = {}
): Promise<ConversationImportResult> {
  const sessions = loadConversationSessions(inputPath, options);
  const extractor = dependencies.extractor || ((conversationText: string) => runFabricExtract(conversationText));
  const result: ConversationImportResult = {
    sessionsFound: sessions.length,
    sessionsImported: 0,
    sessionsSkipped: 0,
    messagesImported: 0,
    extractedSessions: 0,
    extractionFallbacks: 0,
    structuredWrites: { decisions: 0, learnings: 0, breadcrumbs: 0, errors: 0, loa: 0 },
    errors: [],
  };

  for (const session of sessions) {
    try {
      if (sessionExists(session.sessionId)) {
        result.sessionsSkipped++;
        if (options.verbose) console.log(`Skipping existing session: ${session.sessionId}`);
        continue;
      }

      if (options.dryRun) {
        result.sessionsImported++;
        result.messagesImported += session.messages.length;
        if (options.verbose) {
          console.log(`[DRY RUN] Would import ${session.sessionId} (${session.messages.length} messages, ${session.source})`);
        }
        continue;
      }

      createSession({
        session_id: session.sessionId,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        project: session.project,
        summary: `Imported ${session.source}: ${session.title}`,
        source: session.source,
      });

      const count = addMessagesBatch(session.messages);
      result.sessionsImported++;
      result.messagesImported += count;

      if (!options.noExtract) {
        const extraction = await runStructuredExtraction(session, extractor);
        result.extractedSessions++;
        if (extraction.fallback) result.extractionFallbacks++;
        result.structuredWrites.decisions += extraction.result.decisions;
        result.structuredWrites.learnings += extraction.result.learnings;
        result.structuredWrites.breadcrumbs += extraction.result.breadcrumbs;
        result.structuredWrites.errors += extraction.result.errors;
        result.structuredWrites.loa += extraction.result.loa;
        for (const [surface, message] of Object.entries(extraction.result.failures)) {
          result.errors.push(`${session.sessionId} extraction ${surface}: ${message}`);
        }
      }

      if (options.verbose) {
        const extracted = options.noExtract ? '' : ', extracted';
        console.log(`Imported ${session.sessionId}: ${count} messages${extracted}`);
      }
    } catch (error) {
      result.errors.push(`${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}
