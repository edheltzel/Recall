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
