/**
 * Shared OpenCode runtime plumbing for the isolated e2e scripts.
 *
 * The pinned version lives here only — `scripts/e2e-opencode.ts` and
 * `scripts/e2e-opencode-runtime.ts` both resolve the CLI through this module so
 * a version bump is a one-line change rather than a hunt across scripts.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * The OpenCode release the adapter's runtime contract is verified against.
 *
 * `docs/OPENCODE_INTEGRATION.md` records the measured `session.idle` frequency
 * next to this version; bump both together, and re-run
 * `bun run test:e2e:opencode:runtime` so the recorded number stays honest.
 */
export const OPENCODE_PINNED_VERSION = '1.18.5';

/** Resolve the OpenCode CLI: an explicit binary, else the pinned npm package. */
export function openCodeCommand(args: string[]): { command: string; args: string[] } {
  if (process.env.OPENCODE_BIN) return { command: process.env.OPENCODE_BIN, args };
  return {
    command: 'bunx',
    args: ['--yes', '--package', `opencode-ai@${OPENCODE_PINNED_VERSION}`, 'opencode', ...args],
  };
}

/** Run the OpenCode CLI and return stdout, throwing with full output on failure. */
export function runOpenCode(args: string[], env: Record<string, string>, cwd: string, timeout = 180_000): string {
  const resolved = openCodeCommand(args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd, env, encoding: 'utf-8', timeout, maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${resolved.command} ${resolved.args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

/**
 * Put `opencode` on PATH for anything the runtime spawns.
 *
 * The extraction plugin shells out to `opencode export <id>`, so the CLI has to
 * be resolvable by name — exactly as it is in a real install. Without this the
 * plugin's export fails with `command not found` and the drop is never written.
 */
export function writeOpenCodeShim(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const resolved = openCodeCommand([]);
  const target = join(binDir, 'opencode');
  writeFileSync(
    target,
    `#!/bin/sh\nexec ${JSON.stringify(resolved.command)} ${resolved.args.map(a => JSON.stringify(a)).join(' ')} "$@"\n`,
    { mode: 0o755 },
  );
}

/**
 * A local OpenAI-compatible chat-completions stub.
 *
 * Keeps the runtime e2e hermetic: what is under test is OpenCode's own session
 * lifecycle and event emission, not a model's output, so the reply only has to
 * be well-formed and deterministic. Echoing the prompt lets a test assert that
 * a specific turn reached the transcript.
 */
export function startStubProvider(port: number): { stop: () => void; baseURL: string } {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] });
      }
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });

      const body = await req.json() as { messages?: unknown[]; model?: string; stream?: boolean };
      const lastUser = [...(body.messages ?? [])].reverse()
        .find((m): m is { role: string; content: unknown } =>
          typeof m === 'object' && m !== null && (m as { role?: string }).role === 'user');
      const raw = typeof lastUser?.content === 'string'
        ? lastUser.content
        : (Array.isArray(lastUser?.content) ? lastUser.content : [])
            .map(part => (typeof part === 'object' && part !== null ? String((part as { text?: string }).text ?? '') : ''))
            .join(' ');
      const reply = `STUB_REPLY(${raw.trim().slice(0, 120)})`;
      const id = 'chatcmpl-recall-stub';
      const model = body.model ?? 'stub-model';
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

      if (!body.stream) {
        return Response.json({
          id, object: 'chat.completion', created, model, usage,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        });
      }

      const frames = [
        { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] },
        { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
      ];
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    },
  });
  return { stop: () => server.stop(true), baseURL: `http://127.0.0.1:${port}/v1` };
}

/** The OpenCode config block that points every turn at the local stub provider. */
export function stubProviderConfig(baseURL: string): Record<string, unknown> {
  return {
    provider: {
      recallstub: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Recall Stub Provider',
        options: { baseURL, apiKey: 'recall-stub-key' },
        models: { 'stub-model': { name: 'Recall Stub Model' } },
      },
    },
    model: 'recallstub/stub-model',
  };
}

/** Collect OpenCode's own server-sent events until `stop()` is called. */
export function collectEvents(serverBase: string): {
  events: { at: number; type: string; sessionID?: string }[];
  stop: () => void;
} {
  const events: { at: number; type: string; sessionID?: string }[] = [];
  const controller = new AbortController();

  void (async () => {
    const res = await fetch(`${serverBase}/event`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const parsed = JSON.parse(line.slice(5).trim()) as { type?: string; properties?: { sessionID?: string } };
            if (typeof parsed.type === 'string') {
              events.push({ at: Date.now(), type: parsed.type, sessionID: parsed.properties?.sessionID });
            }
          } catch {
            // a partial or non-JSON frame is not evidence of anything — skip it
          }
        }
      }
    }
  })().catch(() => {
    // the stream is aborted at teardown; that rejection is expected
  });

  return { events, stop: () => controller.abort() };
}
