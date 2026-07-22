// Host-neutral extraction-provider cascade shared by lifecycle hooks.
//
// Provider-specific commands, authentication, environment, and paths live
// under hooks/lib/hosts/<host>/. The cascade only orders providers and derives
// metadata from their common extracted-markdown contract.

import { execSync } from 'child_process';
import type { ExtractionProvider } from './extraction-provider';
import { nativeExtractionProviders } from './hosts';

const LOCAL_OLLAMA_URL = `${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/generate`;
const LOCAL_OLLAMA_MODEL = process.env.Recall_OLLAMA_MODEL || 'qwen2.5:3b';

function extractWithOllama(messages: string): string | null {
  const systemPrompt = `You are an expert at extracting meaningful information from conversations. Extract in this exact format:

## ONE SENTENCE SUMMARY
[Single sentence capturing the essence]

## MAIN IDEAS
- [Key idea 1]
- [Key idea 2]
- [Key idea 3]

## INSIGHTS
- [Non-obvious insight 1]
- [Non-obvious insight 2]

## DECISIONS MADE
- [Important decision and why]

## THINGS TO REJECT / AVOID
- [Thing to reject or avoid]

## ERRORS FIXED
- [error message or pattern]: [what fixed it]

## ACTIONABLE ITEMS
- [Concrete action]

## SESSION CONTEXT
[One sentence about overall impact on the project or infrastructure]`;

  try {
    const truncated = messages.length > 8000 ? messages.slice(-8000) : messages;
    const payload = JSON.stringify({
      model: LOCAL_OLLAMA_MODEL,
      prompt: `${systemPrompt}\n\n---\nCONVERSATION:\n${truncated}`,
      stream: false,
    });
    const result = execSync(
      `curl -s --connect-timeout 10 --max-time 180 -X POST ${LOCAL_OLLAMA_URL} -H "Content-Type: application/json" -d @-`,
      {
        input: payload,
        encoding: 'utf-8',
        timeout: 200000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(result) as { response?: string };
    if (parsed.response && parsed.response.trim().length > 50) {
      console.error('[FabricExtract] Ollama extraction successful');
      return parsed.response.trim();
    }
    return null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FabricExtract] Ollama extraction failed: ${message}`);
    return null;
  }
}

const ollamaExtractionProvider: ExtractionProvider = {
  id: 'ollama',
  extract: extractWithOllama,
};

export const DEFAULT_EXTRACTION_PROVIDERS: readonly ExtractionProvider[] = [
  ...nativeExtractionProviders,
  ollamaExtractionProvider,
];

/** Run providers in order and return the first usable extraction. */
export async function runExtractionCascade(
  messages: string,
  providers: readonly ExtractionProvider[] = DEFAULT_EXTRACTION_PROVIDERS,
): Promise<string | null> {
  for (const provider of providers) {
    console.error(`[FabricExtract] Trying ${provider.id} extraction...`);
    const extracted = await provider.extract(messages);
    if (extracted) return extracted;
  }
  return null;
}

/** Extract topics from generated markdown or the legacy heading format. */
export function extractTopics(fabricOutput: string): string[] {
  const topics: string[] = [];
  const patterns = [
    /(?:##\s*DECISIONS\s*MADE|DECISIONS:)\s*([\s\S]*?)(?=\n##\s|$)/,
    /(?:##\s*MAIN\s*IDEAS|MAIN_IDEAS:)\s*([\s\S]*?)(?=\n##\s|$)/,
    /(?:##\s*INSIGHTS|INSIGHTS:)\s*([\s\S]*?)(?=\n##\s|$)/,
  ];
  for (const pattern of patterns) {
    const match = fabricOutput.match(pattern);
    if (!match) continue;
    const lines = match[1].split('\n').filter(line => line.trim().startsWith('-'));
    for (const line of lines.slice(0, 3)) {
      const topic = line.replace(/^-\s*/, '').replace(/\*\*/g, '').split(':')[0].trim();
      if (topic && topic.length < 50) topics.push(topic);
    }
  }
  return [...new Set(topics)].slice(0, 5);
}

/** Pull the one-sentence summary line, or use a stable fallback label. */
export function deriveSummary(extracted: string, fallbackLabel: string): string {
  const summaryMatch = extracted.match(/##\s*ONE\s*SENTENCE\s*SUMMARY\s*\n+(.+)/);
  return summaryMatch ? summaryMatch[1].trim() : `${fallbackLabel} session`;
}
