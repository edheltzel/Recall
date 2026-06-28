import { basename } from 'path';
import { getDb } from '../db/connection.js';
import { callers, callees, trace, codeGraphCapability } from '../lib/code-graph.js';
import type { CodeCallEdge, CodeNodeRef } from '../lib/code-graph.js';
import { detectProject } from '../lib/project.js';

interface GraphOptions {
  project?: string;
  depth?: string;
}

function activeProject(options: GraphOptions): string {
  return options.project ?? detectProject(process.cwd()) ?? basename(process.cwd());
}

function location(node: CodeNodeRef): string {
  return `${node.path}:${node.startLine ?? 0}`;
}

function nodeLabel(node: CodeNodeRef): string {
  return `${node.qualifiedName} (${location(node)})`;
}

function edgeTarget(edge: CodeCallEdge): string {
  return edge.dst ? edge.dst.qualifiedName : `<${edge.dstHint ?? 'unresolved'}>`;
}

function edgeLine(edge: CodeCallEdge): string {
  const status = `${edge.provenance}/${edge.resolved ? 'resolved' : 'unresolved'}`;
  return `${edge.src.path}:${edge.line ?? 0} ${edge.src.qualifiedName} -> ${edgeTarget(edge)} [${status}]`;
}

function ensureGraphReady(): boolean {
  const capability = codeGraphCapability(getDb());
  if (capability.ok) return true;
  console.error(capability.message);
  process.exitCode = 1;
  return false;
}

function printMatches(matches: CodeNodeRef[]): void {
  if (matches.length <= 1) return;
  console.log(`Matched ${matches.length} symbols:`);
  for (const match of matches) console.log(`  ${nodeLabel(match)}`);
}

export function runCallers(symbol: string, options: GraphOptions): void {
  if (!ensureGraphReady()) return;
  const project = activeProject(options);
  const result = callers(getDb(), project, symbol);
  if (result.matches.length === 0) {
    console.log(`No code symbol matched ${symbol} in ${project}`);
  } else {
    printMatches(result.matches);
    if (result.callers.length === 0) console.log(`No resolved callers for ${symbol} in ${project}`);
    for (const edge of result.callers) console.log(edgeLine(edge));
  }

  if (result.unresolvedCandidates.length > 0) {
    console.log('Unresolved candidate calls:');
    for (const edge of result.unresolvedCandidates) console.log(edgeLine(edge));
  }
}

export function runCallees(symbol: string, options: GraphOptions): void {
  if (!ensureGraphReady()) return;
  const project = activeProject(options);
  const result = callees(getDb(), project, symbol);
  if (result.matches.length === 0) {
    console.log(`No code symbol matched ${symbol} in ${project}`);
    return;
  }

  printMatches(result.matches);
  if (result.callees.length === 0) console.log(`No callees for ${symbol} in ${project}`);
  for (const edge of result.callees) console.log(edgeLine(edge));
}

export function runTrace(fromSymbol: string, toSymbol: string, options: GraphOptions): void {
  if (!ensureGraphReady()) return;
  const project = activeProject(options);
  const maxDepth = options.depth ? Number.parseInt(options.depth, 10) : 5;
  const result = trace(getDb(), project, fromSymbol, toSymbol, Number.isFinite(maxDepth) ? maxDepth : 5);

  if (!result.from) {
    console.log(result.fromCandidates.length === 0
      ? `No code symbol matched ${fromSymbol} in ${project}`
      : `Ambiguous from symbol ${fromSymbol}: ${result.fromCandidates.map(nodeLabel).join(', ')}`);
    return;
  }
  if (!result.to) {
    console.log(result.toCandidates.length === 0
      ? `No code symbol matched ${toSymbol} in ${project}`
      : `Ambiguous to symbol ${toSymbol}: ${result.toCandidates.map(nodeLabel).join(', ')}`);
    return;
  }

  if (result.from.id === result.to.id) {
    console.log(nodeLabel(result.from));
    return;
  }

  if (result.path.length === 0) {
    console.log(`No resolved call path ${result.from.qualifiedName} -> ${result.to.qualifiedName} within depth ${result.maxDepth}`);
  } else {
    console.log(nodeLabel(result.from));
    for (const edge of result.path) console.log(`  -> ${edgeTarget(edge)} via ${edge.src.path}:${edge.line ?? 0} [${edge.provenance}/resolved]`);
  }

  if (result.unresolvedEncountered.length > 0) {
    console.log('Unresolved calls encountered:');
    for (const edge of result.unresolvedEncountered) console.log(edgeLine(edge));
  }
}
