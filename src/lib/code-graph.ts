import type { Database } from 'bun:sqlite';

export const CODE_GRAPH_SCHEMA_VERSION = 16;

const CODE_GRAPH_TABLES = ['code_files', 'code_nodes', 'code_edges'] as const;

type VersionRow = { user_version: number };
type TableRow = { name: string };

type NodeRow = {
  id: number;
  project: string;
  node_id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  path: string;
  start_line: number | null;
  start_col: number | null;
};

type EdgeRow = {
  edge_id: number;
  dst_hint: string | null;
  provenance: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  line: number | null;
  col: number | null;
  src_id: number;
  src_project: string;
  src_node_id: string;
  src_kind: string;
  src_name: string;
  src_qualified_name: string | null;
  src_path: string;
  src_start_line: number | null;
  src_start_col: number | null;
  dst_id: number | null;
  dst_project: string | null;
  dst_node_id: string | null;
  dst_kind: string | null;
  dst_name: string | null;
  dst_qualified_name: string | null;
  dst_path: string | null;
  dst_start_line: number | null;
  dst_start_col: number | null;
};

type OutgoingTraceRow = {
  edge_id: number;
  dst_id: number | null;
  dst_hint: string | null;
  provenance: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  line: number | null;
  col: number | null;
};

export type CodeGraphCapability =
  | { ok: true; version: number }
  | { ok: false; version: number; message: string };

export interface CodeNodeRef {
  id: number;
  project: string;
  nodeId: string;
  kind: string;
  name: string;
  qualifiedName: string;
  path: string;
  startLine: number | null;
  startCol: number | null;
}

export interface CodeCallEdge {
  id: number;
  src: CodeNodeRef;
  dst: CodeNodeRef | null;
  dstHint: string | null;
  provenance: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  resolved: boolean;
  line: number | null;
  col: number | null;
}

export interface CodeGraphLookupResult {
  symbol: string;
  project: string;
  matches: CodeNodeRef[];
}

export interface CodeGraphCallersResult extends CodeGraphLookupResult {
  callers: CodeCallEdge[];
  unresolvedCandidates: CodeCallEdge[];
}

export interface CodeGraphCalleesResult extends CodeGraphLookupResult {
  callees: CodeCallEdge[];
}

export interface CodeGraphTraceResult {
  project: string;
  from: CodeNodeRef | null;
  to: CodeNodeRef | null;
  fromCandidates: CodeNodeRef[];
  toCandidates: CodeNodeRef[];
  path: CodeCallEdge[];
  unresolvedEncountered: CodeCallEdge[];
  maxDepth: number;
}

function version(db: Database): number {
  const row = db.prepare<VersionRow, []>('PRAGMA user_version').get();
  return row?.user_version ?? 0;
}

function tableExists(db: Database, table: string): boolean {
  const row = db.prepare<TableRow, [string]>(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
  ).get(table);
  return row?.name === table;
}

export function codeGraphCapability(db: Database): CodeGraphCapability {
  const currentVersion = version(db);
  if (currentVersion < CODE_GRAPH_SCHEMA_VERSION) {
    return {
      ok: false,
      version: currentVersion,
      message: `Native code graph schema is not installed yet (database schema v${currentVersion}; need v${CODE_GRAPH_SCHEMA_VERSION}). Run 'recall init' to migrate the database, then retry.`,
    };
  }

  const missing = CODE_GRAPH_TABLES.filter((table) => !tableExists(db, table));
  if (missing.length > 0) {
    return {
      ok: false,
      version: currentVersion,
      message: `Native code graph tables are missing (${missing.join(', ')}). Run 'recall init' to repair the schema, then retry.`,
    };
  }

  return { ok: true, version: currentVersion };
}

export function assertCodeGraphCapability(db: Database): void {
  const capability = codeGraphCapability(db);
  if (!capability.ok) throw new Error(capability.message);
}

function nodeRef(row: NodeRow): CodeNodeRef {
  return {
    id: row.id,
    project: row.project,
    nodeId: row.node_id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name ?? row.name,
    path: row.path,
    startLine: row.start_line,
    startCol: row.start_col,
  };
}

