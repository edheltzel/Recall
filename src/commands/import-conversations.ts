// recall import-conversations command

import { conversationSourceAdapters, importConversations, type ConversationFormat } from '../lib/conversation-import.js';

export interface ImportConversationsOptions {
  format?: ConversationFormat;
  noExtract?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  project?: string;
}

export const NO_EXTRACT_WARNING = 'Warning: --no-extract imports raw conversation messages only. This can reduce search precision because the Haiku extraction filter will not create curated LoA, decisions, or learnings.';

const FORMATS: ConversationFormat[] = ['auto', ...conversationSourceAdapters.map(adapter => adapter.source)];

function normalizeFormat(format: ConversationFormat | string | undefined): ConversationFormat {
  const value = format || 'auto';
  if (FORMATS.includes(value as ConversationFormat)) return value as ConversationFormat;
  throw new Error(`Invalid format "${value}". Expected one of: ${FORMATS.join(', ')}`);
}

export async function runImportConversations(inputPath: string, options: ImportConversationsOptions): Promise<void> {
  console.log('Conversation Import');
  console.log('===================\n');

  if (options.noExtract) {
    console.warn(NO_EXTRACT_WARNING);
    console.warn('Use this only when you explicitly want raw FTS coverage without curated memory records.\n');
  }

  const format = normalizeFormat(options.format);
  const result = await importConversations(inputPath, { ...options, format });

  console.log(`Sessions found:    ${result.sessionsFound}`);
  console.log(`Sessions imported: ${result.sessionsImported}`);
  console.log(`Sessions skipped:  ${result.sessionsSkipped}`);
  console.log(`Messages imported: ${result.messagesImported}`);

  if (!options.noExtract && !options.dryRun) {
    console.log(`Extracted sessions: ${result.extractedSessions}`);
    if (result.extractionFallbacks > 0) {
      console.log(`Extraction fallbacks: ${result.extractionFallbacks}`);
    }
    console.log('Structured writes:');
    console.log(`  LoA:         ${result.structuredWrites.loa}`);
    console.log(`  Decisions:   ${result.structuredWrites.decisions}`);
    console.log(`  Learnings:   ${result.structuredWrites.learnings}`);
    console.log(`  Breadcrumbs: ${result.structuredWrites.breadcrumbs}`);
    console.log(`  Errors:      ${result.structuredWrites.errors}`);
  }

  if (result.errors.length > 0) {
    console.error('\nErrors:');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exitCode = 1;
  }
}
