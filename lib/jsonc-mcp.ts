#!/usr/bin/env bun

// Small, dependency-free JSONC editor for the lifecycle scripts. The published
// Recall package ships lib/ but not node_modules/, so installer/uninstaller
// config repair cannot require the repository's jsonc-parser installation.

import { closeSync, existsSync, fchmodSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { randomBytes } from 'crypto';

type JsonObject = Record<string, unknown>;
type Property = { key: string; keyStart: number; value: Node };
type Node = {
  start: number;
  end: number;
  value: unknown;
  properties?: Property[];
  contentEnd?: number;
  trailingComma?: boolean;
  hasComments?: boolean;
};

class JsoncParser {
  private index = 0;
  private hasComments = false;

  constructor(private readonly text: string) {}

  parse(): Node {
    this.skipSpaceAndComments();
    const root = this.value();
    this.skipSpaceAndComments();
    if (this.index !== this.text.length) throw new Error('trailing content');
    root.hasComments = this.hasComments;
    return root;
  }

  private value(): Node {
    this.skipSpaceAndComments();
    const start = this.index;
    const char = this.text[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();

    const match = this.text.slice(this.index).match(/^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error(`expected value at ${this.index}`);
    this.index += match[0].length;
    return { start, end: this.index, value: JSON.parse(match[0]) };
  }

  private string(): Node {
    const start = this.index;
    this.index++;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index++];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        const raw = this.text.slice(start, this.index);
        return { start, end: this.index, value: JSON.parse(raw) };
      }
    }
    throw new Error('unterminated string');
  }

  private object(): Node {
    const start = this.index++;
    const properties: Property[] = [];
    const value: JsonObject = Object.create(null);
    let contentEnd = this.index;
    let trailingComma = false;
    this.skipSpaceAndComments();
    while (this.text[this.index] !== '}') {
      const keyNode = this.string();
      const key = keyNode.value as string;
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error(`duplicate key ${JSON.stringify(key)} at ${keyNode.start}`);
      }
      this.skipSpaceAndComments();
      if (this.text[this.index++] !== ':') throw new Error(`expected colon at ${this.index}`);
      const child = this.value();
      properties.push({ key, keyStart: keyNode.start, value: child });
      value[key] = child.value;
      contentEnd = child.end;
      trailingComma = false;
      this.skipSpaceAndComments();
      if (this.text[this.index] === ',') {
        this.index++;
        contentEnd = this.index;
        trailingComma = true;
        this.skipSpaceAndComments();
        continue;
      }
      if (this.text[this.index] !== '}') throw new Error(`expected comma at ${this.index}`);
    }
    this.index++;
    return { start, end: this.index, value, properties, contentEnd, trailingComma };
  }

  private array(): Node {
    const start = this.index++;
    const value: unknown[] = [];
    this.skipSpaceAndComments();
    while (this.text[this.index] !== ']') {
      value.push(this.value().value);
      this.skipSpaceAndComments();
      if (this.text[this.index] === ',') {
        this.index++;
        this.skipSpaceAndComments();
        continue;
      }
      if (this.text[this.index] !== ']') throw new Error(`expected comma at ${this.index}`);
    }
    this.index++;
    return { start, end: this.index, value };
  }

  private skipSpaceAndComments(): void {
    while (this.index < this.text.length) {
      if (/\s/.test(this.text[this.index])) {
        this.index++;
        continue;
      }
      if (this.text.startsWith('//', this.index)) {
        this.hasComments = true;
        const end = this.text.indexOf('\n', this.index + 2);
        this.index = end < 0 ? this.text.length : end + 1;
        continue;
      }
      if (this.text.startsWith('/*', this.index)) {
        this.hasComments = true;
        const end = this.text.indexOf('*/', this.index + 2);
        if (end < 0) throw new Error('unterminated comment');
        this.index = end + 2;
        continue;
      }
      return;
    }
  }
}

