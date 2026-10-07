import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MAX_DIRECT_CHARS = 120000;

function extractionPrompt(): string {
  try {
    const patternPath = join(process.env.HOME ?? '', '.claude', 'MEMORY', 'extract_prompt.md');
    if (patternPath && existsSync(patternPath)) return readFileSync(patternPath, 'utf-8').trim();
  } catch {
    // Fall through to the self-contained prompt.
  }
  return `You are an expert at extracting meaningful, factual information from AI coding session transcripts.
Extract ONLY what actually happened. Follow this format EXACTLY:

## ONE SENTENCE SUMMARY
[Single factual sentence]

## MAIN IDEAS
- [Concrete thing 1]
- [Concrete thing 2]

## DECISIONS MADE
- [Decision]: [reason]

## THINGS TO REJECT / AVOID
- [Thing to avoid]: [why]

## ERRORS FIXED
- [Error]: [fix]

## SESSION CONTEXT
[One sentence about impact on infrastructure]`;
}

export function prepareAutomaticExtractionInput(messages: string): string {
  const truncated = messages.length > MAX_DIRECT_CHARS ? messages.slice(-MAX_DIRECT_CHARS) : messages;
  return `${extractionPrompt()}\n\n---\n\nExtract the key information from this AI coding session transcript:\n\n${truncated}`;
}
