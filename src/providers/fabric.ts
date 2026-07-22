import { execFileSync } from 'child_process';

export const MAX_FABRIC_INPUT_BYTES = 50 * 1024 * 1024;

/** Fabric owns its command, provider/model selection, and authentication. */
export function extractWisdomWithFabric(
  content: string,
  model: string = process.env.RECALL_FABRIC_MODEL || 'claude-haiku-4-5',
): string {
  const inputBytes = Buffer.byteLength(content, 'utf-8');
  if (inputBytes > MAX_FABRIC_INPUT_BYTES) {
    throw new Error(`Input too large for Fabric (${(inputBytes / 1024 / 1024).toFixed(1)}MB > 50MB limit). Use --limit to reduce message count.`);
  }

  try {
    return execFileSync('fabric', ['--pattern', 'extract_wisdom', '--stream', '-m', model], {
      input: content,
      encoding: 'utf-8',
      maxBuffer: MAX_FABRIC_INPUT_BYTES,
      timeout: 600000,
    }).trim();
  } catch (error) {
    throw new Error(`Fabric extract_wisdom failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
