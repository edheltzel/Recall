#!/usr/bin/env bun

// Small, dependency-free JSONC editor for the lifecycle scripts. The published
// Recall package ships lib/ but not node_modules/, so installer/uninstaller
// config repair cannot require the repository's jsonc-parser installation.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { isJsonObject, parseJsonc, type JsonObject, type JsoncNode } from '../hooks/lib/jsonc.js';

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

function insertProperty(text: string, object: JsoncNode, key: string, value: unknown): string {
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
  const root = parseJsonc(text);
  if (!isJsonObject(root.value)) throw new Error('root is not an object');

  const parent = root.properties?.find(property => property.key === parentKey);
  if (!parent) {
    writeFileSync(file, insertProperty(text, root, parentKey, { 'recall-memory': entry }));
    return;
  }
  if (!isJsonObject(parent.value.value)) throw new Error(`"${parentKey}" exists but is not an object`);

  const container = parent.value;
  const current = container.properties?.find(property => property.key === 'recall-memory');
  const previous = current && isJsonObject(current.value.value) ? current.value.value : {};
  const merged: JsonObject = { ...previous, ...entry };
  for (const key of ['environment', 'env']) {
    if (isJsonObject(entry[key])) merged[key] = { ...(isJsonObject(previous[key]) ? previous[key] : {}), ...entry[key] };
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
  const root = parseJsonc(text);
  if (!isJsonObject(root.value)) throw new Error('root is not an object');
  const parent = root.properties?.find(property => property.key === parentKey);
  if (!parent) return;
  if (!isJsonObject(parent.value.value)) throw new Error(`"${parentKey}" exists but is not an object`);
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
