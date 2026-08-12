// Shared extraction helpers used by CLI commands.

import type { Message } from '../types/index.js';
import { extractWisdomWithFabric, MAX_FABRIC_INPUT_BYTES } from '../providers/fabric.js';

export { MAX_FABRIC_INPUT_BYTES };

/**
 * Generate a basic extraction-shaped summary when Haiku/Fabric is unavailable.
 */
export function generateBasicSummary(messages: Array<Pick<Message, 'role' | 'content'>>): string {
  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  const firstUser = userMessages[0]?.content.slice(0, 200) || 'No user messages';
  const lastAssistant = assistantMessages[assistantMessages.length - 1]?.content.slice(0, 200) || 'No assistant messages';

  return `## ONE SENTENCE SUMMARY

Session with ${messages.length} messages.

## MAIN IDEAS

- User started with: ${firstUser}${firstUser.length >= 200 ? '...' : ''}
- Final response covered: ${lastAssistant}${lastAssistant.length >= 200 ? '...' : ''}

## TOPICS

- ${messages.length} total messages (${userMessages.length} user, ${assistantMessages.length} assistant)
`;
}

export function generateFrameSummary(
  messages: Array<Pick<Message, 'role' | 'content'>>,
  label: string
): string {
  const frames = messages.filter(message => message.role === 'system');
  const firstFrame = frames[0]?.content.trim().slice(0, 200) || 'No captured frames';
  const latestFrame = frames.at(-1)?.content.trim().slice(-200) || 'No captured frames';

  return `## ONE SENTENCE SUMMARY

Session captured in ${frames.length} ${label} frame${frames.length === 1 ? '' : 's'}.

## MAIN IDEAS

- Export started with: ${firstFrame}${firstFrame.length >= 200 ? '...' : ''}
- Latest captured content: ${latestFrame}${latestFrame.length >= 200 ? '...' : ''}

## TOPICS

- ${frames.length} total verbatim ${label} frame${frames.length === 1 ? '' : 's'}
`;
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
 * Run Fabric's extract_wisdom pattern with the configured Haiku model.
 */
export function runFabricExtract(content: string): string {
  return extractWisdomWithFabric(content);
}
