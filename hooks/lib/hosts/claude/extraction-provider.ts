import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { ExtractionProvider } from '../../extraction-provider';

const CLAUDE_CLI_MODEL = 'haiku';
const MAX_DIRECT_CHARS = 120000;
const CHUNK_SIZE = 80000;

function getMemoryDir(): string {
  return join(process.env.HOME!, '.claude', 'MEMORY');
}

function logExtract(message: string): void {
  try {
    appendFileSync(
      join(getMemoryDir(), 'EXTRACT_LOG.txt'),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf-8',
    );
  } catch {
    // Claude lifecycle logging is best-effort.
  }
}

export function findClaudeCli(): string | null {
  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    join(process.env.HOME!, '.npm-global', 'bin', 'claude'),
    join(process.env.HOME!, '.local', 'bin', 'claude'),
    join(process.env.HOME!, '.bun', 'bin', 'claude'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

function getExtractionPrompt(): string {
  try {
    const patternPath = join(getMemoryDir(), 'extract_prompt.md');
    if (existsSync(patternPath)) return readFileSync(patternPath, 'utf-8').trim();
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

function runClaude(claudePath: string, input: string): string | null {
  try {
    const result = execFileSync(
      claudePath,
      ['-p', '--model', CLAUDE_CLI_MODEL, '--output-format', 'text', '--setting-sources', ''],
      {
        input,
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          ...(process.env.RECALL_NESTED_EXTRACTION ? { CLAUDECODE: '' } : {}),
        },
      },
    );
    const text = result?.trim();
    return text && text.length > 50 ? text : null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FabricExtract] Claude CLI extraction failed: ${message}`);
    return null;
  }
}

async function extractDirect(messages: string, claudePath: string): Promise<string | null> {
  const truncated = messages.length > MAX_DIRECT_CHARS ? messages.slice(-MAX_DIRECT_CHARS) : messages;
  const input = `${getExtractionPrompt()}\n\n---\n\nExtract the key information from this AI coding session transcript:\n\n${truncated}`;
  const text = runClaude(claudePath, input);
  if (text) {
    console.error(`[FabricExtract] Claude CLI extraction successful (model=${CLAUDE_CLI_MODEL}, ${text.length} chars)`);
    logExtract(`Claude CLI extraction successful: model=${CLAUDE_CLI_MODEL}, output_chars=${text.length}`);
  } else {
    console.error('[FabricExtract] Claude CLI returned empty/short response');
  }
  return text;
}

function splitChunks(messages: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of messages.split('\n')) {
    if (current.length + line.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function extractChunked(messages: string, claudePath: string): Promise<string | null> {
  const chunks = splitChunks(messages);
  console.error(`[FabricExtract] CHUNKED: Splitting ${messages.length} chars into ${chunks.length} chunks`);
  logExtract(`CHUNKED: ${messages.length} chars -> ${chunks.length} chunks`);

  const partials: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    console.error(`[FabricExtract] CHUNKED: Extracting chunk ${index + 1}/${chunks.length} (${chunks[index].length} chars)`);
    const result = await extractDirect(chunks[index], claudePath);
    if (result) partials.push(`--- Chunk ${index + 1}/${chunks.length} ---\n${result}`);
    if (index < chunks.length - 1) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (partials.length === 0) return null;
  if (partials.length === 1) return partials[0].replace(/^--- Chunk \d+\/\d+ ---\n/, '');

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
  const input = `${systemPrompt}\n\n---\n\nMerge these ${partials.length} partial extractions into one comprehensive summary:\n\n${partials.join('\n\n')}`;
  const merged = runClaude(claudePath, input);
  if (merged) {
    logExtract(`CHUNKED: Meta-extraction successful, output_chars=${merged.length}`);
    return merged;
  }
  return partials.map(partial => partial.replace(/^--- Chunk \d+\/\d+ ---\n/, '')).join('\n\n');
}

export const claudeExtractionProvider: ExtractionProvider = {
  id: 'claude-cli',
  async extract(messages) {
    const claudePath = findClaudeCli();
    if (!claudePath) {
      console.error('[FabricExtract] claude CLI not found in PATH');
      return null;
    }
    return messages.length > MAX_DIRECT_CHARS
      ? extractChunked(messages, claudePath)
      : extractDirect(messages, claudePath);
  },
};
