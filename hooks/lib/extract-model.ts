// Shared extraction-model cascade — self-contained, no imports from src/.
//
// This is the single home for the "run the extraction model over raw text and
// derive topics/summary from the result" logic. Factored out of RecallExtract.ts
// (issue #51 P3) so BOTH the end-of-session Stop hook (RecallExtract.ts) and the
// mid-session in-session hook (RecallInSession.ts) reuse the SAME model call
// instead of re-inventing it — RecallExtract.ts self-executes main() on import,
// so it cannot be imported directly; this lib is the importable seam.
//
// Moved verbatim from RecallExtract.ts (behavior-preserving): the Claude CLI
// cascade (with chunking for very large inputs), the local Ollama fallback, and
// the topic/summary derivation helpers. Paths and logging are resolved at call
// time from $HOME so the lib stays self-contained and testable.

import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Claude CLI extraction (uses Claude Code's existing auth — no API key needed)
const CLAUDE_CLI_MODEL = 'haiku';

// Local Ollama LLM fallback (configure OLLAMA_URL env var or defaults to localhost)
const LOCAL_OLLAMA_URL = `${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/generate`;
const LOCAL_OLLAMA_MODEL = process.env.Recall_OLLAMA_MODEL || 'qwen2.5:3b';

function getMemoryDir(): string {
  return join(process.env.HOME!, '.claude', 'MEMORY');
}

function getExtractPatternPath(): string {
  return join(getMemoryDir(), 'extract_prompt.md');
}

/** Append a line to the shared EXTRACT_LOG (best-effort, same file the Stop hook uses). */
function logExtract(message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    appendFileSync(join(getMemoryDir(), 'EXTRACT_LOG.txt'), line, 'utf-8');
  } catch {
    // Ignore logging errors
  }
}

/**
 * Find the claude CLI binary
 */
