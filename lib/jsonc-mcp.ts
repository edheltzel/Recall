#!/usr/bin/env bun

// Small, dependency-free JSONC editor for the lifecycle scripts. The published
// Recall package ships lib/ but not node_modules/, so installer/uninstaller
// config repair cannot require the repository's jsonc-parser installation.

import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';

type JsonObject = Record<string, unknown>;
type Property = { key: string; keyStart: number; value: Node };
type Node = {
  start: number;
  end: number;
  value: unknown;
  properties?: Property[];
  contentEnd?: number;
  trailingComma?: boolean;
};

class JsoncParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): Node {
    this.skipSpaceAndComments();
    const root = this.value();
    this.skipSpaceAndComments();
    if (this.index !== this.text.length) throw new Error('trailing content');
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
        const end = this.text.indexOf('\n', this.index + 2);
        this.index = end < 0 ? this.text.length : end + 1;
        continue;
      }
      if (this.text.startsWith('/*', this.index)) {
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

export function validateClaudeConfigShape(config: unknown): asserts config is JsonObject {
  if (!isObject(config)) throw new Error('root is not an object');
  if (config.hooks !== undefined) {
    if (!isObject(config.hooks)) throw new Error('hooks is not an object');
    for (const [event, entries] of Object.entries(config.hooks)) {
      if (!Array.isArray(entries)) throw new Error(`hooks.${event} is not an array`);
    }
  }
  if (config.mcpServers !== undefined) {
    if (!isObject(config.mcpServers)) throw new Error('mcpServers is not an object');
    const recallEntry = config.mcpServers['recall-memory'];
    if (recallEntry !== undefined && !isObject(recallEntry)) {
      throw new Error('mcpServers.recall-memory is not an object');
    }
  }
}

function writeTextAtomic(file: string, text: string): void {
  const target = existsSync(file) && lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
  const tmp = `${target}.tmp`;
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : undefined;
  try {
    if (mode !== undefined && existsSync(tmp)) chmodSync(tmp, mode);
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function isSemanticallyEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSemanticallyEmpty);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isSemanticallyEmpty);
  }
  return false;
}

function writeAtomicOrRemoveEmpty(file: string, value: unknown, text: string): void {
  if (isSemanticallyEmpty(value) && !lstatSync(file).isSymbolicLink()) {
    unlinkSync(file);
    return;
  }
  writeTextAtomic(file, text);
}

export function writeJsonAtomicOrRemoveEmpty(file: string, value: unknown): void {
  writeAtomicOrRemoveEmpty(file, value, `${JSON.stringify(value, null, 2)}\n`);
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
  writeAtomicOrRemoveEmpty(file, parsed.value, updated);
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
