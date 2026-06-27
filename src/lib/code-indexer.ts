import type { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { basename, dirname, extname, isAbsolute, posix as posixPath, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { Parser, Language, type Node } from 'web-tree-sitter';
import { detectProject } from './project.js';

const require = createRequire(import.meta.url);
const INDEX_EXCLUDED_DIRS: Record<string, true> = { '.git': true, node_modules: true, dist: true, '.worktrees': true };

type LanguageKind = 'typescript' | 'tsx';

type CodeNodeKind = 'module' | 'function' | 'class' | 'method';
type EdgeKind = 'imports' | 'structural' | 'calls' | 'inheritance';
type Provenance = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

interface ExtractedNode {
  nodeId: string;
  kind: CodeNodeKind;
  name: string;
  qualifiedName: string;
  signature: string | null;
  isExported: boolean;
  language: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  startIndex: number;
  endIndex: number;
}

interface PendingEdge {
  srcNodeId: string;
  dstHint: string | null;
  kind: EdgeKind;
  provenance?: Provenance;
  line: number;
  col: number;
  metadata?: Record<string, unknown>;
  importSourcePath?: string;
}

interface ImportBinding {
  local: string;
  imported: string;
  sourcePath: string;
}

interface FileExtraction {
  absPath: string;
  relPath: string;
  language: string;
  content: string;
  contentHash: string;
  sizeBytes: number;
  parseError: string | null;
  nodes: ExtractedNode[];
  edges: PendingEdge[];
  imports: ImportBinding[];
}

interface DbNode {
  id: number;
  project: string;
  node_id: string;
  kind: string;
  qualified_name: string;
  name: string;
  path: string;
}

export interface IndexCodeOptions {
  db: Database;
  root: string;
  target?: string;
  project?: string;
  changedOnly?: boolean;
}

export interface IndexCodeResult {
  project: string;
  root: string;
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  nodesInserted: number;
  edgesInserted: number;
  edgesRelinked: number;
}

interface ParserCache {
  ready: boolean;
  typescript?: Language;
  tsx?: Language;
}

const parserCache: ParserCache = { ready: false };

function resolvePackageFile(specifier: string): string {
  const resolved = import.meta.resolve(specifier);
  if (resolved.startsWith('file:')) return fileURLToPath(resolved);
  if (isAbsolute(resolved)) return resolved;
  return require.resolve(specifier);
}

async function ensureParserReady(): Promise<void> {
  if (parserCache.ready) return;
  const parserWasm = resolvePackageFile('web-tree-sitter/web-tree-sitter.wasm');
  await Parser.init({ locateFile: () => parserWasm });
  parserCache.typescript = await Language.load(resolvePackageFile('tree-sitter-typescript/tree-sitter-typescript.wasm'));
  parserCache.tsx = await Language.load(resolvePackageFile('tree-sitter-typescript/tree-sitter-tsx.wasm'));
  parserCache.ready = true;
}

function languageForPath(path: string): LanguageKind | null {
  const ext = extname(path);
  if (ext === '.ts' || ext === '.js') return 'typescript';
  if (ext === '.tsx' || ext === '.jsx') return 'tsx';
  return null;
}

function repoRootFor(target: string): string {
  const abs = resolve(target);
  const cwd = statSync(abs).isDirectory() ? abs : dirname(abs);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function repoRelative(root: string, absPath: string): string | null {
  const rel = toPosixPath(relative(root, absPath));
  if (rel === '.' || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return null;
  return rel;
}

function collectSourceFiles(root: string, target: string): string[] {
  const absTarget = resolve(target);
  const rel = repoRelative(root, absTarget);
  if (rel === null) return [];
  const stat = lstatSync(absTarget);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return languageForPath(absTarget) && !absTarget.endsWith('.d.ts') ? [absTarget] : [];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name);
      if (!repoRelative(root, abs)) continue;
      if (entry.isDirectory()) {
        if (!INDEX_EXCLUDED_DIRS[entry.name]) walk(abs);
        continue;
      }
      if (entry.isFile() && languageForPath(abs) && !abs.endsWith('.d.ts')) files.push(abs);
    }
  };
  walk(absTarget);
  files.sort((a, b) => repoRelative(root, a)!.localeCompare(repoRelative(root, b)!));
  return files;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function pointLine(point: { row: number }): number {
  return point.row + 1;
}

function pointCol(point: { column: number }): number {
  return point.column;
}

function stableNodeId(kind: CodeNodeKind, relPath: string, qualifiedName: string, node: Node): string {
  return `${kind}:${relPath}:${qualifiedName}:${pointLine(node.startPosition)}:${pointCol(node.startPosition)}`;
}

function moduleNodeId(relPath: string): string {
  return `module:${relPath}:${relPath}:1:0`;
}

function moduleNode(relPath: string, language: string, content: string): ExtractedNode {
  return {
    nodeId: moduleNodeId(relPath),
    kind: 'module',
    name: basename(relPath),
    qualifiedName: relPath,
    signature: null,
    isExported: true,
    language,
    startLine: 1,
    startCol: 0,
    endLine: content.split('\n').length,
    endCol: 0,
    startIndex: 0,
    endIndex: content.length,
  };
}

function childText(node: Node, field: string): string | null {
  return node.childForFieldName(field)?.text ?? null;
}

function namedChildOfType(node: Node, type: string): Node | null {
  return node.namedChildren.find((child) => child.type === type) ?? null;
}

function isExported(node: Node): boolean {
  let cur: Node | null = node;
  while (cur?.parent) {
    if (cur.parent.type === 'export_statement') return true;
    if (cur.parent.type === 'program') return false;
    cur = cur.parent;
  }
  return false;
}

function nearestClassName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return childText(cur, 'name');
    cur = cur.parent;
  }
  return null;
}

