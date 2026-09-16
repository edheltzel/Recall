// Shared extraction helpers used by CLI commands.

import type { Message } from '../types/index.js';
import { extractWisdomWithFabric, MAX_FABRIC_INPUT_BYTES } from '../providers/fabric.js';
import { ExtractorConfigError, requireCuratedExtractor, resolveExtractorConfig } from './extractor-config.js';

export { MAX_FABRIC_INPUT_BYTES, ExtractorConfigError };

export interface BasicSummaryStats {
  total: number;
  user: number;
  assistant: number;
  firstUser?: string;
  lastAssistant?: string;
}

export interface FrameSummaryStats {
  total: number;
  firstFrame?: string;
  latestFrame?: string;
}

export function generateBasicSummaryFromStats(stats: BasicSummaryStats): string {
  const firstUser = stats.firstUser?.slice(0, 200) || 'No user messages';
  const lastAssistant = stats.lastAssistant?.slice(0, 200) || 'No assistant messages';

  return `## ONE SENTENCE SUMMARY

Session with ${stats.total} messages.

## MAIN IDEAS

- User started with: ${firstUser}${firstUser.length >= 200 ? '...' : ''}
- Final response covered: ${lastAssistant}${lastAssistant.length >= 200 ? '...' : ''}

## TOPICS

- ${stats.total} total messages (${stats.user} user, ${stats.assistant} assistant)
`;
}

export function generateFrameSummaryFromStats(
  stats: FrameSummaryStats,
  label: string
): string {
  const firstFrame = stats.firstFrame?.trim().slice(0, 200) || 'No captured frames';
  const latestFrame = stats.latestFrame?.trim().slice(-200) || 'No captured frames';

  return `## ONE SENTENCE SUMMARY

Session captured in ${stats.total} ${label} frame${stats.total === 1 ? '' : 's'}.

## MAIN IDEAS

- Export started with: ${firstFrame}${firstFrame.length >= 200 ? '...' : ''}
- Latest captured content: ${latestFrame}${latestFrame.length >= 200 ? '...' : ''}

## TOPICS

- ${stats.total} total verbatim ${label} frame${stats.total === 1 ? '' : 's'}
`;
}
/**
 * Generate a basic extraction-shaped summary when the Extractor is skipped or unavailable.
 */
export function generateBasicSummary(messages: Array<Pick<Message, 'role' | 'content'>>): string {
  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');
  return generateBasicSummaryFromStats({
    total: messages.length,
    user: userMessages.length,
    assistant: assistantMessages.length,
    firstUser: userMessages[0]?.content,
    lastAssistant: assistantMessages.at(-1)?.content,
  });
}

export function generateFrameSummary(
  messages: Array<Pick<Message, 'role' | 'content'>>,
  label: string
): string {
  const frames = messages.filter(message => message.role === 'system');
  return generateFrameSummaryFromStats({
    total: frames.length,
    firstFrame: frames[0]?.content,
    latestFrame: frames.at(-1)?.content,
  }, label);
}

/**
 * Render messages in the same simple bracketed transcript format used by dump.
 */
export function formatMessagesForExtraction(messages: Array<Pick<Message, 'role' | 'timestamp' | 'content'>>): string {
  return messages.map(m => {
    const role = m.role.toUpperCase();
    const time = m.timestamp.split('T')[1]?.split('.')[0] || '';
    return `[${role} ${time}]\n${m.content}`;
  }).join('\n\n---\n\n');
}

/**
 * Run the curated `fabric` Extractor with the resolved model.
 */
export function runFabricExtract(
  content: string,
  deps: {
    resolve?: typeof resolveExtractorConfig;
    extract?: typeof extractWisdomWithFabric;
  } = {},
): string {
  const curated = requireCuratedExtractor((deps.resolve ?? resolveExtractorConfig)());
  return (deps.extract ?? extractWisdomWithFabric)(content, curated.primary.model);
}
