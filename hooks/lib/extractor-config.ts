// Canonical Extractor config resolver. Hooks consume this file; src/ re-exports it.
// Dependency-free: no imports from src/.

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { scrub } from './write-safety';

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

function loadConfigText(
  options: ResolveExtractorConfigOptions,
): { text: string | null; error: string | null } {
  const env = options.env ?? process.env;
  if (options.fileText !== undefined) return { text: options.fileText, error: null };
  const path = options.configPath ?? defaultExtractorConfigPath(env);
  const read = readConfigFile(path);
  if (read.unreadable) return { text: null, error: `config.json could not be read at ${path}` };
  return { text: read.text, error: null };
}

export function resolveExtractorConfig(
  options: ResolveExtractorConfigOptions = {},
): ResolvedExtractorConfig {
  const loaded = loadConfigText(options);
  if (loaded.error) return failBoth(loaded.error);
  if (loaded.text === null) {
    return applyEnv(
      {
        automatic: { ok: true, value: defaultAutomatic() },
        curated: { ok: true, value: defaultCurated() },
      },
      options.env ?? process.env,
    );
  }
  return applyEnv(parseFileText(loaded.text), options.env ?? process.env);
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

export const NAMED_HARNESS_IDS = ['claude', 'pi', 'opencode', 'codex', 'grok', 'jcode', 'omp', 'cursor'] as const;
export type NamedHarnessId = (typeof NAMED_HARNESS_IDS)[number];
export type LocalQueryMode = 'hybrid' | 'keyword' | 'semantic';

export type HarnessStep =
  | { kind: 'named'; id: NamedHarnessId; model: string }
  | { kind: 'command'; label: string; argv: string[]; model: string }
  | { kind: 'local'; mode: LocalQueryMode };

export interface HarnessList {
  primary: HarnessStep;
  fallback: HarnessStep[];
}

export type HarnessListResult =
  | { ok: true; absent: true }
  | { ok: true; absent: false; value: HarnessList }
  | { ok: false; error: string };

export interface ResolvedHarnessConfig {
  query: HarnessListResult;
  automatic: HarnessListResult;
  curated: HarnessListResult;
  cluster: HarnessListResult;
}

const NAMED_HARNESS: Record<string, true> = {
  claude: true,
  pi: true,
  opencode: true,
  codex: true,
  grok: true,
  jcode: true,
  omp: true,
  cursor: true,
};

const LOCAL_MODES: Record<string, true> = { hybrid: true, keyword: true, semantic: true };

function failHarness(error: string): ResolvedHarnessConfig {
  const failed = { ok: false as const, error };
  return { query: failed, automatic: failed, curated: failed, cluster: failed };
}

function absentHarness(): ResolvedHarnessConfig {
  const absent = { ok: true as const, absent: true as const };
  return { query: absent, automatic: absent, curated: absent, cluster: absent };
}

function hasApiKeyField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasApiKeyField);
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'api_key' || key === 'apiKey') return true;
    if (hasApiKeyField(child)) return true;
  }
  return false;
}

function modelOf(raw: Record<string, unknown>, pathLabel: string): PathResult<string> {
  if (raw.model === undefined || raw.model === '') return { ok: true, value: '' };
  if (typeof raw.model !== 'string') return { ok: false, error: `${pathLabel} model must be a string` };
  return { ok: true, value: raw.model.trim() };
}

function parseHarnessStep(
  raw: unknown,
  pathLabel: string,
  allowLocal: boolean,
): PathResult<HarnessStep> {
  if (!isObject(raw)) return { ok: false, error: `${pathLabel} must be an object` };
  if (hasApiKeyField(raw)) return { ok: false, error: `${pathLabel} must not contain an API key` };
  if (raw.runner === 'local') {
    if (!allowLocal) return { ok: false, error: `${pathLabel} local steps are query-only` };
    if (typeof raw.mode !== 'string' || !LOCAL_MODES[raw.mode]) {
      return { ok: false, error: `${pathLabel} local mode is not supported` };
    }
    return { ok: true, value: { kind: 'local', mode: raw.mode as LocalQueryMode } };
  }
  if (raw.argv !== undefined) {
    if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some(arg => typeof arg !== 'string' || arg === '')) {
      return { ok: false, error: `${pathLabel} command argv is empty` };
    }
    const argv = raw.argv as string[];
    if (argv.some(arg => scrub(arg).redactions.length > 0)) {
      return { ok: false, error: `${pathLabel} command argv contains a secret` };
    }
    const model = modelOf(raw, pathLabel);
    if (!model.ok) return model;
    const label = typeof raw.id === 'string' ? raw.id : '';
    return { ok: true, value: { kind: 'command', label, argv, model: model.value } };
  }
  if (typeof raw.id !== 'string' || !raw.id) return { ok: false, error: `${pathLabel} is missing a harness id` };
  if (!NAMED_HARNESS[raw.id]) return { ok: false, error: `${pathLabel} harness id "${raw.id}" is not supported` };
  const model = modelOf(raw, pathLabel);
  if (!model.ok) return model;
  return { ok: true, value: { kind: 'named', id: raw.id as NamedHarnessId, model: model.value } };
}

function parseHarnessList(
  raw: unknown,
  pathLabel: string,
  allowLocal: boolean,
): HarnessListResult {
  if (raw === undefined) return { ok: true, absent: true };
  if (!isObject(raw)) return { ok: false, error: `${pathLabel} must be an object` };
  if (hasApiKeyField(raw)) return { ok: false, error: `${pathLabel} must not contain an API key` };
  if (raw.primary === undefined) return { ok: false, error: `${pathLabel} is missing primary` };
  const primary = parseHarnessStep(raw.primary, `${pathLabel}.primary`, allowLocal);
  if (!primary.ok) return primary;
  if (raw.fallback === undefined) {
    return { ok: true, absent: false, value: { primary: primary.value, fallback: [] } };
  }
  if (!Array.isArray(raw.fallback)) return { ok: false, error: `${pathLabel}.fallback must be an array` };
  const fallback: HarnessStep[] = [];
  for (const [index, entry] of raw.fallback.entries()) {
    const step = parseHarnessStep(entry, `${pathLabel}.fallback[${index}]`, allowLocal);
    if (!step.ok) return step;
    fallback.push(step.value);
  }
  return { ok: true, absent: false, value: { primary: primary.value, fallback } };
}

export function resolveHarnessConfig(
  options: ResolveExtractorConfigOptions = {},
): ResolvedHarnessConfig {
  const loaded = loadConfigText(options);
  if (loaded.error) return failHarness(loaded.error);
  if (loaded.text === null) return absentHarness();
  let parsed: unknown;
  try {
    parsed = JSON.parse(loaded.text);
  } catch {
    return failHarness('config.json is not valid JSON');
  }
  if (!isObject(parsed)) return failHarness('config.json must be a JSON object');
  const extraction = parsed.extraction;
  const extractionObject = extraction === undefined || isObject(extraction) ? extraction : null;
  const extractionError = extraction !== undefined && !isObject(extraction)
    ? { ok: false as const, error: 'extraction must be an object' }
    : null;
  return {
    query: parseHarnessList(parsed.query, 'query', true),
    automatic: extractionError ?? parseHarnessList(
      isObject(extractionObject) ? extractionObject.automatic : undefined,
      'extraction.automatic',
      false,
    ),
    curated: extractionError ?? parseHarnessList(
      isObject(extractionObject) ? extractionObject.curated : undefined,
      'extraction.curated',
      false,
    ),
    cluster: parseHarnessList(parsed.cluster, 'cluster', false),
  };
}