function findClaudeCli(): string | null {
  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    join(process.env.HOME!, '.npm-global', 'bin', 'claude'),
    join(process.env.HOME!, '.local', 'bin', 'claude'),
    join(process.env.HOME!, '.bun', 'bin', 'claude'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Try PATH lookup
  try {
    const which = execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (which) return which;
  } catch {}
  return null;
}

/**
 * Get the extraction system prompt from the fabric pattern file
 */
function getExtractionPrompt(): string {
  try {
    const patternPath = getExtractPatternPath();
    if (existsSync(patternPath)) {
      return readFileSync(patternPath, 'utf-8').trim();
    }
  } catch {}
  // Inline fallback if pattern file missing
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

/**
 * Extract using the claude CLI (primary method)
 * Uses Claude Code's existing authentication — no separate API key needed.
 * Calls `claude -p --model haiku` with the extraction prompt piped via stdin.
 */
async function extractWithClaude(messages: string): Promise<string | null> {
  const claudePath = findClaudeCli();
  if (!claudePath) {
    console.error('[FabricExtract] claude CLI not found in PATH');
    return null;
  }

  const systemPrompt = getExtractionPrompt();

  // Truncate to fit context window (~180K chars ≈ ~45K tokens, well within haiku's 200K)
  // But keep it reasonable to control cost
  const maxChars = 120000;
  const truncated = messages.length > maxChars ? messages.slice(-maxChars) : messages;

  const userMessage = `${systemPrompt}\n\n---\n\nExtract the key information from this AI coding session transcript:\n\n${truncated}`;

  try {
    const result = execSync(
      `"${claudePath}" -p --model ${CLAUDE_CLI_MODEL} --output-format text --setting-sources ""`,
      {
        input: userMessage,
        encoding: 'utf-8',
        timeout: 300000, // 5 minute timeout
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CLAUDECODE: '' },
      }
    );

    const text = result?.trim();
    if (text && text.length > 50) {
      console.error(`[FabricExtract] Claude CLI extraction successful (model=${CLAUDE_CLI_MODEL}, ${text.length} chars)`);
      logExtract(`Claude CLI extraction successful: model=${CLAUDE_CLI_MODEL}, output_chars=${text.length}`);
      return text;
    }
    console.error('[FabricExtract] Claude CLI returned empty/short response');
    return null;
  } catch (error: any) {
    console.error(`[FabricExtract] Claude CLI extraction failed: ${error.message}`);
    return null;
  }
}

/**
 * Chunked extraction for large files (>120K chars of messages)
 * Splits messages into chunks, extracts each, then meta-extracts a final summary
 */
async function extractWithClaudeChunked(messages: string): Promise<string | null> {
  const claudePath = findClaudeCli();
  if (!claudePath) return null;

  const CHUNK_SIZE = 80000; // ~20K tokens per chunk, well within limits
  const chunks: string[] = [];

  // Split by lines to avoid breaking mid-message
  const lines = messages.split('\n');
  let currentChunk = '';
  for (const line of lines) {
    if (currentChunk.length + line.length > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
    currentChunk += line + '\n';
  }
  if (currentChunk.trim()) chunks.push(currentChunk);

  console.error(`[FabricExtract] CHUNKED: Splitting ${messages.length} chars into ${chunks.length} chunks`);
  logExtract(`CHUNKED: ${messages.length} chars -> ${chunks.length} chunks`);

  // Extract each chunk
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.error(`[FabricExtract] CHUNKED: Extracting chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    const result = await extractWithClaude(chunks[i]);
    if (result) {
      partials.push(`--- Chunk ${i + 1}/${chunks.length} ---\n${result}`);
    }
    // Rate limit between chunks
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (partials.length === 0) return null;

  // If only one chunk succeeded, use it directly
  if (partials.length === 1) return partials[0].replace(/^--- Chunk \d+\/\d+ ---\n/, '');

  // Meta-extract: merge partial extractions into final summary
  console.error(`[FabricExtract] CHUNKED: Meta-extracting ${partials.length} partial results`);
  const mergePrompt = partials.join('\n\n');

  const systemPrompt = `You are merging multiple partial session extractions into one coherent summary. Combine all findings, deduplicate, and output in this exact format:

## ONE SENTENCE SUMMARY
[Single comprehensive sentence covering the full session]

## MAIN IDEAS
- [Key ideas from ALL chunks combined]

## DECISIONS MADE
- [All decisions from all chunks]

## THINGS TO REJECT / AVOID
- [All rejections from all chunks]

## ERRORS FIXED
- [All errors from all chunks]

## SESSION CONTEXT
[One comprehensive sentence about the full session's impact]`;

  const userMessage = `${systemPrompt}\n\n---\n\nMerge these ${partials.length} partial extractions into one comprehensive summary:\n\n${mergePrompt}`;

  try {
    const result = execSync(
      `"${claudePath}" -p --model ${CLAUDE_CLI_MODEL} --output-format text --setting-sources ""`,
      {
        input: userMessage,
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CLAUDECODE: '' },
      }
    );

    const text = result?.trim();
    if (text && text.length > 50) {
      console.error(`[FabricExtract] CHUNKED: Meta-extraction successful`);
      logExtract(`CHUNKED: Meta-extraction successful, output_chars=${text.length}`);
      return text;
    }
  } catch (err: any) {
    console.error(`[FabricExtract] CHUNKED: Meta-extraction failed: ${err.message}`);
  }

  // Fallback: concatenate partials
  return partials.map((p) => p.replace(/^--- Chunk \d+\/\d+ ---\n/, '')).join('\n\n');
}

/**
 * Extract using local Ollama LLM as fallback
 * Returns extracted text or null if failed
 */
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
    // Truncate messages to fit 3B model context (keep last ~8000 chars)
    const truncated = messages.length > 8000 ? messages.slice(-8000) : messages;

    const payload = JSON.stringify({
      model: LOCAL_OLLAMA_MODEL,
      prompt: systemPrompt + '\n\n---\nCONVERSATION:\n' + truncated,
      stream: false,
    });

    const result = execSync(
      `curl -s --connect-timeout 10 --max-time 180 -X POST ${LOCAL_OLLAMA_URL} -H "Content-Type: application/json" -d @-`,
      {
        input: payload,
        encoding: 'utf-8',
        timeout: 200000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const parsed = JSON.parse(result);
    if (parsed.response && parsed.response.trim().length > 50) {
      console.error('[FabricExtract] Ollama extraction successful');
      return parsed.response.trim();
    }
    return null;
  } catch (error: any) {
    console.error(`[FabricExtract] Ollama extraction failed: ${error.message}`);
    return null;
  }
}

/**
 * Run the extraction-model cascade over raw transcript/markdown text: Claude CLI
 * (chunked for very large inputs) with a local Ollama fallback. Returns the
 * extracted markdown, or null if every method failed. Shared by the Stop path
 * (RecallExtract.ts) and the in-session path (RecallInSession.ts), injected into
 * runExtractCore as deps.extract.
 */
export async function runExtractionCascade(messages: string): Promise<string | null> {
  let extracted = '';

  // Attempt 1: Claude CLI (uses Claude Code's existing auth — no API key needed).
  // Chunked extraction for large files (>120K chars).
  if (messages.length > 120000) {
    console.error(`[FabricExtract] Large input (${messages.length} chars), using chunked extraction...`);
    const chunkedResult = await extractWithClaudeChunked(messages);
    if (chunkedResult) extracted = chunkedResult;
  } else {
    console.error('[FabricExtract] Trying Claude CLI extraction...');
    const claudeResult = await extractWithClaude(messages);
    if (claudeResult) extracted = claudeResult;
  }

  // Attempt 2: local Ollama LLM fallback (free, lower quality).
  if (!extracted) {
    console.error('[FabricExtract] Claude CLI failed, trying local Ollama LLM fallback...');
    const ollamaResult = extractWithOllama(messages);
    if (ollamaResult) extracted = ollamaResult;
  }

  return extracted || null;
}

/**
 * Extract topics from fabric output
 * Matches both "## HEADING" markdown format and "HEADING:" legacy format
 */
export function extractTopics(fabricOutput: string): string[] {
  const topics: string[] = [];

  // Extract from DECISIONS MADE, MAIN IDEAS, and INSIGHTS sections
  const patterns = [
    /(?:##\s*DECISIONS\s*MADE|DECISIONS:)\s*([\s\S]*?)(?=\n##\s|$)/,
    /(?:##\s*MAIN\s*IDEAS|MAIN_IDEAS:)\s*([\s\S]*?)(?=\n##\s|$)/,
    /(?:##\s*INSIGHTS|INSIGHTS:)\s*([\s\S]*?)(?=\n##\s|$)/,
  ];

  for (const pattern of patterns) {
    const match = fabricOutput.match(pattern);
    if (match) {
      const lines = match[1].split('\n').filter((l) => l.trim().startsWith('-'));
      for (const line of lines.slice(0, 3)) {
        // Max 3 per section
        // Strip markdown bold markers and leading bullet
        const topic = line.replace(/^-\s*/, '').replace(/\*\*/g, '').split(':')[0].trim();
        if (topic && topic.length < 50) {
          topics.push(topic);
        }
      }
    }
  }

  return [...new Set(topics)].slice(0, 5); // Dedupe, max 5
}

/** Pull the "## ONE SENTENCE SUMMARY" line from extracted markdown, else a label fallback. */
export function deriveSummary(extracted: string, fallbackLabel: string): string {
  const summaryMatch = extracted.match(/##\s*ONE\s*SENTENCE\s*SUMMARY\s*\n+(.+)/);
  return summaryMatch ? summaryMatch[1].trim() : `${fallbackLabel} session`;
}