function signatureFor(node: Node): string | null {
  if (node.type === 'function_declaration' || node.type === 'method_definition') {
    return node.childForFieldName('parameters')?.text ?? null;
  }
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    const params = node.childForFieldName('parameters') ?? node.namedChildren[0];
    return params?.text ?? null;
  }
  return null;
}

function declarationNode(kind: CodeNodeKind, relPath: string, language: string, node: Node, name: string, qualifiedName: string, exportedNode: Node = node): ExtractedNode {
  return {
    nodeId: stableNodeId(kind, relPath, qualifiedName, node),
    kind,
    name,
    qualifiedName,
    signature: signatureFor(node),
    isExported: isExported(exportedNode),
    language,
    startLine: pointLine(node.startPosition),
    startCol: pointCol(node.startPosition),
    endLine: pointLine(node.endPosition),
    endCol: pointCol(node.endPosition),
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  };
}

function anonymousCallbackName(call: Node, fn: Node): string {
  const callee = call.childForFieldName('function');
  const calleeName = callee ? calleeReference(callee)?.hint ?? 'callback' : 'callback';
  return `${calleeName}.callback@${pointLine(fn.startPosition)}:${pointCol(fn.startPosition)}`;
}

function extractDeclarations(root: Node, relPath: string, language: string, content: string): ExtractedNode[] {
  const nodes: ExtractedNode[] = [moduleNode(relPath, language, content)];
  const visit = (node: Node) => {
    if (node.type === 'function_declaration') {
      const name = childText(node, 'name');
      if (name) nodes.push(declarationNode('function', relPath, language, node, name, name));
    } else if (node.type === 'class_declaration') {
      const name = childText(node, 'name');
      if (name) nodes.push(declarationNode('class', relPath, language, node, name, name));
    } else if (node.type === 'method_definition') {
      const name = childText(node, 'name') ?? namedChildOfType(node, 'property_identifier')?.text;
      const cls = nearestClassName(node);
      if (name && cls) nodes.push(declarationNode('method', relPath, language, node, name, `${cls}.${name}`));
    } else if (node.type === 'variable_declarator') {
      const name = childText(node, 'name');
      const value = node.childForFieldName('value');
      if (name && value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
        nodes.push(declarationNode('function', relPath, language, value, name, name, node.parent ?? node));
      }
    } else if ((node.type === 'arrow_function' || node.type === 'function_expression') && node.parent?.type === 'arguments') {
      const call = node.parent.parent;
      if (call?.type === 'call_expression') {
        const qn = anonymousCallbackName(call, node);
        nodes.push(declarationNode('function', relPath, language, node, 'callback', qn));
      }
    }

    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return nodes;
}

function smallestOwningScope(nodes: ExtractedNode[], startIndex: number): ExtractedNode {
  const candidates = nodes.filter((node) => node.kind !== 'class' && node.startIndex <= startIndex && startIndex < node.endIndex);
  candidates.sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex));
  return candidates[0] ?? nodes[0];
}

