// Canonical Extractor config resolver. Hooks consume this file; src/ re-exports it.
// Dependency-free: no imports from src/.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type AutomaticExtractorId = 'claude-cli' | 'ollama';
export type CuratedExtractorId = 'fabric';

export interface ExtractorStep {
  id: string;
  model: string;
}

export type PathResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface AutomaticExtractorConfig {
  primary: ExtractorStep;
  fallback: ExtractorStep[];
}

export interface CuratedExtractorConfig {
  primary: ExtractorStep;
}

export interface ResolvedExtractorConfig {
  automatic: PathResult<AutomaticExtractorConfig>;
  curated: PathResult<CuratedExtractorConfig>;
}

export class ExtractorConfigError extends Error {
  readonly extractorPath: 'automatic' | 'curated' | 'both';

  constructor(message: string, extractorPath: 'automatic' | 'curated' | 'both' = 'both') {
    super(message);
    this.name = 'ExtractorConfigError';
    this.extractorPath = extractorPath;
  }
}

export interface ResolveExtractorConfigOptions {
  /** Injected contents. `null` = missing file. Omit to read disk. */
  fileText?: string | null;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

const AUTOMATIC_IDS: Record<string, true> = { 'claude-cli': true, ollama: true };
const CURATED_IDS: Record<string, true> = { fabric: true };

const DEFAULT_MODEL_FOR: Record<string, string> = {
  'claude-cli': 'haiku',
  ollama: 'qwen2.5:3b',
  fabric: 'claude-haiku-4-5',
};

export function defaultExtractorConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, '.agents', 'Recall', 'config.json');
}

function defaultAutomatic(): AutomaticExtractorConfig {
  return {
    primary: { id: 'claude-cli', model: DEFAULT_MODEL_FOR['claude-cli'] },
    fallback: [{ id: 'ollama', model: DEFAULT_MODEL_FOR.ollama }],
  };
}

function defaultCurated(): CuratedExtractorConfig {
  return { primary: { id: 'fabric', model: DEFAULT_MODEL_FOR.fabric } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): { text: string | null; unreadable: boolean } {
  try {
    return { text: readFileSync(path, 'utf-8'), unreadable: false };
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return { text: null, unreadable: false };
    return { text: null, unreadable: true };
  }
}

function failBoth(error: string): ResolvedExtractorConfig {
  return {
    automatic: { ok: false, error },
    curated: { ok: false, error },
  };
}

function parseStep(
  raw: unknown,
  allowlist: Record<string, true>,
  pathLabel: string,
): PathResult<ExtractorStep> {
  if (!isObject(raw)) {
    return { ok: false, error: `${pathLabel} must be an object` };
  }
  const id = raw.id;
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: `${pathLabel} is missing Extractor id` };
  }
  if (!allowlist[id]) {
    return { ok: false, error: `${pathLabel} Extractor id "${id}" is not allowed` };
  }
  const model = typeof raw.model === 'string' && raw.model.trim()
    ? raw.model.trim()
    : (DEFAULT_MODEL_FOR[id] ?? '');
  return { ok: true, value: { id, model } };
}

function parseAutomatic(raw: unknown): PathResult<AutomaticExtractorConfig> {
  if (raw === undefined) return { ok: true, value: defaultAutomatic() };
  const primary = parseStep(raw, AUTOMATIC_IDS, 'automatic');
  if (!primary.ok) return primary;
  if (!isObject(raw)) return { ok: false, error: 'automatic must be an object' };
  const fallbackRaw = raw.fallback;
  if (fallbackRaw === undefined) {
    return { ok: true, value: { primary: primary.value, fallback: [] } };
  }
  if (!Array.isArray(fallbackRaw)) {
    return { ok: false, error: 'automatic.fallback must be an array' };
  }
  const fallback: ExtractorStep[] = [];
  for (const [index, entry] of fallbackRaw.entries()) {
    const step = parseStep(entry, AUTOMATIC_IDS, `automatic.fallback[${index}]`);
    if (!step.ok) return step;
    fallback.push(step.value);
  }
  return { ok: true, value: { primary: primary.value, fallback } };
}

function parseCurated(raw: unknown): PathResult<CuratedExtractorConfig> {
  if (raw === undefined) return { ok: true, value: defaultCurated() };
  const primary = parseStep(raw, CURATED_IDS, 'curated');
  if (!primary.ok) return primary;
  return { ok: true, value: { primary: primary.value } };
}

function applyEnv(
  resolved: ResolvedExtractorConfig,
  env: NodeJS.ProcessEnv,
): ResolvedExtractorConfig {
  const fabricModel = env.RECALL_FABRIC_MODEL?.trim();
  const ollamaModel = env.Recall_OLLAMA_MODEL?.trim();
  const automatic = resolved.automatic.ok
    ? {
        ok: true as const,
        value: {
          primary: ollamaModel && resolved.automatic.value.primary.id === 'ollama'
            ? { ...resolved.automatic.value.primary, model: ollamaModel }
            : resolved.automatic.value.primary,
          fallback: resolved.automatic.value.fallback.map(step =>
            ollamaModel && step.id === 'ollama' ? { ...step, model: ollamaModel } : step,
          ),
        },
      }
    : resolved.automatic;
  const curated = resolved.curated.ok && fabricModel
    ? { ok: true as const, value: { primary: { ...resolved.curated.value.primary, model: fabricModel } } }
    : resolved.curated;
  return { automatic, curated };
}

function parseFileText(text: string): ResolvedExtractorConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failBoth('config.json is not valid JSON');
  }
  if (!isObject(parsed)) {
    return failBoth('config.json must be a JSON object');
  }
  if (parsed.extractor === undefined) {
    return {
      automatic: { ok: true, value: defaultAutomatic() },
      curated: { ok: true, value: defaultCurated() },
    };
  }
  if (!isObject(parsed.extractor)) {
    return failBoth('extractor must be an object');
  }
  return {
    automatic: parseAutomatic(parsed.extractor.automatic),
    curated: parseCurated(parsed.extractor.curated),
  };
}

export function resolveExtractorConfig(
  options: ResolveExtractorConfigOptions = {},
): ResolvedExtractorConfig {
  const env = options.env ?? process.env;
  let text: string | null;
  if (options.fileText !== undefined) {
    text = options.fileText;
  } else {
    const path = options.configPath ?? defaultExtractorConfigPath(env);
    const read = readConfigFile(path);
    if (read.unreadable) return failBoth(`config.json could not be read at ${path}`);
    text = read.text;
  }
  if (text === null) {
    return applyEnv(
      {
        automatic: { ok: true, value: defaultAutomatic() },
        curated: { ok: true, value: defaultCurated() },
      },
      env,
    );
  }
  return applyEnv(parseFileText(text), env);
}

export function requireAutomaticExtractor(
  resolved: ResolvedExtractorConfig = resolveExtractorConfig(),
): AutomaticExtractorConfig {
  if (!resolved.automatic.ok) {
    throw new ExtractorConfigError(resolved.automatic.error, 'automatic');
  }
  return resolved.automatic.value;
}

export function requireCuratedExtractor(
  resolved: ResolvedExtractorConfig = resolveExtractorConfig(),
): CuratedExtractorConfig {
  if (!resolved.curated.ok) {
    throw new ExtractorConfigError(resolved.curated.error, 'curated');
  }
  return resolved.curated.value;
}