function parse(text: string): Node {
  return new JsoncParser(text).parse();
}

export function parseJsonc(text: string): unknown {
  return parse(text).value;
}

export function readJsoncObject(file: string, emptyIfMissingOrBlank = false): JsonObject {
  if (!existsSync(file)) {
    if (emptyIfMissingOrBlank) return Object.create(null) as JsonObject;
    throw new Error(`file not found: ${file}`);
  }
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') {
    if (emptyIfMissingOrBlank) return Object.create(null) as JsonObject;
    throw new Error(`empty JSONC file: ${file}`);
  }
  const value = parseJsonc(text);
  if (!isObject(value)) throw new Error('root is not an object');
  return value;
}

/** Missing files are absent; every other stat, read, parse, or shape failure is unknown. */
export function readJsoncObjectState(file: string): Record<string, unknown> | null | undefined {
  try {
    statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return null;
  }
  try {
    return readJsoncObject(file);
  } catch {
    return null;
  }
}

export function validateClaudeConfigShape(config: unknown): asserts config is JsonObject {
  validateClaudeMcpConfigShape(config);
  if (config.hooks !== undefined) {
    if (!isObject(config.hooks)) throw new Error('hooks is not an object');
    for (const [event, entries] of Object.entries(config.hooks)) {
      if (!Array.isArray(entries)) throw new Error(`hooks.${event} is not an array`);
    }
  }
}

export function validateClaudeMcpConfigShape(config: unknown): asserts config is JsonObject {
  if (!isObject(config)) throw new Error('root is not an object');
  if (config.mcpServers !== undefined) {
    if (!isObject(config.mcpServers)) throw new Error('mcpServers is not an object');
    const recallEntry = config.mcpServers['recall-memory'];
    if (recallEntry !== undefined && !isObject(recallEntry)) {
      throw new Error('mcpServers.recall-memory is not an object');
    }
    if (isObject(recallEntry) && recallEntry.env !== undefined) {
      if (!isObject(recallEntry.env)) {
        throw new Error('mcpServers.recall-memory.env is not an object');
      }
      for (const key of ['RECALL_DB_PATH', 'MEM_DB_PATH']) {
        const value = recallEntry.env[key];
        if (value !== undefined && typeof value !== 'string') {
          throw new Error(`mcpServers.recall-memory.env.${key} is not a string`);
        }
      }
    }
  }
}

