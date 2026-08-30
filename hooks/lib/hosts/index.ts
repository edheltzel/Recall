import type { ExtractionProvider } from '../extraction-provider';
import { createClaudeExtractionProvider } from './claude/extraction-provider';

/** Native automatic Extractor factories. Cascade consumes these; do not import host adapters from extract-model. */
export const nativeAutomaticFactories = {
  'claude-cli': createClaudeExtractionProvider,
} as const satisfies Record<string, (model: string) => ExtractionProvider>;
