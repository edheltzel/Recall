import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  JCODE_CLI_PATH,
  JCODE_HARNESS,
  captureJcode,
  jcodeSkipMessage,
  requestFromJcodeHook,
  type RunCapture,
} from '../../hosts/jcode/capture';

const PRODUCTION_DB = join(homedir(), '.agents', 'Recall', 'recall.db');
const ADAPTER_SOURCE = readFileSync(join(import.meta.dir, '../../hosts/jcode/capture.ts'), 'utf8');

function productionStamp(): number | null {
  return existsSync(PRODUCTION_DB) ? statSync(PRODUCTION_DB).mtimeMs : null;
}

async function withStderr(
  fn: () => Promise<void>,
): Promise<string> {
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = stderrWrite;
  }
  return stderr;
}

describe('jcode capture helper', () => {
  test('supplied text invokes recall capture for turn_end and session_end', async () => {
    const calls: Array<{ file: string; args: readonly string[]; stdin: string }> = [];
    const run: RunCapture = async (file, args, stdin) => {
      calls.push({ file, args, stdin });
      return 0;
    };
    const before = productionStamp();

    for (const event of ['turn_end', 'session_end'] as const) {
      const decision = await captureJcode(
        {
          source: 'supplied',
          event,
          text: `fixture ${event}`,
          sessionId: 'sess-j',
          cwd: '/work/Recall',
          project: 'Recall',
        },
        run,
      );
      expect(decision).toEqual({
        action: 'invoke',
        args: [
          'capture',
          '--contract',
          '1',
          '--harness',
          JCODE_HARNESS,
          '--event',
          event,
          '--session-id',
          'sess-j',
          '--cwd',
          '/work/Recall',
          '--project',
          'Recall',
        ],
        stdin: `fixture ${event}`,
      });
    }

    expect(calls).toHaveLength(2);
    expect(calls[0].file).toBe('bun');
    expect(calls[0].args[0]).toBe(JCODE_CLI_PATH);
    expect(calls[0].args).toContain('--harness');
    expect(calls[0].args).toContain('jcode');
    expect(calls[0].args).toContain('turn_end');
    expect(calls[1].args).toContain('session_end');
    expect(JCODE_CLI_PATH).toBe(join(import.meta.dir, '../../dist/index.js'));
    expect(productionStamp()).toBe(before);
  });

  test('hook env and missing history skip without spawning', async () => {
    let spawned = false;
    const run: RunCapture = async () => {
      spawned = true;
      return 0;
    };
    const hook = requestFromJcodeHook({
      JCODE_HOOK_EVENT: 'turn_end',
      JCODE_HOOK_SESSION_ID: 'sess-hook',
      JCODE_HOOK_CWD: '/work',
      JCODE_HOOK_LAST_ASSISTANT_TEXT: 'truncated assistant text',
      JCODE_HOOK_PAYLOAD: JSON.stringify({ watermark: 'not-a-verified-field', text: 'secret' }),
    });

    const stderr = await withStderr(async () => {
      const hookDecision = await captureJcode(hook, run);
      expect(hookDecision).toEqual({ action: 'skip', reason: 'no-public-watermark' });
      const history = await captureJcode(
        { source: 'host-history', event: 'session_end', text: 'whole history again' },
        run,
      );
      expect(history).toEqual({ action: 'skip', reason: 'no-public-watermark' });
      const empty = await captureJcode({ event: 'turn_end', text: '   ' }, run);
      expect(empty).toEqual({ action: 'skip', reason: 'missing-text' });
    });

    expect(spawned).toBe(false);
    expect(stderr).toContain(jcodeSkipMessage('no-public-watermark'));
    expect(stderr).toContain(jcodeSkipMessage('missing-text'));
    expect(stderr).not.toContain('truncated assistant text');
    expect(stderr).not.toContain('whole history again');
    expect(hook).not.toHaveProperty('text');
    expect(hook).not.toHaveProperty('watermark');
  });

  test('private session path is not opened and does not write the Recall db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcode-capture-'));
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(sessionFile, 'private history');
    let spawned = false;
    const before = productionStamp();

    const stderr = await withStderr(async () => {
      const decision = await captureJcode(
        {
          source: 'supplied',
          event: 'session_end',
          text: 'do not store this from a file',
          sessionFile,
        },
        async () => {
          spawned = true;
          return 0;
        },
      );
      expect(decision).toEqual({ action: 'skip', reason: 'unsafe-history' });
    });

    expect(spawned).toBe(false);
    expect(readFileSync(sessionFile, 'utf8')).toBe('private history');
    expect(stderr).toBe(`${jcodeSkipMessage('unsafe-history')}\n`);
    expect(stderr).not.toContain('do not store this');
    expect(productionStamp()).toBe(before);
    expect(ADAPTER_SOURCE).not.toContain('bun:sqlite');
    expect(ADAPTER_SOURCE).not.toContain('recall.db');
    expect(ADAPTER_SOURCE).not.toContain('writeFile');
    expect(ADAPTER_SOURCE).not.toContain('readFile');
  });

  test('nonzero capture child logs failure and does not throw', async () => {
    const stderr = await withStderr(async () => {
      const decision = await captureJcode(
        { event: 'turn_end', text: 'kept by core' },
        async () => 1,
      );
      expect(decision.action).toBe('invoke');
    });
    expect(stderr).toContain('Recall jcode capture failed');
    expect(stderr).not.toContain('kept by core');
  });

  test('package files list ships the helper', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('hosts/jcode/');
  });
});
