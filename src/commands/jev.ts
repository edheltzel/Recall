import { resolveJevKey, scoreCandidate } from '../providers/jev.js';

export const JEV_KEY_URL = 'https://console.typesafe.ai/keys';

const KEY_HELP = [
  'JEV_RECALL_KEY is not set.',
  `Get a TypeSafe API key: ${JEV_KEY_URL}`,
  'Set it in the environment or in ~/.env. A non-blank environment value wins.',
].join('\n');

export interface RunJevInput {
  text?: string;
  kind?: string;
  project?: string;
}

export interface RunJevIo {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  readStdin?: () => Promise<string>;
  readKey?: () => Promise<string>;
  score?: typeof scoreCandidate;
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function readHiddenKey(): Promise<string> {
  process.stderr.write('Paste the key for this run. It is not saved or printed. Blank line cancels: ');
  if (!process.stdin.isTTY) return '';
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let key = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of process.stdin) {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
      for (const ch of text) {
        if (ch === '\u0003') {
          process.stderr.write('\n');
          return '';
        }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stderr.write('\n');
          return key.trim();
        }
        if (ch === '\u007f' || ch === '\b') {
          key = key.slice(0, -1);
          continue;
        }
        if (ch < ' ') continue;
        key += ch;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return key.trim();
}

export async function runJev(input: RunJevInput, io: RunJevIo = {}): Promise<void> {
  const env = io.env ?? process.env;
  const isTTY = io.isTTY ?? process.stdin.isTTY === true;
  const writeErr = io.writeErr ?? ((line: string) => console.error(line));
  const writeOut = io.writeOut ?? ((line: string) => console.log(line));
  const score = io.score ?? scoreCandidate;
  const text = present(input.text)
    ?? (isTTY ? '' : (await (io.readStdin ?? (() => Bun.stdin.text()))()).trim());
  if (!text) {
    writeErr('Pass candidate memory text as an argument or on stdin.');
    process.exitCode = 1;
    return;
  }

  let apiKey = resolveJevKey(env, env.HOME ?? env.USERPROFILE);
  if (!apiKey) {
    writeErr(KEY_HELP);
    if (!isTTY) {
      process.exitCode = 1;
      return;
    }
    apiKey = present(await (io.readKey ?? readHiddenKey)());
    if (!apiKey) {
      process.exitCode = 1;
      return;
    }
  }

  try {
    const decision = await score({
      text,
      kind: present(input.kind),
      project: present(input.project),
    }, { apiKey, env });
    writeOut(JSON.stringify(decision));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErr(apiKey && message.includes(apiKey) ? 'Jev request failed' : message);
    process.exitCode = 1;
  }
}