export function configuredMcpDbPath(env: unknown): string | undefined {
  if (!isObject(env)) return undefined;
  const primary = env.RECALL_DB_PATH;
  if (typeof primary === 'string' && primary.length > 0) return primary;
  const legacy = env.MEM_DB_PATH;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

export type McpDbPathSelection =
  | { status: 'selected'; path: string }
  | { status: 'conflict'; paths: string[] };

export function selectMcpDbPath(
  configuredPaths: Array<string | undefined>,
  defaultPath: string,
  runtimeOverride?: string,
): McpDbPathSelection {
  if (runtimeOverride) return { status: 'selected', path: runtimeOverride };
  const paths = [...new Set(configuredPaths.map(path => path ?? defaultPath))];
  if (paths.length > 1) return { status: 'conflict', paths };
  return { status: 'selected', path: paths[0] ?? defaultPath };
}

export interface ClaudePluginState {
  status: 'absent' | 'active' | 'disabled' | 'unknown';
  version: string | null;
}

export function classifyClaudePluginState(
  installedPlugins: unknown | null | undefined,
  settings: unknown | null | undefined,
  pluginId: string,
): ClaudePluginState {
  if (installedPlugins === undefined) return { status: 'absent', version: null };
  if (!isObject(installedPlugins)) return { status: 'unknown', version: null };
  const plugins = installedPlugins.plugins;
  if (plugins !== undefined && !isObject(plugins)) return { status: 'unknown', version: null };
  const entries = isObject(plugins) ? plugins[pluginId] : undefined;
  if (entries !== undefined && !Array.isArray(entries)) return { status: 'unknown', version: null };
  const first = entries?.[0];
  if (first !== undefined && !isObject(first)) return { status: 'unknown', version: null };
  if (!isObject(first)) return { status: 'absent', version: null };

  const version = typeof first.version === 'string' ? first.version : null;
  if (settings === null || (settings !== undefined && !isObject(settings))) {
    return { status: 'unknown', version };
  }
  const enabledPlugins = isObject(settings) ? settings.enabledPlugins : undefined;
  if (enabledPlugins !== undefined && !isObject(enabledPlugins)) {
    return { status: 'unknown', version };
  }
  const enabled = isObject(enabledPlugins) ? enabledPlugins[pluginId] : undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean') return { status: 'unknown', version };
  return { status: enabled === false ? 'disabled' : 'active', version };
}

function lstatIfPresent(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export type StagedFileWrite = {
  target: string;
  commit: () => void;
  cleanup: () => void;
};

export function stageFileAtomic(file: string, data: string | Uint8Array, modeOverride?: number): StagedFileWrite {
  const entry = lstatIfPresent(file);
  if (entry?.isSymbolicLink() && !existsSync(file)) {
    throw new Error(`refusing to replace dangling symlink: ${file}`);
  }
  const target = entry?.isSymbolicLink() ? realpathSync(file) : file;
  const mode = modeOverride === undefined
    ? existsSync(target) ? statSync(target).mode & 0o7777 : undefined
    : modeOverride & 0o7777;
  let tmp = '';
  let pending = true;
  const cleanup = () => {
    if (!pending || tmp === '') return;
    pending = false;
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
  };
  try {
    const fd = createExclusiveTemp(target, mode, (path) => { tmp = path; });
    try {
      writeAll(fd, data);
      if (mode !== undefined) fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    target,
    commit: () => {
      renameSync(tmp, target);
      pending = false;
    },
    cleanup,
  };
}

function createExclusiveTemp(target: string, mode: number | undefined, claim: (path: string) => void): number {
  let last: unknown;
  for (let attempt = 0; attempt < 128; attempt++) {
    const path = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = openSync(path, 'wx', mode ?? 0o666);
      claim(path);
      return fd;
    } catch (error) {
      last = error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw last instanceof Error ? last : new Error(`cannot create temporary file for ${target}`);
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  let offset = 0;
  while (offset < bytes.length) {
    const wrote = writeSync(fd, bytes, offset);
    if (wrote <= 0) throw new Error('short write to temporary file');
    offset += wrote;
  }
}

function writeTextAtomic(file: string, text: string): void {
  const staged = stageFileAtomic(file, text);
  try {
    staged.commit();
  } finally {
    staged.cleanup();
  }
}

export function stageJsonAtomic(file: string, value: unknown): StagedFileWrite {
  return stageFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isOnlyEmptyMcpParent(root: Node): boolean {
  if (root.hasComments || !isObject(root.value)) return false;
  const properties = root.properties ?? [];
  if (properties.length !== 1) return false;
  const parent = properties[0];
  return (parent.key === 'mcp' || parent.key === 'mcpServers')
    && isObject(parent.value.value)
    && (parent.value.properties?.length ?? 0) === 0;
}

function writeAtomicOrRemoveEmpty(file: string, root: Node, text: string): void {
  const entry = lstatIfPresent(file);
  if (isOnlyEmptyMcpParent(root) && !entry?.isSymbolicLink()) {
    if (entry) unlinkSync(file);
    return;
  }
  writeTextAtomic(file, text);
}

export function writeJsonAtomicOrRemoveEmpty(file: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeAtomicOrRemoveEmpty(file, parse(text), text);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function apply(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function lineIndent(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  return text.slice(lineStart, position).match(/^[ \t]*/)?.[0] ?? '';
}

function formatted(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function insertProperty(text: string, object: Node, key: string, value: unknown): string {
  const close = object.end - 1;
  const anchor = object.contentEnd ?? close;
  const keyIndent = object.properties?.[0]
    ? lineIndent(text, object.properties[0].keyStart)
    : lineIndent(text, object.start) + '  ';
  const objectIndent = lineIndent(text, object.start);
  const separator = object.properties?.length && !object.trailingComma ? ',' : '';
  const closing = text.slice(anchor, close).includes('\n') ? '' : `\n${objectIndent}`;
  const insertion = `${separator}\n${keyIndent}"${key}": ${formatted(value, keyIndent)}${closing}`;
  return apply(text, anchor, anchor, insertion);
}

function merge(file: string, parentKey: string, entry: JsonObject, preserveKeys: string[]): void {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
  if (text.trim() === '') text = '{}';
  const root = parse(text);
  if (!isObject(root.value)) throw new Error('root is not an object');

  const parent = root.properties?.find(property => property.key === parentKey);
  if (!parent) {
    writeFileSync(file, insertProperty(text, root, parentKey, { 'recall-memory': entry }));
    return;
  }
  if (!isObject(parent.value.value)) throw new Error(`"${parentKey}" exists but is not an object`);

  const container = parent.value;
  const current = container.properties?.find(property => property.key === 'recall-memory');
  const previous = current && isObject(current.value.value) ? current.value.value : {};
  const merged: JsonObject = { ...previous, ...entry };
  for (const key of ['environment', 'env']) {
    if (isObject(entry[key])) merged[key] = { ...(isObject(previous[key]) ? previous[key] : {}), ...entry[key] };
  }
  for (const key of preserveKeys) {
    if (Object.prototype.hasOwnProperty.call(previous, key)) merged[key] = previous[key];
  }

  if (current) {
    const indent = lineIndent(text, current.value.start);
    writeFileSync(file, apply(text, current.value.start, current.value.end, formatted(merged, indent)));
  } else {
    writeFileSync(file, insertProperty(text, container, 'recall-memory', merged));
  }
}

function remove(file: string, parentKey: string): void {
  const original = readFileSync(file, 'utf8');
  const text = original.trim() === '' ? '{}' : original;
  const root = parse(text);
  if (!isObject(root.value)) throw new Error('root is not an object');
  const parent = root.properties?.find(property => property.key === parentKey);
  if (!parent) return;
  if (!isObject(parent.value.value)) throw new Error(`"${parentKey}" exists but is not an object`);
  const properties = parent.value.properties ?? [];
  const currentIndex = properties.findIndex(property => property.key === 'recall-memory');
  if (currentIndex < 0) return;
  const current = properties[currentIndex];
  let updated: string;
  if (properties.length === 1) {
    const end = parent.value.trailingComma ? parent.value.contentEnd ?? current.value.end : current.value.end;
    updated = apply(text, current.keyStart, end, '');
  } else if (currentIndex < properties.length - 1) {
    updated = apply(text, current.keyStart, properties[currentIndex + 1].keyStart, '');
  } else {
    updated = apply(text, properties[currentIndex - 1].value.end, current.value.end, '');
  }
  const parsed = parse(updated);
  writeAtomicOrRemoveEmpty(file, parsed, updated);
}

if (process.argv[1]?.endsWith('jsonc-mcp.ts') || process.argv[1]?.endsWith('jsonc-mcp.js')) {
  try {
    const [, , action, file, parentKey, entryJson, preserveCsv] = process.argv;
    if (action === 'merge') {
      const entry = JSON.parse(entryJson) as JsonObject;
      merge(file, parentKey, entry, (preserveCsv ?? '').split(',').filter(Boolean));
    } else if (action === 'remove') {
      remove(file, parentKey);
    } else {
      throw new Error('usage: jsonc-mcp.ts merge|remove ...');
    }
  } catch (error) {
    console.error(`recall: JSONC operation failed — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
