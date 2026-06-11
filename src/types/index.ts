// Core types for RECALL

// Record Provenance (ADR-0001, CONTEXT.md): the declared origin and
// transformation level of a memory record. Automatic write-path metadata —
// never a public MCP parameter or CLI classification input. Survivor-order
// vocabulary: user_authored > verbatim > extracted > derived. Legacy unknown
// is NULL/absent, never guessed. `derived` is reserved for future paths that
// mechanically produce records from existing memory records.
export const PROVENANCE_VALUES = ['user_authored', 'verbatim', 'extracted', 'derived'] as const;
export type Provenance = typeof PROVENANCE_VALUES[number];

// Tables carrying the provenance column (migration 8→9). Single source of
// truth — consumed by the export renderers and the provenance backfill.
export const PROVENANCE_TABLES = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'] as const;
export type ProvenanceTable = typeof PROVENANCE_TABLES[number];

export interface Session {
  id?: number;
  session_id: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
  project?: string;
  cwd?: string;
  git_branch?: string;
  model?: string;
  source?: string;
}

export interface Message {
  id?: number;
  session_id: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  project?: string;
  importance?: number;
  provenance?: Provenance | null;
}

export interface Decision {
  id?: number;
  created_at?: string;
  session_id?: string;
  category?: string;
  project?: string;
  decision: string;
  reasoning?: string;
  alternatives?: string;
  status: 'active' | 'superseded' | 'reverted';
  confidence?: 'high' | 'medium' | 'low';
  importance?: number;
  provenance?: Provenance | null;
}

export interface Learning {
  id?: number;
  created_at?: string;
  session_id?: string;
  category?: string;
  project?: string;
  problem: string;
  solution?: string;
  prevention?: string;
  tags?: string;
  confidence?: 'high' | 'medium' | 'low';
  importance?: number;
  provenance?: Provenance | null;
}

export interface Breadcrumb {
  id?: number;
  created_at?: string;
  session_id?: string;
  content: string;
  category?: string;
  project?: string;
  importance: number;
  expires_at?: string;
  provenance?: Provenance | null;
}

export interface LoaEntry {
  id?: number;
  created_at?: string;
  title: string;
  description?: string;
  fabric_extract: string;
  message_range_start?: number;
  message_range_end?: number;
  parent_loa_id?: number;
  session_id?: string;
  project?: string;
  tags?: string;
  message_count?: number;
  importance?: number;
  provenance?: Provenance | null;
}

export interface SearchResult {
  table: string;
  id: number;
  content: string;
  project?: string;
  created_at: string;
  rank?: number;
  provenance?: Provenance | null;
}

export interface Stats {
  sessions: number;
  messages: number;
  decisions: number;
  decisions_active: number;
  decisions_superseded: number;
  decisions_reverted: number;
  learnings: number;
  breadcrumbs: number;
  breadcrumbs_expired: number;
  loa_entries: number;
  telos: number;
  documents: number;
  extraction_tracker: number;
  extraction_sessions: number;
  extraction_errors: number;
  embeddings: number;
  db_size_bytes: number;
}

// JSONL import types (Claude Code session format)
export interface ClaudeSessionLine {
  type: 'user' | 'assistant' | 'file-history-snapshot' | string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  uuid?: string;
}