function edgeRef(row: EdgeRow): CodeCallEdge {
  const src = nodeRef({
    id: row.src_id,
    project: row.src_project,
    node_id: row.src_node_id,
    kind: row.src_kind,
    name: row.src_name,
    qualified_name: row.src_qualified_name,
    path: row.src_path,
    start_line: row.src_start_line,
    start_col: row.src_start_col,
  });

  const dst = row.dst_id === null ? null : nodeRef({
    id: row.dst_id,
    project: row.dst_project ?? row.src_project,
    node_id: row.dst_node_id ?? '',
    kind: row.dst_kind ?? 'unknown',
    name: row.dst_name ?? row.dst_hint ?? '<unknown>',
    qualified_name: row.dst_qualified_name,
    path: row.dst_path ?? '',
    start_line: row.dst_start_line,
    start_col: row.dst_start_col,
  });

  return {
    id: row.edge_id,
    src,
    dst,
    dstHint: row.dst_hint,
    provenance: row.provenance,
    resolved: row.dst_id !== null,
    line: row.line,
    col: row.col,
  };
}

const NODE_SELECT = `
  SELECT n.id, n.project, n.node_id, n.kind, n.name, n.qualified_name, f.path, n.start_line, n.start_col
  FROM code_nodes AS n
  JOIN code_files AS f ON f.id = n.file_id
`;

const EDGE_SELECT = `
  SELECT
    e.id AS edge_id, e.dst_hint, e.provenance, e.line, e.col,
    src.id AS src_id, src.project AS src_project, src.node_id AS src_node_id, src.kind AS src_kind,
    src.name AS src_name, src.qualified_name AS src_qualified_name, src_file.path AS src_path,
    src.start_line AS src_start_line, src.start_col AS src_start_col,
    dst.id AS dst_id, dst.project AS dst_project, dst.node_id AS dst_node_id, dst.kind AS dst_kind,
    dst.name AS dst_name, dst.qualified_name AS dst_qualified_name, dst_file.path AS dst_path,
    dst.start_line AS dst_start_line, dst.start_col AS dst_start_col
  FROM code_edges AS e
  JOIN code_nodes AS src ON src.id = e.src_id
  JOIN code_files AS src_file ON src_file.id = src.file_id
  LEFT JOIN code_nodes AS dst ON dst.id = e.dst_id
  LEFT JOIN code_files AS dst_file ON dst_file.id = dst.file_id
`;


export function findCodeSymbols(db: Database, project: string, symbol: string): CodeNodeRef[] {
  assertCodeGraphCapability(db);
  const exact = db.prepare<NodeRow, [string, string, string]>(`
    ${NODE_SELECT}
    WHERE n.project = ? AND (n.qualified_name = ? OR n.node_id = ?)
    ORDER BY f.path, n.start_line, n.start_col, n.id
  `).all(project, symbol, symbol).map(nodeRef);
  if (exact.length > 0) return exact;

  return db.prepare<NodeRow, [string, string]>(`
    ${NODE_SELECT}
    WHERE n.project = ? AND n.name = ?
    ORDER BY f.path, n.start_line, n.start_col, n.id
  `).all(project, symbol).map(nodeRef);
}

function callerEdgesForTarget(db: Database, targetId: number): CodeCallEdge[] {
  return db.prepare<EdgeRow, [number]>(`
    ${EDGE_SELECT}
    WHERE e.kind = 'calls' AND e.dst_id = ?
    ORDER BY src_file.path, e.line, e.col, e.id
  `).all(targetId).map(edgeRef);
}

function unresolvedEdgesForHint(db: Database, project: string, hint: string): CodeCallEdge[] {
  return db.prepare<EdgeRow, [string, string]>(`
    ${EDGE_SELECT}
    WHERE src.project = ? AND e.kind = 'calls' AND e.dst_id IS NULL AND e.dst_hint = ?
    ORDER BY src_file.path, e.line, e.col, e.id
  `).all(project, hint).map(edgeRef);
}