function calleeReference(callee: Node): { raw: string; hint: string } | null {
  if (callee.type === 'identifier' || callee.type === 'property_identifier') {
    return { raw: callee.text, hint: callee.text };
  }
  if (callee.type === 'member_expression') {
    const property = callee.childForFieldName('property') ?? callee.lastNamedChild;
    if (!property) return null;
    return { raw: callee.text, hint: property.text };
  }
  if (callee.type === 'subscript_expression') return null;
  if (callee.namedChildCount === 1) return calleeReference(callee.namedChild(0)!);
  return null;
}

function stringLiteralText(node: Node | null): string | null {
  if (!node) return null;
  return node.text.replace(/^['"]|['"]$/g, '');
}

function resolveImportPath(fromRelPath: string, source: string, allRelPaths: Set<string>): string | null {
  if (!source.startsWith('.')) return null;
  const base = posixPath.normalize(posixPath.join(posixPath.dirname(fromRelPath), source));
  const ext = posixPath.extname(base);
  const bases = ext === '.js' || ext === '.jsx' ? [base, base.slice(0, -ext.length)] : [base];
  const candidates = bases.flatMap((candidate) => [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}.jsx`,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`,
    `${candidate}/index.js`,
    `${candidate}/index.jsx`,
  ]);
  return candidates.find((candidate) => allRelPaths.has(candidate)) ?? null;
}

function extractImportBindings(root: Node, relPath: string, allRelPaths: Set<string>): { bindings: ImportBinding[]; edges: PendingEdge[] } {
  const bindings: ImportBinding[] = [];
  const edges: PendingEdge[] = [];
  const visit = (node: Node) => {
    if (node.type === 'import_statement') {
      const source = stringLiteralText(node.childForFieldName('source'));
      const sourcePath = source ? resolveImportPath(relPath, source, allRelPaths) : null;
      if (sourcePath) {
        edges.push({
          srcNodeId: moduleNodeId(relPath),
          dstHint: sourcePath,
          kind: 'imports',
          provenance: 'EXTRACTED',
          line: pointLine(node.startPosition),
          col: pointCol(node.startPosition),
          importSourcePath: sourcePath,
          metadata: { source },
        });

        for (const spec of node.descendantsOfType(['import_specifier', 'namespace_import'])) {
          if (spec.type === 'import_specifier') {
            const imported = childText(spec, 'name') ?? spec.firstNamedChild?.text;
            const local = childText(spec, 'alias') ?? imported;
            if (local && imported) bindings.push({ local, imported, sourcePath });
          } else if (spec.type === 'namespace_import') {
            const local = childText(spec, 'name') ?? spec.lastNamedChild?.text;
            if (local) bindings.push({ local, imported: '*', sourcePath });
          }
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return { bindings, edges };
}

function extractCallEdges(root: Node, nodes: ExtractedNode[]): PendingEdge[] {
  const edges: PendingEdge[] = [];
  const seen = new Set<string>();
  const visit = (node: Node) => {
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const ref = callee ? calleeReference(callee) : null;
      if (ref) {
        const src = smallestOwningScope(nodes, node.startIndex);
        const key = `${src.nodeId}:${ref.hint}:${pointLine(node.startPosition)}:${pointCol(node.startPosition)}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            srcNodeId: src.nodeId,
            dstHint: ref.hint,
            kind: 'calls',
            line: pointLine(node.startPosition),
            col: pointCol(node.startPosition),
            metadata: ref.raw === ref.hint ? undefined : { raw: ref.raw },
          });
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return edges;
}

function extractStructuralEdges(nodes: ExtractedNode[]): PendingEdge[] {
  const module = nodes.find((node) => node.kind === 'module');
  if (!module) return [];
  return nodes
    .filter((node) => node !== module && (node.kind === 'function' || node.kind === 'class'))
    .map((node) => ({
      srcNodeId: module.nodeId,
      dstHint: node.qualifiedName,
      kind: 'structural' as const,
      provenance: 'EXTRACTED' as const,
      line: node.startLine,
      col: node.startCol,
    }));
}

async function extractFile(absPath: string, relPath: string, allRelPaths: Set<string>): Promise<FileExtraction> {
  await ensureParserReady();
  const content = readFileSync(absPath, 'utf8');
  const languageKind = languageForPath(absPath)!;
  const parser = new Parser();
  const language = languageKind === 'tsx' ? parserCache.tsx! : parserCache.typescript!;
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) throw new Error(`tree-sitter failed to parse ${relPath}`);

  try {
    const nodes = extractDeclarations(tree.rootNode, relPath, languageKind, content);
    const imports = extractImportBindings(tree.rootNode, relPath, allRelPaths);
    const edges = [
      ...imports.edges,
      ...extractStructuralEdges(nodes),
      ...extractCallEdges(tree.rootNode, nodes),
    ];
    return {
      absPath,
      relPath,
      language: languageKind,
      content,
      contentHash: contentHash(content),
      sizeBytes: Buffer.byteLength(content),
      parseError: tree.rootNode.hasError ? 'tree-sitter parse contained ERROR nodes' : null,
      nodes,
      edges,
      imports: imports.bindings,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}

function shouldSkipChanged(db: Database, project: string, relPath: string, hash: string): boolean {
  const row = db.prepare('SELECT content_hash FROM code_files WHERE project = ? AND path = ?').get(project, relPath) as { content_hash: string } | undefined;
  return row?.content_hash === hash;
}

function loadDbNodes(db: Database, project: string): DbNode[] {
  return db.prepare(`
    SELECT n.id, n.project, n.node_id, n.kind, n.qualified_name, n.name, f.path
    FROM code_nodes AS n
    JOIN code_files AS f ON f.id = n.file_id
    WHERE n.project = ?
  `).all(project) as DbNode[];
}

function findCandidates(nodes: DbNode[], target: string): DbNode[] {
  const exact = nodes.filter((node) => node.qualified_name === target);
  if (exact.length > 0) return exact;
  return nodes.filter((node) => node.name === target);
}

function buildImportTarget(binding: ImportBinding, nodes: DbNode[]): string | null {
  const inFile = nodes.filter((node) => node.path === binding.sourcePath);
  if (binding.imported === '*') return null;
  const exported = inFile.find((node) => node.name === binding.imported || node.qualified_name === binding.imported);
  return exported?.qualified_name ?? binding.imported;
}

function resolveEdge(edge: PendingEdge, file: FileExtraction, dbNodes: DbNode[]): DbNode[] {
  if (!edge.dstHint) return [];
  if (edge.importSourcePath) {
    return dbNodes.filter((node) => node.path === edge.importSourcePath && node.kind === 'module');
  }
  const binding = file.imports.find((candidate) => candidate.local === edge.dstHint);
  const target = binding ? buildImportTarget(binding, dbNodes) : edge.dstHint;
  if (!target) return [];
  if (!binding) {
    const local = dbNodes.filter((node) => node.path === file.relPath && (node.qualified_name === target || node.name === target));
    if (local.length > 0) return local;
  }
  return findCandidates(dbNodes, target);
}

function insertEdge(db: Database, srcId: number, dstId: number | null, hint: string | null, kind: EdgeKind, provenance: Provenance, line: number, col: number, metadata?: Record<string, unknown>): void {
  db.prepare(`
    INSERT INTO code_edges (src_id, dst_id, dst_hint, kind, provenance, line, col, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(srcId, dstId, hint, kind, provenance, line, col, metadata ? JSON.stringify(metadata) : null);
}

function persistFiles(db: Database, project: string, files: FileExtraction[]): { nodesInserted: number; edgesInserted: number } {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const file of files) {
      db.prepare('DELETE FROM code_files WHERE project = ? AND path = ?').run(project, file.relPath);
      const fileResult = db.prepare(`
        INSERT INTO code_files (project, path, language, content_hash, size_bytes, node_count, parse_error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(project, file.relPath, file.language, file.contentHash, file.sizeBytes, file.nodes.length, file.parseError);
      const fileId = Number(fileResult.lastInsertRowid);

      const insertNode = db.prepare(`
        INSERT INTO code_nodes (project, file_id, node_id, kind, name, qualified_name, signature, is_exported, language, start_line, start_col, end_line, end_col)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const node of file.nodes) {
        insertNode.run(
          project,
          fileId,
          node.nodeId,
          node.kind,
          node.name,
          node.qualifiedName,
          node.signature,
          node.isExported ? 1 : 0,
          node.language,
          node.startLine,
          node.startCol,
          node.endLine,
          node.endCol,
        );
      }
    }

    const dbNodes = loadDbNodes(db, project);
    const nodeIdToRowId = new Map(dbNodes.map((node) => [node.node_id, node.id]));
    let edgeCount = 0;
    for (const file of files) {
      for (const edge of file.edges) {
        const srcId = nodeIdToRowId.get(edge.srcNodeId);
        if (!srcId) continue;
        const candidates = resolveEdge(edge, file, dbNodes);
        if (candidates.length === 1) {
          insertEdge(db, srcId, candidates[0].id, edge.dstHint, edge.kind, edge.provenance ?? 'EXTRACTED', edge.line, edge.col, edge.metadata);
          edgeCount++;
        } else if (candidates.length > 1) {
          for (const candidate of candidates) {
            insertEdge(db, srcId, candidate.id, edge.dstHint, edge.kind, 'AMBIGUOUS', edge.line, edge.col, edge.metadata);
            edgeCount++;
          }
        } else {
          insertEdge(db, srcId, null, edge.dstHint, edge.kind, edge.provenance ?? 'INFERRED', edge.line, edge.col, edge.metadata);
          edgeCount++;
        }
      }
    }

    db.exec('COMMIT');
    return { nodesInserted: files.reduce((sum, file) => sum + file.nodes.length, 0), edgesInserted: edgeCount };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function relinkEdges(db: Database, project: string): number {
  const dbNodes = loadDbNodes(db, project);
  const unresolved = db.prepare(`
    SELECT e.id, e.dst_hint
    FROM code_edges AS e
    JOIN code_nodes AS src ON src.id = e.src_id
    WHERE src.project = ? AND e.dst_id IS NULL AND e.dst_hint IS NOT NULL
  `).all(project) as Array<{ id: number; dst_hint: string }>;

  let linked = 0;
  const update = db.prepare("UPDATE code_edges SET dst_id = ?, provenance = 'EXTRACTED' WHERE id = ?");
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const edge of unresolved) {
      const candidates = findCandidates(dbNodes, edge.dst_hint);
      if (candidates.length === 1) {
        update.run(candidates[0].id, edge.id);
        linked++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return linked;
}

export async function indexCode(options: IndexCodeOptions): Promise<IndexCodeResult> {
  const target = resolve(options.target ?? options.root);
  const root = repoRootFor(options.root);
  const project = options.project ?? detectProject(root) ?? basename(root);
  const absFiles = collectSourceFiles(root, target);
  const allRelPaths = new Set(absFiles.map((file) => repoRelative(root, file)).filter((path): path is string => !!path));

  const extracted: FileExtraction[] = [];
  let skipped = 0;
  for (const absPath of absFiles) {
    const relPath = repoRelative(root, absPath);
    if (!relPath) continue;
    const file = await extractFile(absPath, relPath, allRelPaths);
    if (options.changedOnly && shouldSkipChanged(options.db, project, relPath, file.contentHash)) {
      skipped++;
      continue;
    }
    extracted.push(file);
  }

  const persisted = persistFiles(options.db, project, extracted);
  const relinked = relinkEdges(options.db, project);
  return {
    project,
    root,
    filesSeen: absFiles.length,
    filesIndexed: extracted.length,
    filesSkipped: skipped,
    nodesInserted: persisted.nodesInserted,
    edgesInserted: persisted.edgesInserted,
    edgesRelinked: relinked,
  };
}
