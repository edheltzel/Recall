export interface QualityResult {
  pass: boolean;
  reason?: 'below_word_count' | 'missing_sections' | 'too_short';
}

export interface QualityOptions {
  strict?: boolean;  // default true — requires section headers
  minWords?: number; // default 50
  minChars?: number; // default 100 — for relaxed mode
}

export function evaluateQuality(text: string, options?: QualityOptions): QualityResult {
  const strict = options?.strict ?? true;
  const minWords = options?.minWords ?? 50;
  const minChars = options?.minChars ?? 100;

  // Word count check
  const words = text.trim().split(/\s+/);
  if (words.length < minWords) {
    return { pass: false, reason: 'below_word_count' };
  }

  if (strict) {
    // Check for required section headers
    const hasOneSentence = /ONE SENTENCE SUMMARY/i.test(text);
    const hasMainIdeas = /MAIN IDEAS/i.test(text);
    if (!hasOneSentence || !hasMainIdeas) {
      return { pass: false, reason: 'missing_sections' };
    }
  } else {
    // Relaxed: just check meaningful content length
    const meaningfulContent = text.replace(/\s+/g, '').length;
    if (meaningfulContent < minChars) {
      return { pass: false, reason: 'too_short' };
    }
  }

  return { pass: true };
}

export function shouldSkipExtraction(contentChars: number): boolean {
  return contentChars < 500;
}

export function buildAdaptivePrompt(contentChars: number): string {
  if (contentChars < 2000) {
    // Short-form prompt for brief sessions
    return `Provide a brief summary of this conversation session. Focus on:
- What was discussed
- Key decisions made
- Any action items or outcomes

Keep the summary concise and factual.`;
  }

  // Full structured prompt for longer sessions
  return `Extract the key information from this conversation session using the following structure:

ONE SENTENCE SUMMARY:
[A single sentence capturing the essence of the session]

MAIN IDEAS:
[Numbered list of 3-7 main ideas discussed]

MAIN RECOMMENDATIONS:
[Numbered list of actionable recommendations, if any]

Keep each section focused and specific to what was actually discussed.`;
}