function calleeEdgesForSource(db: Database, sourceId: number): CodeCallEdge[] {
  return db.prepare<EdgeRow, [number]>(`
    ${EDGE_SELECT}
    WHERE e.kind = 'calls' AND e.src_id = ?
    ORDER BY e.line, e.col, e.id
  `).all(sourceId).map(edgeRef);
}

function dedupeEdges(edges: CodeCallEdge[]): CodeCallEdge[] {
  const seen = new Set<number>();
  const deduped: CodeCallEdge[] = [];
  for (const edge of edges) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    deduped.push(edge);
  }
  return deduped;
}

export function callers(db: Database, project: string, symbol: string): CodeGraphCallersResult {
  const matches = findCodeSymbols(db, project, symbol);
  const callerEdges = matches.flatMap((match) => callerEdgesForTarget(db, match.id));
  const hints = new Set<string>([symbol]);
  for (const match of matches) {
    hints.add(match.name);
    hints.add(match.qualifiedName);
  }
  const unresolved = [...hints].flatMap((hint) => unresolvedEdgesForHint(db, project, hint));
  return { symbol, project, matches, callers: dedupeEdges(callerEdges), unresolvedCandidates: dedupeEdges(unresolved) };
}

export function callees(db: Database, project: string, symbol: string): CodeGraphCalleesResult {
  const matches = findCodeSymbols(db, project, symbol);
  const edges = matches.flatMap((match) => calleeEdgesForSource(db, match.id));
  return { symbol, project, matches, callees: dedupeEdges(edges) };
}

function uniqueSymbol(candidates: CodeNodeRef[]): CodeNodeRef | null {
  return candidates.length === 1 ? candidates[0] : null;
}

function traceEdge(db: Database, edgeId: number): CodeCallEdge | null {
  const row = db.prepare<EdgeRow, [number]>(`${EDGE_SELECT} WHERE e.id = ?`).get(edgeId);
  return row ? edgeRef(row) : null;
}

function outgoingTraceEdges(db: Database, sourceId: number): OutgoingTraceRow[] {
  return db.prepare<OutgoingTraceRow, [number]>(`
    SELECT e.id AS edge_id, e.dst_id, e.dst_hint, e.provenance, e.line, e.col
    FROM code_edges AS e
    WHERE e.kind = 'calls' AND e.src_id = ?
    ORDER BY e.line, e.col, e.id
  `).all(sourceId);
}

export function trace(db: Database, project: string, fromSymbol: string, toSymbol: string, maxDepth = 5): CodeGraphTraceResult {
  assertCodeGraphCapability(db);
  const fromCandidates = findCodeSymbols(db, project, fromSymbol);
  const toCandidates = findCodeSymbols(db, project, toSymbol);
  const from = uniqueSymbol(fromCandidates);
  const to = uniqueSymbol(toCandidates);
  const base = { project, from, to, fromCandidates, toCandidates, maxDepth };
  if (!from || !to) return { ...base, path: [], unresolvedEncountered: [] };
  if (from.id === to.id) return { ...base, path: [], unresolvedEncountered: [] };

  const queue: Array<{ nodeId: number; edgeIds: number[]; depth: number }> = [{ nodeId: from.id, edgeIds: [], depth: 0 }];
  const visited = new Set<number>([from.id]);
  const unresolvedById = new Map<number, CodeCallEdge>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;

    for (const edge of outgoingTraceEdges(db, current.nodeId)) {
      if (edge.dst_id === null) {
        const unresolved = traceEdge(db, edge.edge_id);
        if (unresolved) unresolvedById.set(unresolved.id, unresolved);
        continue;
      }

      const nextPath = [...current.edgeIds, edge.edge_id];
      if (edge.dst_id === to.id) {
        const pathEdges = nextPath.map((id) => traceEdge(db, id)).filter((value): value is CodeCallEdge => value !== null);
        return { ...base, path: pathEdges, unresolvedEncountered: [...unresolvedById.values()] };
      }
      if (visited.has(edge.dst_id)) continue;
      visited.add(edge.dst_id);
      queue.push({ nodeId: edge.dst_id, edgeIds: nextPath, depth: current.depth + 1 });
    }
  }

  return { ...base, path: [], unresolvedEncountered: [...unresolvedById.values()] };
}
