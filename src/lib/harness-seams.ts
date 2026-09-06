/**
 * In-process harness extension registry.
 *
 * Grounded in existing seams (start / drop / capture / inject). Not a
 * HostDescriptor, not a Cursor marketplace plugin, and not host-hook glue
 * for Cursor. Drop-dir hosts still extend via MEMORY/<id>-sessions/ — the
 * filesystem is that seam, so it has no registry.
 *
 * Registrations live in the current process only. The public CLI still
 * accepts `recall start --format markdown|cursor`; extra start formats
 * are for library callers of `runStart`.
 */

import { SESSION_SOURCES, type SessionSourceAdapter } from '../hosts/session-source.js';

export const HARNESS_SEAMS = ['start', 'drop', 'capture', 'inject'] as const;
export type HarnessSeam = (typeof HARNESS_SEAMS)[number];

export const BUILTIN_START_FORMATS = ['markdown', 'cursor'] as const;
export type BuiltinStartFormat = (typeof BUILTIN_START_FORMATS)[number];

export type StartFormatWrapper = (context: string) => string;

const extraStartFormats = new Map<string, StartFormatWrapper>();
const extraSessionSources: SessionSourceAdapter[] = [];

function requireId(id: string, label: string): string {
  const key = id.trim();
  if (!key) throw new Error(`${label} id must be non-empty`);
  return key;
}

export function registerStartFormat(id: string, wrap: StartFormatWrapper): () => void {
  const key = requireId(id, 'start format');
  if ((BUILTIN_START_FORMATS as readonly string[]).includes(key)) {
    throw new Error(`cannot replace built-in start format "${key}"`);
  }
  if (extraStartFormats.has(key)) {
    throw new Error(`start format "${key}" is already registered`);
  }
  extraStartFormats.set(key, wrap);
  return () => {
    extraStartFormats.delete(key);
  };
}

export function getRegisteredStartFormat(id: string): StartFormatWrapper | undefined {
  return extraStartFormats.get(id);
}

export function listStartFormats(): string[] {
  return [...BUILTIN_START_FORMATS, ...extraStartFormats.keys()];
}

export function registerSessionSource(adapter: SessionSourceAdapter): () => void {
  const id = requireId(adapter.id, 'session source');
  if ((SESSION_SOURCES as readonly string[]).includes(id)) {
    throw new Error(`cannot replace built-in session source "${id}"`);
  }
  if (extraSessionSources.some(existing => existing.id === id)) {
    throw new Error(`session source "${id}" is already registered`);
  }
  extraSessionSources.push(adapter);
  return () => {
    const index = extraSessionSources.indexOf(adapter);
    if (index >= 0) extraSessionSources.splice(index, 1);
  };
}

export function registeredSessionSources(): readonly SessionSourceAdapter[] {
  return extraSessionSources.slice();
}

/** Stable, inspectable map of the public harness seams. */
export function describeHarnessSeams() {
  return {
    seams: HARNESS_SEAMS,
    start: {
      cli: 'recall start',
      formats: listStartFormats(),
      assembler: 'hooks/lib/session-start-context.ts',
    },
    drop: {
      dir: 'MEMORY/<host>-sessions/',
      parser: 'parseMarkdownDrop',
      note: 'Filesystem convention; no registry. A new drop-dir host writes markdown there instead of copying extract/precompact templates.',
    },
    capture: {
      cursor: 'catalogCursorSessions',
      dump: 'discoverCurrentSession',
      hostHook: 'hidden recall host-hook (Codex/Grok/jcode only; Cursor never joins)',
    },
    inject: {
      cursorCommand: 'recall start --format cursor',
      cursorWrapper: '{ additional_context }',
      note: 'No Cursor marketplace plugin. Cursor.app GUI PATH typically lacks ~/.bun/bin; durable PATH / recall start --format cursor accuracy is pending FM-321/327.',
    },
    mcp: { server: 'recall-memory', bin: 'recall-mcp' },
    skills: { canonical: 'agent-skills/' },
    nonGoals: [
      'HostDescriptor',
      'Cursor marketplace plugin',
      'Cursor host-hook glue',
      'adapter-to-plugin rename',
    ],
  } as const;
}
