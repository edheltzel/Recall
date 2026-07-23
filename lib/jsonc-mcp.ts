#!/usr/bin/env bun

// Small, dependency-free JSONC editor for the lifecycle scripts. The published
// Recall package ships lib/ but not node_modules/, so installer/uninstaller
// config repair cannot require the repository's jsonc-parser installation.

import { existsSync, readFileSync, writeFileSync } from 'fs';

type JsonObject = Record<string, unknown>;
type Property = { key: string; keyStart: number; value: Node };
type Node = {
  start: number;
  end: number;
  value: unknown;
  properties?: Property[];
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
    const value: JsonObject = {};
    this.skipSpaceAndComments();
    while (this.text[this.index] !== '}') {
      const keyNode = this.string();
      this.skipSpaceAndComments();
      if (this.text[this.index++] !== ':') throw new Error(`expected colon at ${this.index}`);
      const child = this.value();
      properties.push({ key: keyNode.value as string, keyStart: keyNode.start, value: child });
      value[keyNode.value as string] = child.value;
      this.skipSpaceAndComments();
      if (this.text[this.index] === ',') {
        this.index++;
        this.skipSpaceAndComments();
        continue;
      }
      if (this.text[this.index] !== '}') throw new Error(`expected comma at ${this.index}`);
    }
    this.index++;
    return { start, end: this.index, value, properties };
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
  const beforeClose = text.slice(object.start + 1, close);
  const lastSignificant = beforeClose.replace(/(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/g, '').slice(-1);
  const keyIndent = object.properties?.[0]
    ? lineIndent(text, object.properties[0].keyStart)
    : lineIndent(text, object.start) + '  ';
  const objectIndent = lineIndent(text, object.start);
  const separator = object.properties?.length && lastSignificant !== ',' ? ',' : '';
  const insertion = `${separator}\n${keyIndent}"${key}": ${formatted(value, keyIndent)}\n${objectIndent}`;
  return apply(text, close, close, insertion);
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
  const text = readFileSync(file, 'utf8');
  const root = parse(text);
  if (!isObject(root.value)) throw new Error('root is not an object');
  const parent = root.properties?.find(property => property.key === parentKey);
  if (!parent) return;
  if (!isObject(parent.value.value)) throw new Error(`"${parentKey}" exists but is not an object`);
  const properties = parent.value.properties ?? [];
  const currentIndex = properties.findIndex(property => property.key === 'recall-memory');
  if (currentIndex < 0) return;
  const current = properties[currentIndex];
  if (properties.length === 1) {
    writeFileSync(file, apply(text, current.keyStart, current.value.end, ''));
    return;
  }
  if (currentIndex < properties.length - 1) {
    writeFileSync(file, apply(text, current.keyStart, properties[currentIndex + 1].keyStart, ''));
  } else {
    writeFileSync(file, apply(text, properties[currentIndex - 1].value.end, current.value.end, ''));
  }
}

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
