import type { ExtractionProvider } from '../extraction-provider';
import { claudeExtractionProvider } from './claude/extraction-provider';

/** Native providers enabled by this installation, kept outside the generic cascade. */
export const nativeExtractionProviders: readonly ExtractionProvider[] = [
  claudeExtractionProvider,
];
